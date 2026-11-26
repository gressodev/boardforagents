// 1. DNS check: both resolvers must agree; NXDOMAIN / missing string is "absent", SERVFAIL / timeout is "transient".
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dns, agents } = require('./helpers');

const NAME = '_boardforagents.example.com';
const VALUE = 'bfa-verify=abc123';

// specs: per resolver, one of { txt: [...] (NOERROR) }, { status: 3 } (NXDOMAIN), { status: 2 } (SERVFAIL),
// 'timeout', 'http500', 'network', or { raw: [...] } for Answer data as sent.
function mockFetch(specs) {
  const calls = [];
  const fetch = (url, { signal } = {}) => {
    calls.push(url);
    const which = url.startsWith('https://cloudflare-dns.com/') ? 'cloudflare' : url.startsWith('https://dns.google/') ? 'google' : null;
    assert.ok(which, `unexpected URL ${url}`);
    const spec = specs[which];
    if (spec === 'timeout') return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    if (spec === 'network') return Promise.reject(new TypeError('fetch failed'));
    if (spec === 'http500') return Promise.resolve(new Response('oops', { status: 500 }));
    const body = spec.status != null && !spec.txt
      ? { Status: spec.status, AD: false }
      : { Status: 0, AD: Boolean(spec.ad), Answer: (spec.raw || spec.txt.map((v) => JSON.stringify(v))).map((data) => ({ name: `${NAME}.`, type: 16, TTL: 300, data })) };
    return Promise.resolve(new Response(JSON.stringify(body)));
  };
  return { fetch, calls };
}
const check = (specs, options = {}) => dns.checkTxt(NAME, VALUE, { fetch: mockFetch(specs).fetch, timeoutMs: 30, ...options });

test('both resolvers return the value: verified, and both are actually queried', async () => {
  const mock = mockFetch({ cloudflare: { txt: ['v=spf1 -all', VALUE] }, google: { raw: [VALUE] } });
  const result = await dns.checkTxt(NAME, VALUE, { fetch: mock.fetch });
  assert.equal(result.outcome, 'verified');
  assert.equal(mock.calls.length, 2);
  assert.ok(mock.calls.every((url) => url.includes('name=_boardforagents.example.com') && url.includes('type=TXT')));
});

test('chunked TXT records are joined; quoting and escapes are handled', async () => {
  assert.equal(dns.parseTxtData('"bfa-verify=" "abc123"'), VALUE);
  assert.equal(dns.parseTxtData('"a\\"b" "c\\\\d"'), 'a"bc\\d');
  assert.equal(dns.parseTxtData('"\\065BC"'), 'ABC');
  assert.equal(dns.parseTxtData('unquoted text'), 'unquoted text');
  const result = await check({ cloudflare: { raw: ['"bfa-verify=" "abc123"'] }, google: { raw: ['bfa-verify=abc123'] } });
  assert.equal(result.outcome, 'verified');
});

test('a value that only nearly matches is absent', async () => {
  assert.equal((await check({ cloudflare: { txt: [`${VALUE}x`] }, google: { txt: [` ${VALUE}`] } })).outcome, 'absent');
});

test('one resolver disagrees: failure, but transient (no grace)', async () => {
  assert.equal((await check({ cloudflare: { txt: [VALUE] }, google: { txt: [] } })).outcome, 'transient');
  assert.equal((await check({ cloudflare: { status: 3 }, google: { txt: [VALUE] } })).outcome, 'transient');
});

test('one resolver times out or fails: failure, transient', async () => {
  const started = Date.now();
  const result = await check({ cloudflare: { txt: [VALUE] }, google: 'timeout' });
  assert.equal(result.outcome, 'transient');
  assert.equal(result.resolvers.find((r) => r.name === 'google').error, 'timeout');
  assert.ok(Date.now() - started < 2000);
  assert.equal((await check({ cloudflare: 'network', google: { txt: [VALUE] } })).outcome, 'transient');
  assert.equal((await check({ cloudflare: 'http500', google: { txt: [VALUE] } })).outcome, 'transient');
});

test('NXDOMAIN or a missing string at both resolvers: absent', async () => {
  assert.equal((await check({ cloudflare: { status: 3 }, google: { status: 3 } })).outcome, 'absent');
  assert.equal((await check({ cloudflare: { txt: [] }, google: { txt: ['something else'] } })).outcome, 'absent');
  assert.equal((await check({ cloudflare: { status: 3 }, google: { txt: [] } })).outcome, 'absent');
});

test('SERVFAIL or timeouts at both resolvers: transient', async () => {
  assert.equal((await check({ cloudflare: { status: 2 }, google: { status: 2 } })).outcome, 'transient');
  assert.equal((await check({ cloudflare: 'timeout', google: 'timeout' })).outcome, 'transient');
  assert.equal((await check({ cloudflare: { status: 3 }, google: { status: 2 } })).outcome, 'transient');
});

test('the DNSSEC AD bit is reported only when both set it', async () => {
  assert.equal((await check({ cloudflare: { txt: [VALUE], ad: true }, google: { txt: [VALUE], ad: true } })).ad, true);
  assert.equal((await check({ cloudflare: { txt: [VALUE], ad: true }, google: { txt: [VALUE] } })).ad, false);
});

test('transient outcomes never start or advance grace; absent does', () => {
  const t0 = Date.UTC(2026, 0, 1);
  const rec = { status: 'active', checked_at: new Date(t0).toISOString(), failing_since: null, keys: [] };
  assert.equal(agents.applyOutcome(rec, 'transient', t0 + 1000), false);
  assert.equal(rec.status, 'active');
  assert.equal(rec.failing_since, null);
  assert.equal(agents.applyOutcome(rec, 'absent', t0 + 2000), true);
  assert.equal(rec.status, 'grace');
  assert.equal(agents.applyOutcome(rec, 'transient', t0 + 100 * 3600000), false); // long past 72 h, but transient
  assert.equal(rec.status, 'grace');
  assert.equal(agents.applyOutcome(rec, 'absent', t0 + 71 * 3600000), false); // < 72 h since failing_since
  assert.equal(agents.applyOutcome(rec, 'absent', t0 + 2000 + 72 * 3600000), true);
  assert.equal(rec.status, 'lapsed');
  assert.equal(agents.applyOutcome(rec, 'verified', t0 + 80 * 3600000), true);
  assert.equal(rec.status, 'active');
});

test('the stub answers like DoH and is off unless DNS_STUB=1 without VERCEL_ENV', async () => {
  process.env.DNS_STUB = '1';
  delete process.env.VERCEL_ENV;
  assert.equal(dns.stub.enabled(), true);
  dns.stub.set(NAME, { txt: [VALUE] });
  assert.equal((await dns.checkTxt(NAME, VALUE)).outcome, 'verified');
  dns.stub.set(NAME, { status: 'SERVFAIL' });
  assert.equal((await dns.checkTxt(NAME, VALUE)).outcome, 'transient');
  dns.stub.set(NAME, { cloudflare: { txt: [VALUE] }, google: { status: 'NXDOMAIN' } });
  assert.equal((await dns.checkTxt(NAME, VALUE)).outcome, 'transient');
  dns.stub.set(NAME, { status: 'TIMEOUT' });
  assert.equal((await dns.checkTxt(NAME, VALUE, { timeoutMs: 20 })).outcome, 'transient');
  dns.stub.clear();
  assert.equal((await dns.checkTxt(NAME, VALUE)).outcome, 'absent');
  for (const env of ['preview', 'production', 'development']) {
    process.env.VERCEL_ENV = env;
    assert.equal(dns.stub.enabled(), false, env);
  }
  delete process.env.VERCEL_ENV;
  process.env.DNS_STUB = '0';
  assert.equal(dns.stub.enabled(), false);
});

test('domain validation', () => {
  assert.equal(agents.parseDomain('Example.COM.'), 'example.com');
  assert.equal(agents.parseDomain('bücher.de'), 'xn--bcher-kva.de');
  assert.equal(agents.parseDomain('bot.example.co.uk'), 'bot.example.co.uk');
  for (const bad of ['', 'localhost', 'com', '127.0.0.1', '[::1]', 'example.test', 'a.local', 'x.onion', 'co.uk', 'vercel.app', 'github.io',
    'https://example.com', 'example.com/path', 'user@example.com', 'a_b.com', '-a.com', 'a..com', `${'a'.repeat(64)}.com`, `${'a.'.repeat(127)}com`]) {
    assert.throws(() => agents.parseDomain(bad), (err) => err.status === 400, bad);
  }
});
