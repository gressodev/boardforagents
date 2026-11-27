// Outbound HTTP for the agent-ready site checker, hardened against SSRF.
//
// Everything the checker fetches is chosen by an anonymous user, so every request goes through here:
// - URLs: http/https only, ports 80/443 only, no user:password, at most MAX_URL characters.
// - Hosts: "localhost", *.localhost, *.local, *.internal, *.home.arpa, single-label names and cloud metadata
//   names are refused before any lookup. IP literals (in any encoding the URL parser accepts: decimal, octal,
//   hex, short forms, IPv6, IPv4-mapped/compatible IPv6, NAT64) are checked against the reserved ranges below.
// - DNS: we resolve the name ourselves and refuse the request when ANY address is loopback, private,
//   link-local (incl. 169.254.169.254), CGNAT, multicast, reserved, documentation, broadcast or unspecified.
//   The socket then connects to the address we validated (a pinned `lookup`), so a second DNS answer
//   (DNS rebinding) can never redirect the connection. TLS still verifies the certificate for the hostname.
// - Redirects are followed by hand (at most `maxRedirects` hops) and every hop is validated again.
// - Each request has a timeout; a session has a request budget and an overall deadline (AbortSignal).
// - Bodies are streamed and capped (compressed and decompressed); only text-like content types are read.
//
// The transport and the resolver are injectable, so tests never touch the network.
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const dnsPromises = require('node:dns').promises;

const USER_AGENT = 'boardforagents-checker/1.0 (+https://boardforagents.com/check)';
const MAX_URL = 2048;
const DEFAULTS = { timeoutMs: 5000, maxBytes: 256 * 1024, maxRedirects: 3, dnsTimeoutMs: 3000 };

class FetchError extends Error {
  // code: blocked | invalid_url | dns | timeout | network | too_large | too_many_redirects | budget | aborted
  constructor(code, message) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
  }
}
const blocked = (message) => new FetchError('blocked', message);

// ---------- addresses ----------
// [first address, prefix length] in dotted form; the comment says why each range is refused.
const V4_BLOCKED = [
  ['0.0.0.0', 8], // "this network", 0.0.0.0
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. broadcast 255.255.255.255
];

function v4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
  return parts.reduce((n, p) => n * 256 + Number(p), 0);
}
const V4_RANGES = V4_BLOCKED.map(([start, bits]) => {
  const size = 2 ** (32 - bits);
  return { start: v4ToInt(start), size };
});

function isBlockedV4(ip) {
  const n = v4ToInt(ip);
  if (n == null) return true; // not a clean dotted quad: refuse rather than guess
  return V4_RANGES.some((r) => n >= r.start && n < r.start + r.size);
}

// Parses any valid IPv6 text form (incl. "::", embedded dotted IPv4 and a zone id) into 16 bytes, or null.
function v6Bytes(ip) {
  let text = String(ip).replace(/^\[|\]$/g, '').split('%')[0];
  if (!net.isIPv6(text)) return null;
  // A trailing dotted IPv4 ("::ffff:127.0.0.1") becomes two hex groups first.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const n = v4ToInt(tail);
    if (n == null) return null;
    text = `${text.slice(0, lastColon + 1)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const parse = (s) => (s ? s.split(':').map((g) => parseInt(g, 16)) : []);
  const halves = text.split('::');
  if (halves.length > 2) return null;
  let groups = parse(halves[0]);
  if (halves.length === 2) {
    const right = parse(halves[1]);
    groups = [...groups, ...new Array(Math.max(0, 8 - groups.length - right.length)).fill(0), ...right];
  }
  if (groups.length !== 8 || groups.some((g) => !(g >= 0 && g <= 0xffff))) return null;
  return groups.flatMap((g) => [g >> 8, g & 255]);
}

const startsWith = (bytes, prefix) => prefix.every((b, i) => bytes[i] === b);
const v4FromBytes = (b, at) => `${b[at]}.${b[at + 1]}.${b[at + 2]}.${b[at + 3]}`;

// IPv6 policy: only global unicast (2000::/3) is allowed, minus special-purpose blocks; IPv6 forms that
// embed an IPv4 address (mapped, compatible, NAT64, 6to4) are judged by that IPv4 address.
function isBlockedV6(ip) {
  const b = v6Bytes(ip);
  if (!b) return true;
  const zeros = (n) => b.slice(0, n).every((x) => x === 0);
  if (zeros(10) && b[10] === 0xff && b[11] === 0xff) return isBlockedV4(v4FromBytes(b, 12)); // ::ffff:a.b.c.d (mapped)
  if (zeros(12)) return true; // ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d
  if (zeros(8) && b[8] === 0xff && b[9] === 0xff && b[10] === 0 && b[11] === 0) return true; // ::ffff:0:a.b.c.d (SIIT)
  if (startsWith(b, [0x00, 0x64, 0xff, 0x9b]) && b.slice(4, 12).every((x) => x === 0)) return isBlockedV4(v4FromBytes(b, 12)); // 64:ff9b::/96 NAT64
  if (startsWith(b, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01])) return true; // 64:ff9b:1::/48 local-use NAT64
  if ((b[0] & 0xe0) !== 0x20) return true; // outside 2000::/3: fc00::/7 ULA, fe80::/10 link-local, ff00::/8 multicast, 100::/64 …
  if (b[0] === 0x20 && b[1] === 0x02) return isBlockedV4(v4FromBytes(b, 2)); // 2002::/16 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32 documentation
  if (b[0] === 0x20 && b[1] === 0x01 && (b[2] & 0xfe) === 0x00) return true; // 2001::/23 special purpose, incl. Teredo
  if (b[0] === 0x3f && b[1] === 0xff && (b[2] & 0xf0) === 0x00) return true; // 3fff::/20 documentation
  return false;
}

// True when the address (IPv4 or IPv6 text) must never be contacted.
function isBlockedAddress(ip) {
  const text = String(ip).replace(/^\[|\]$/g, '');
  const kind = net.isIP(text.split('%')[0]);
  if (kind === 4) return isBlockedV4(text);
  if (kind === 6) return isBlockedV6(text);
  return true;
}

// ---------- hostnames ----------
const BLOCKED_NAMES = new Set(['localhost', 'metadata', 'metadata.google.internal', 'metadata.goog', 'instance-data',
  'instance-data.ec2.internal', 'metadata.azure.com', 'kubernetes', 'kubernetes.default']);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa', '.arpa', '.lan', '.intranet',
  '.corp', '.private', '.test', '.invalid', '.example', '.onion'];

// Normalized hostname without brackets or a trailing dot.
const bareHost = (hostname) => hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '').toLowerCase();

// Throws FetchError('blocked') for a hostname that is refused without looking it up.
function checkHostname(hostname) {
  const host = bareHost(hostname);
  if (!host) throw blocked('The URL has no host.');
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw blocked(`The address ${host} is private, loopback or reserved; only public websites can be checked.`);
    return host;
  }
  // The URL parser turns numeric IPv4 forms into dotted quads; anything still numeric-looking is refused.
  if (/^[0-9.x]+$/i.test(host) || /^\d+$/.test(host.split('.').pop())) throw blocked('Numeric hosts must be a plain public IP address.');
  if (BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw blocked(`The host ${host} is a local or internal name; only public websites can be checked.`);
  }
  if (!host.includes('.')) throw blocked(`The host ${host} is not a public domain name (it has no dot).`);
  return host;
}

// Parses and validates a URL string. Returns a URL object or throws FetchError.
function checkUrl(input) {
  if (typeof input !== 'string' || !input.trim()) throw new FetchError('invalid_url', 'A URL is required.');
  if (input.length > MAX_URL) throw new FetchError('invalid_url', `The URL is longer than ${MAX_URL} characters.`);
  let url;
  try { url = new URL(input.trim()); } catch { throw new FetchError('invalid_url', 'This is not a valid URL.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw blocked('Only http and https URLs can be checked.');
  if (url.username || url.password) throw blocked('URLs with a user name or password are not allowed.');
  if (url.port && url.port !== '80' && url.port !== '443') throw blocked('Only the standard ports 80 and 443 are allowed.');
  checkHostname(url.hostname);
  url.hash = '';
  return url;
}

// ---------- DNS ----------
const defaultResolve = (host) => dnsPromises.lookup(host, { all: true, verbatim: true });

// Resolves a hostname and returns { address, family } to pin, or throws. Every address must be public.
async function resolvePublic(hostname, { resolve = defaultResolve, dnsTimeoutMs = DEFAULTS.dnsTimeoutMs, signal } = {}) {
  const host = checkHostname(hostname);
  if (net.isIP(host)) return { address: host, family: net.isIP(host) };
  let timer;
  let answers;
  try {
    answers = await Promise.race([
      Promise.resolve().then(() => resolve(host)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new FetchError('timeout', `DNS lookup for ${host} timed out.`)), dnsTimeoutMs);
        signal?.addEventListener('abort', () => reject(new FetchError('aborted', 'The check ran out of time.')), { once: true });
      }),
    ]);
  } catch (err) {
    if (err instanceof FetchError) throw err;
    throw new FetchError('dns', `The host ${host} could not be resolved.`);
  } finally {
    clearTimeout(timer);
  }
  const list = (Array.isArray(answers) ? answers : [answers]).filter(Boolean)
    .map((a) => (typeof a === 'string' ? { address: a, family: net.isIP(a) } : { address: a.address, family: a.family || net.isIP(a.address) }));
  if (!list.length) throw new FetchError('dns', `The host ${host} has no address.`);
  // Never say which private address a name resolved to: generic message only.
  if (list.some((a) => isBlockedAddress(a.address))) throw blocked(`The host ${host} resolves to a private, loopback or reserved address; only public websites can be checked.`);
  return list[0];
}

// ---------- transport (real sockets) ----------
// A `lookup` that always answers with the address we validated: the socket can only go there.
function pinnedLookup(address, family) {
  return (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : options || {};
    if (opts.all) cb(null, [{ address, family }]);
    else cb(null, address, family);
  };
}

// One GET to a pinned address. Resolves { status, headers, body (Readable) } once headers arrive.
function nodeTransport({ url, address, family, headers, signal }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const host = bareHost(target.hostname);
    const req = lib.request({
      protocol: target.protocol,
      hostname: host,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: { ...headers, host: target.host },
      lookup: pinnedLookup(address, family),
      agent: false, // no pooled socket that could be reused for another host
      ...(target.protocol === 'https:' && !net.isIP(host) && { servername: host }),
    });
    const onAbort = () => req.destroy(signal.reason instanceof Error ? signal.reason : new FetchError('aborted', 'aborted'));
    // Listeners first: destroying the request below must still settle this promise.
    req.on('response', (res) => resolve({ status: res.statusCode, headers: res.headers, body: res }));
    req.on('error', (err) => reject(err));
    req.on('close', () => signal?.removeEventListener('abort', onAbort));
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    req.end();
  });
}

// ---------- body ----------
const TEXTISH = /^(text\/[\w.+-]+|application\/([\w.-]+\+)?(json|xml)|application\/(linkset\+json|ld\+json|x-yaml|yaml|openapi\+json|openapi\+yaml|vnd\.oai\.openapi(\+json)?))$/i;
const mediaType = (headers) => String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
const isTextish = (type) => !type || TEXTISH.test(type);

// Reads a stream up to maxBytes (after decompression). With truncate, stops reading and returns what it
// has; without, throws too_large. Either way the source is destroyed as soon as the cap is reached.
// abortError() names the reason when the signal fires (timeout, or the session's deadline).
function readCapped(source, encoding, { maxBytes, truncate, signal, abortError = () => new FetchError('timeout', 'The request timed out.') }) {
  return new Promise((resolve, reject) => {
    let stream = source;
    const decoders = { gzip: zlib.createGunzip, 'x-gzip': zlib.createGunzip, deflate: zlib.createInflate, br: zlib.createBrotliDecompress };
    const make = decoders[String(encoding || '').trim().toLowerCase()];
    if (make) {
      stream = make();
      source.on('error', (err) => stream.destroy(err));
      source.pipe(stream);
    }
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      source.destroy();
      if (stream !== source) stream.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const onAbort = () => finish(abortError());
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    stream.on('data', (chunk) => {
      if (done) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (size + buf.length > maxBytes) {
        if (!truncate) return finish(new FetchError('too_large', `The response is larger than ${Math.round(maxBytes / 1024)} KB.`));
        chunks.push(buf.subarray(0, maxBytes - size));
        size = maxBytes;
        return finish(null, { buffer: Buffer.concat(chunks), truncated: true });
      }
      chunks.push(buf);
      size += buf.length;
    });
    stream.on('end', () => finish(null, { buffer: Buffer.concat(chunks), truncated: false }));
    stream.on('error', (err) => finish(err instanceof FetchError ? err : new FetchError('network', 'The response could not be read.')));
  });
}

// ---------- sessions ----------
// A session is one site check: a shared request budget, a deadline, and a per-host DNS cache so every
// request to a host uses the same validated address.
function createSession(options = {}) {
  const {
    resolve = defaultResolve,
    transport = nodeTransport,
    maxRequests = 14,
    deadlineMs = 12000,
    now = Date.now,
  } = options;
  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new FetchError('aborted', 'The check ran out of time.')), deadlineMs);
  timer.unref?.();
  const dnsCache = new Map();
  const session = { requests: 0, maxRequests, signal: controller.signal, log: [] };

  const lookup = (hostname) => {
    const key = bareHost(hostname);
    if (!dnsCache.has(key)) dnsCache.set(key, resolvePublic(hostname, { resolve, signal: controller.signal }));
    return dnsCache.get(key);
  };

  // GET with validation, pinned DNS, manual redirects, timeouts and size caps.
  // Returns { url, status, headers, type, text, truncated, skipped?, redirects: [urls], location? }.
  session.fetch = async function fetchSafe(input, opts = {}) {
    const {
      headers = {},
      maxBytes = DEFAULTS.maxBytes,
      truncate = false,
      maxRedirects = DEFAULTS.maxRedirects,
      timeoutMs = DEFAULTS.timeoutMs,
    } = opts;
    let url = checkUrl(String(input));
    const redirects = [];
    for (let hop = 0; ; hop++) {
      if (controller.signal.aborted) throw new FetchError('aborted', 'The check ran out of time.');
      if (session.requests >= maxRequests) throw new FetchError('budget', 'The request budget for this check is used up.');
      session.requests++;
      let address;
      let family;
      try {
        ({ address, family } = await lookup(url.hostname));
      } catch (err) {
        if (hop > 0 && err.code === 'blocked') throw blocked(`A redirect pointed to a blocked target: ${err.message}`);
        throw err;
      }
      const perRequest = AbortSignal.any([controller.signal, AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, deadlineMs - (now() - started))))]);
      // The per-request timer is clamped to the deadline, so both can fire together: past the deadline it is "aborted".
      const abortError = () => (controller.signal.aborted || now() - started >= deadlineMs ? new FetchError('aborted', 'The check ran out of time.') : new FetchError('timeout', `The request to ${url.host} timed out.`));
      session.log.push(url.href);
      let res;
      try {
        res = await new Promise((resolveRes, rejectRes) => {
          if (perRequest.aborted) return rejectRes(abortError());
          const onAbort = () => rejectRes(abortError());
          perRequest.addEventListener('abort', onAbort, { once: true });
          Promise.resolve()
            .then(() => transport({ url: url.href, address, family, signal: perRequest, headers: { 'user-agent': USER_AGENT, accept: '*/*', 'accept-encoding': 'identity', ...headers } }))
            .then(resolveRes, rejectRes)
            .finally(() => perRequest.removeEventListener('abort', onAbort));
        });
      } catch (err) {
        if (err instanceof FetchError) throw err;
        if (perRequest.aborted) throw abortError();
        throw new FetchError('network', `Could not connect to ${url.host}.`);
      }
      const status = res.status;
      const resHeaders = Object.fromEntries(Object.entries(res.headers || {}).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(', ') : String(v)]));
      const location = resHeaders.location;
      if (status >= 300 && status < 400 && location) {
        res.body?.destroy?.();
        let next;
        try { next = new URL(location, url); } catch { throw new FetchError('network', 'The server sent an invalid redirect.'); }
        if (hop >= maxRedirects) {
          if (maxRedirects === 0) return { url: url.href, status, headers: resHeaders, type: mediaType(resHeaders), text: '', truncated: false, redirects, location: next.href };
          throw new FetchError('too_many_redirects', `More than ${maxRedirects} redirects.`);
        }
        try {
          url = checkUrl(next.href);
        } catch (err) {
          if (err.code === 'blocked') throw blocked(`A redirect pointed to a blocked target: ${err.message}`);
          throw err;
        }
        redirects.push(url.href);
        continue;
      }
      const type = mediaType(resHeaders);
      if (!isTextish(type)) {
        res.body?.destroy?.();
        return { url: url.href, status, headers: resHeaders, type, text: '', truncated: false, redirects, skipped: 'not text' };
      }
      const read = res.body
        ? await readCapped(res.body, resHeaders['content-encoding'], { maxBytes, truncate, signal: perRequest, abortError })
        : { buffer: Buffer.alloc(0), truncated: false };
      return { url: url.href, status, headers: resHeaders, type, text: new TextDecoder('utf-8').decode(read.buffer), truncated: read.truncated, redirects };
    }
  };

  session.close = () => {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort(new FetchError('aborted', 'The check is finished.'));
  };
  return session;
}

module.exports = {
  USER_AGENT, DEFAULTS, FetchError,
  isBlockedAddress, isBlockedV4, isBlockedV6, v6Bytes, checkHostname, checkUrl, resolvePublic,
  pinnedLookup, nodeTransport, readCapped, isTextish, createSession,
};
