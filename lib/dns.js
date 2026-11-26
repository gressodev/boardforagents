// DNS TXT lookups for verified agents, over DNS-over-HTTPS (JSON API) with plain fetch.
// Two independent public resolvers are asked; a record counts only when both return it.
//
// Outcomes of checkTxt():
// - "verified":  both resolvers returned a TXT string exactly equal to the expected value;
// - "absent":    both resolvers answered and neither has it (NXDOMAIN, no TXT, or other strings only);
// - "transient": anything else — a timeout, SERVFAIL, a network or HTTP error, or the resolvers disagree.
//   Transient results never count toward the grace period.
//
// Local dev only: with DNS_STUB=1 and no VERCEL_ENV, lookups go to an in-memory stub (see stub below)
// that answers in the same JSON format, so the parsing code is exercised too.
const RESOLVERS = [
  { name: 'cloudflare', url: 'https://cloudflare-dns.com/dns-query' },
  { name: 'google', url: 'https://dns.google/resolve' },
];
const TIMEOUT_MS = 5000;
const TXT = 16;

// A TXT record's data as DoH JSON gives it: Cloudflare sends quoted chunks ("a" "b"), Google may send
// the joined text unquoted. Chunks of one record are joined, as RFC 7208 does for SPF.
function parseTxtData(data) {
  const raw = String(data ?? '');
  if (!raw.startsWith('"')) return raw;
  let out = '';
  let i = 0;
  while (i < raw.length) {
    if (raw[i] !== '"') { i++; continue; } // whitespace between chunks
    i++;
    while (i < raw.length && raw[i] !== '"') {
      if (raw[i] === '\\' && i + 1 < raw.length) {
        const digits = raw.slice(i + 1, i + 4);
        if (/^\d{3}$/.test(digits)) { out += String.fromCharCode(Number(digits)); i += 4; continue; }
        out += raw[i + 1];
        i += 2;
        continue;
      }
      out += raw[i++];
    }
    i++; // closing quote
  }
  return out;
}

// One resolver: { result: 'found' | 'absent' | 'error', ad, error? }
async function queryOne(resolver, name, expected, { fetch: fetchFn, timeoutMs }) {
  const url = `${resolver.url}?name=${encodeURIComponent(name)}&type=TXT`;
  try {
    const response = await fetchFn(url, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { result: 'error', ad: false, error: `HTTP ${response.status}` };
    const body = await response.json();
    const ad = body.AD === true;
    if (body.Status === 3) return { result: 'absent', ad }; // NXDOMAIN
    if (body.Status !== 0) return { result: 'error', ad, error: `DNS status ${body.Status}` }; // SERVFAIL, REFUSED, …
    const strings = (Array.isArray(body.Answer) ? body.Answer : [])
      .filter((answer) => answer && answer.type === TXT)
      .map((answer) => parseTxtData(answer.data));
    return { result: strings.includes(expected) ? 'found' : 'absent', ad };
  } catch (err) {
    return { result: 'error', ad: false, error: err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'network error' };
  }
}

function combine(answers) {
  if (answers.every((a) => a.result === 'found')) return 'verified';
  if (answers.every((a) => a.result === 'absent')) return 'absent';
  return 'transient';
}

// ---------- local stub (never in preview or production) ----------
const stubRecords = new Map(); // name -> { txt: [...] } | { status: 'NXDOMAIN' | 'SERVFAIL' | 'TIMEOUT' }, optionally per resolver
const stubEnabled = () => !process.env.VERCEL_ENV && process.env.DNS_STUB === '1';

function stubAnswer(spec, name) {
  if (!spec || spec.status === 'NXDOMAIN') return { Status: 3, AD: false };
  if (spec.status === 'SERVFAIL') return { Status: 2, AD: false };
  const Answer = (spec.txt || []).map((value) => ({ name: `${name}.`, type: TXT, TTL: 300, data: JSON.stringify(String(value)) }));
  return { Status: 0, AD: false, Answer };
}

// A fetch that answers DoH JSON queries from stubRecords. A spec may differ per resolver:
// { cloudflare: { txt: [...] }, google: { status: 'SERVFAIL' } }.
function stubFetch(url, { signal } = {}) {
  const parsed = new URL(url);
  const name = parsed.searchParams.get('name');
  const resolver = RESOLVERS.find((r) => url.startsWith(r.url));
  const entry = stubRecords.get(name);
  const spec = entry && resolver && entry[resolver.name] ? entry[resolver.name] : entry;
  if (spec && spec.status === 'TIMEOUT') {
    return new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }
  return Promise.resolve(new Response(JSON.stringify(stubAnswer(spec, name)), { headers: { 'content-type': 'application/dns-json' } }));
}

const stub = {
  enabled: stubEnabled,
  set(name, spec) {
    const key = String(name).toLowerCase().replace(/\.$/, '');
    if (!spec || (Array.isArray(spec.txt) && !spec.txt.length && !spec.status)) stubRecords.delete(key);
    else stubRecords.set(key, spec);
  },
  clear() { stubRecords.clear(); },
  fetch: stubFetch,
};

// Looks up `name` and compares with `expected`. options.fetch / options.timeoutMs are for tests.
async function checkTxt(name, expected, options = {}) {
  const fetchFn = options.fetch || (stubEnabled() ? stubFetch : globalThis.fetch);
  const timeoutMs = options.timeoutMs || TIMEOUT_MS;
  const answers = await Promise.all(RESOLVERS.map((r) => queryOne(r, name, expected, { fetch: fetchFn, timeoutMs })));
  return {
    outcome: combine(answers),
    ad: answers.every((a) => a.ad),
    resolvers: RESOLVERS.map((r, i) => ({ name: r.name, result: answers[i].result, ...(answers[i].error && { error: answers[i].error }) })),
  };
}

module.exports = { checkTxt, parseTxtData, RESOLVERS, stub };
