// Outbound HTTPS for webhooks: the only place the board sends a request to a URL chosen by a third party.
// It is built so the board cannot be used to reach anything private or to relay arbitrary requests:
//
// - only https: URLs on the default port 443, without user:password, at most 2000 characters;
// - hostnames that can only be local (localhost, *.local, *.internal, metadata.google.internal, single
//   labels, …) are refused before any lookup;
// - the hostname is resolved for every request (never cached), and the request is refused when ANY
//   resolved address is not public: loopback, unspecified, private, CGNAT, link-local (169.254/16, which
//   includes the cloud metadata address 169.254.169.254), multicast, reserved and documentation ranges,
//   and for IPv6 everything outside global unicast 2000::/3 (so ::1, fe80::/10, unique-local fc00::/7
//   with fd00:ec2::254, IPv4-mapped ::ffff:0:0/96, NAT64, …) plus 6to4, Teredo and documentation blocks;
// - the connection is pinned to the address that was just checked (the socket's lookup returns it), so
//   a DNS answer that changes between the check and the connect (rebinding) cannot redirect it, while
//   TLS still verifies the certificate against the hostname;
// - redirects are never followed (node:https does not follow them; a 3xx is reported as a failure);
// - one deadline covers lookup, connect, TLS and the response; the response body is read up to a small
//   cap, then the socket is dropped. Only the body the caller passes is sent; no caller headers or
//   cookies are forwarded.
//
// Tests replace the resolver and the transport with use(); nothing here caches addresses.
const net = require('node:net');
const dnsPromises = require('node:dns').promises;

class OutboundError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // short and safe to store: never contains the URL or a response body
  }
}

const MAX_URL = 2000;

// ---------- addresses ----------
const blocked4 = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], // "this network", includes 0.0.0.0
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT (also Alibaba Cloud metadata 100.100.100.200)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata 169.254.169.254 / 169.254.170.2
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved and broadcast
  ['168.63.129.16', 32], // Azure host endpoint (wireserver)
]) blocked4.addSubnet(address, prefix, 'ipv4');

const global6 = new net.BlockList();
global6.addSubnet('2000::', 3, 'ipv6'); // global unicast; everything else in IPv6 is refused
const blocked6 = new net.BlockList();
for (const [address, prefix] of [
  ['2001::', 23], // IETF protocol assignments, includes Teredo 2001::/32 and ORCHID
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4: embeds an IPv4 address
  ['3fff::', 20], // documentation
]) blocked6.addSubnet(address, prefix, 'ipv6');

// True when the address must never be contacted. Anything that is not a valid IP is blocked too.
function isBlockedAddress(address) {
  const ip = String(address).replace(/^\[|\]$/g, '').replace(/%.*$/, ''); // brackets and zone id
  const family = net.isIP(ip);
  if (family === 4) return blocked4.check(ip, 'ipv4');
  if (family === 6) {
    // BlockList compares IPv4-mapped IPv6 (::ffff:a.b.c.d) with the IPv4 rules too; those addresses are
    // outside 2000::/3 anyway, so they are refused either way.
    if (blocked4.check(ip, 'ipv6')) return true;
    return !global6.check(ip, 'ipv6') || blocked6.check(ip, 'ipv6');
  }
  return true;
}

// Names that only exist inside a network. Checked before any lookup (the lookup would refuse most of
// them too, but /etc/hosts or a search domain could make them resolve to something unexpected).
const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'corp', 'private',
  'localdomain', 'home.arpa', 'arpa', 'test', 'example', 'invalid', 'onion'];
const LOCAL_NAMES = new Set(['metadata', 'metadata.google.internal', 'instance-data', 'kubernetes']);

function isLocalName(hostname) {
  const name = hostname.toLowerCase().replace(/\.$/, '');
  if (!name.includes('.') || LOCAL_NAMES.has(name)) return true;
  return LOCAL_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

// ---------- URLs ----------
// Parses and checks a webhook URL without touching the network. Returns the URL object or throws.
function checkUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new OutboundError('invalid_url', '"url" is required');
  const value = raw.trim();
  if (value.length > MAX_URL) throw new OutboundError('invalid_url', `"url" must be at most ${MAX_URL} characters`);
  let url;
  try { url = new URL(value); } catch { throw new OutboundError('invalid_url', '"url" must be an absolute https:// URL'); }
  if (url.protocol !== 'https:') throw new OutboundError('not_https', '"url" must use https://');
  if (url.username || url.password) throw new OutboundError('invalid_url', '"url" must not contain a user name or password');
  if (url.port && url.port !== '443') throw new OutboundError('port', '"url" must use the default HTTPS port 443');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new OutboundError('invalid_url', '"url" must have a host name');
  if (net.isIP(host)) {
    if (isBlockedAddress(host)) throw new OutboundError('blocked_address', '"url" points to a private or reserved address');
  } else if (isLocalName(host)) {
    throw new OutboundError('blocked_host', '"url" must use a public host name');
  }
  url.hash = '';
  return url;
}

// ---------- network (replaceable in tests) ----------
async function systemLookup(hostname) {
  const answers = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => a.address);
}

// A transport built on node:https. The socket's lookup is pinned to `address`, which resolve() has
// already checked, so no second, unchecked DNS answer is ever used. Exported for unit tests (with a fake
// https module); production uses makeRequest(require('node:https')).
function makeRequest(https) {
  return function request({ url, address, headers, body, signal, maxBytes }) {
    return new Promise((resolve, reject) => {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const family = net.isIP(address);
      const pinned = (hostname, options, callback) => {
        if (typeof options === 'function') { callback = options; options = {}; }
        if (options && options.all) callback(null, [{ address, family }]);
        else callback(null, address, family);
      };
      const req = https.request({
        protocol: 'https:',
        hostname: host,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        lookup: pinned,
        ...(net.isIP(host) ? {} : { servername: host }), // SNI and certificate check use the name
        agent: false, // a fresh connection every time: no pooled socket to another address
        signal,
        maxHeaderSize: 16384,
      }, (res) => {
        const chunks = [];
        let size = 0;
        let done = false;
        const finish = (truncated) => {
          if (done) return;
          done = true;
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).subarray(0, maxBytes), truncated });
        };
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > maxBytes) {
            chunks.push(chunk);
            finish(true);
            res.destroy(); // stop reading: the cap is reached
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => finish(false));
        res.on('error', (err) => (done ? undefined : reject(err)));
        res.on('close', () => finish(size > maxBytes));
      });
      req.on('error', reject);
      req.end(body);
    });
  };
}

const defaults = { lookup: systemLookup, request: makeRequest(require('node:https')) };
const network = { ...defaults };
// Tests: use({ lookup, request }) replaces either; use() with no argument restores the real network.
function use(replacement) {
  Object.assign(network, replacement || defaults);
}

// Resolves the host now and returns one address that is safe to connect to, or throws.
async function resolve(url, signal) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return host; // checked in checkUrl
  let addresses;
  try {
    addresses = await race(network.lookup(host), signal);
  } catch (err) {
    if (err instanceof OutboundError) throw err;
    throw new OutboundError('dns_failed', 'The host name could not be resolved');
  }
  if (!Array.isArray(addresses) || !addresses.length) throw new OutboundError('dns_failed', 'The host name could not be resolved');
  if (addresses.some(isBlockedAddress)) throw new OutboundError('blocked_address', 'The host name resolves to a private or reserved address');
  return String(addresses[0]);
}

function race(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new OutboundError('timeout', 'The request timed out'));
  return new Promise((resolvePromise, reject) => {
    const onAbort = () => reject(new OutboundError('timeout', 'The request timed out'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => { signal.removeEventListener('abort', onAbort); resolvePromise(value); },
      (err) => { signal.removeEventListener('abort', onAbort); reject(err); },
    );
  });
}

// POSTs body (a string) to url. Resolves to { status, body: Buffer, truncated } for any final answer
// that is not a redirect; throws OutboundError otherwise. Never follows a redirect.
async function post(rawUrl, { body, headers = {}, timeoutMs = 5000, maxBytes = 4096 }) {
  const url = checkUrl(rawUrl);
  const signal = AbortSignal.timeout(timeoutMs);
  const address = await resolve(url, signal);
  let answer;
  try {
    answer = await race(network.request({ url, address, headers, body, signal, maxBytes }), signal);
  } catch (err) {
    if (err instanceof OutboundError) throw err;
    if (signal.aborted || err.name === 'AbortError' || err.name === 'TimeoutError') throw new OutboundError('timeout', 'The request timed out');
    throw new OutboundError('network', 'The connection failed');
  }
  if (answer.status >= 300 && answer.status < 400) throw new OutboundError('redirect', `The endpoint answered with a redirect (HTTP ${answer.status}); redirects are not followed`);
  return answer;
}

module.exports = { post, checkUrl, isBlockedAddress, isLocalName, makeRequest, use, OutboundError };
