// Test harness: calls the serverless handler directly with fake requests. No network, no Blob:
// storage is in memory, DNS goes to the stub (DNS_STUB=1) or an injected fetch, and the clock is injectable.
// Never point tests at real credentials: they are removed here before any module loads.
for (const name of ['BLOB_READ_WRITE_TOKEN', 'BLOB_STORE_ID', 'VERCEL_OIDC_TOKEN', 'AI_GATEWAY_API_KEY', 'ANTHROPIC_API_KEY', 'VERCEL_ENV', 'BOARD_ADMIN_KEY', 'SUBSCRIPTION_PEPPER']) {
  delete process.env[name];
}
process.env.CRON_SECRET = 'test-cron-secret';

const { Readable } = require('node:stream');
const handler = require('../api/index.js');
const store = require('../lib/store');
const agents = require('../lib/agents');
const dns = require('../lib/dns');
const { clock } = require('../lib/clock');
const outbound = require('../lib/outbound');
const subscriptions = require('../lib/subscriptions');

// Any real network call is a test bug.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { throw new Error(`network access in tests: ${url}`); };
// Webhooks: no live DNS and no live HTTPS either, unless a test installs a fake network (fakeNet below).
const offline = {
  lookup: async (host) => { throw new Error(`DNS lookup in tests: ${host}`); },
  request: async ({ url }) => { throw new Error(`outbound request in tests: ${url}`); },
};
outbound.use(offline);

// A fake internet for webhooks. dns: hostname -> [addresses] (or a function returning them, called on every
// lookup). handlers: hostname -> ({ url, address, headers, body, json }) => answer (see answer()).
// Returns the list of requests made, in order; each entry says which address the connection was pinned to.
function fakeNet({ dns: names = {}, handlers = {} } = {}) {
  const requests = [];
  const lookups = [];
  outbound.use({
    lookup: async (host) => {
      lookups.push(host);
      const entry = names[host];
      if (entry === undefined) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
      return typeof entry === 'function' ? entry() : entry;
    },
    request: async ({ url, address, headers, body }) => {
      let json;
      try { json = JSON.parse(body); } catch {}
      const entry = { url: url.href, host: url.hostname, address, headers, body, json };
      requests.push(entry);
      const handler = handlers[url.hostname];
      if (!handler) throw Object.assign(new Error('ECONNREFUSED'), { code: 'ECONNREFUSED' });
      return handler(entry);
    },
  });
  requests.lookups = lookups;
  return requests;
}
const answer = (status, data = {}) => ({ status, body: Buffer.from(typeof data === 'string' ? data : JSON.stringify(data)), truncated: false });
// The well-behaved endpoint: echoes the challenge, accepts deliveries.
const echo = ({ json }) => (json && json.type === 'subscription_challenge' ? answer(200, { challenge: json.challenge }) : answer(200, { ok: true }));

let ipCounter = 0;
function call(method, path, { body, headers = {} } = {}) {
  const payload = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const req = Readable.from(payload ? [Buffer.from(payload)] : []);
  req.method = method;
  req.url = path;
  req.headers = {
    host: 'localhost',
    'content-type': 'application/json',
    'x-forwarded-for': `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`, // a fresh address per call: no throttling
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
  };
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
      end(chunk = '') {
        const text = String(chunk);
        let json;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: this.statusCode, headers: this.headers, text, json });
      },
    };
    Promise.resolve(handler(req, res)).catch(reject);
  });
}
const auth = (key) => ({ Authorization: `Bearer ${key}` });

async function mcp(name, args, headers = {}) {
  const r = await call('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, headers });
  const result = r.json.result;
  const text = result.content[0].text;
  let data;
  try { data = JSON.parse(text); } catch {}
  return { isError: Boolean(result.isError), text, data };
}

let now;
function setNow(ms) { now = ms; }
function advance(ms) { now += ms; }

function reset({ flag = 'on' } = {}) {
  store.resetMemory();
  agents.store.resetMemory();
  subscriptions.store.resetMemory();
  outbound.use(offline);
  agents.forget();
  dns.stub.clear();
  now = Date.UTC(2026, 10, 26, 6, 0, 0);
  clock.now = () => now;
  delete process.env.VERCEL_ENV;
  delete process.env.BOARD_ADMIN_KEY;
  process.env.DNS_STUB = '1';
  if (flag) process.env.VERIFIED_AGENTS = flag;
  else delete process.env.VERIFIED_AGENTS;
}

// The whole claim flow against the DNS stub. Returns { key, claim, check }.
async function verify(domain, { revoke = false } = {}) {
  const claimed = await call('POST', '/api/agents/claims', { body: { domain, ...(revoke && { revoke_existing_keys: true }) } });
  if (claimed.status !== 201) throw new Error(`claim failed: ${claimed.status} ${claimed.text}`);
  const claim = claimed.json;
  dns.stub.set(claim.txt_name, { txt: [claim.txt_value] });
  const checked = await call('POST', `/api/agents/claims/${claim.claim_id}/check`, { headers: auth(claim.claim_secret) });
  if (checked.status !== 200 || !checked.json.verified) throw new Error(`check failed: ${checked.status} ${checked.text}`);
  return { key: checked.json.agent_key, claim, check: checked.json };
}

const post = (body, headers) => call('POST', '/api/posts', { body: { title: 'Hello', body: 'Text', ...body }, headers });
const cron = (secret = 'test-cron-secret') => call('GET', '/api/cron/recheck', { headers: auth(secret) });

const HOUR = 3600000;
const DAY = 24 * HOUR;

module.exports = { call, auth, mcp, reset, verify, post, cron, setNow, advance, dns, agents, store, clock, realFetch, HOUR, DAY, outbound, subscriptions, fakeNet, answer, echo };
