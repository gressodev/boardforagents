// The checker's shared layer (Vercel Runtime Cache): rate limits and cached results that hold across
// instances. Two instances are two separate copies of lib/checker.js (each with its own memory) that share one
// fake Runtime Cache (test/check-fixtures.js). No network: DNS and transport are fakes too.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { call, reset, checker } = require('./helpers');
const { fakeNet, fakeSharedCache } = require('./check-fixtures');
const { HttpError } = require('../lib/http-error');

const PUBLIC = '93.184.216.34';
const IP = '203.0.113.50';
const MINUTE = 60 * 1000;

// A second warm instance: a fresh copy of the module, so its in-memory cache and limits are its own.
function newInstance() {
  const path = require.resolve('../lib/checker');
  const saved = require.cache[path];
  delete require.cache[path];
  try {
    return require(path);
  } finally {
    require.cache[path] = saved;
  }
}

let now;
let net;
let backend;
let A;
let B;
function wire(instance, shared = backend) {
  Object.assign(instance.deps, { resolve: net.resolve, transport: net.transport, now: () => now, shared });
  return instance;
}

beforeEach(() => {
  reset();
  now = Date.UTC(2026, 10, 27, 12, 0, 0);
  net = fakeNet({ hosts: new Proxy({}, { get: () => PUBLIC }), routes: (url) => (url.endsWith('/') ? { body: '<html><title>x</title></html>' } : undefined) });
  backend = fakeSharedCache({ now: () => now });
  A = wire(checker);
  B = wire(newInstance());
});
afterEach(() => B.reset());

// One check; a 429 (or any HttpError) comes back as { status, body } instead of throwing.
async function run(instance, url, ip = IP) {
  try {
    return { status: 200, body: await instance.check(url, { ip }) };
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return { status: err.status, body: { error: err.message, ...err.extra } };
  }
}

test('the per-address limit holds across instances that share one Runtime Cache', async () => {
  // 5 fresh checks on each instance: either one alone would still allow 5 more.
  for (let i = 0; i < 10; i++) {
    const r = await run(i % 2 ? B : A, `site${i}.example.com`);
    assert.equal(r.status, 200, `check ${i}`);
    assert.equal(r.body.cached, false);
  }
  for (const instance of [A, B]) {
    const limited = await run(instance, 'site10.example.com');
    assert.equal(limited.status, 429);
    assert.match(limited.body.error, /at most 10 per 10 minutes/);
    assert.ok(limited.body.retry_after > 0 && limited.body.retry_after <= 600);
  }
  assert.equal((await run(B, 'site10.example.com', '203.0.113.51')).status, 200); // another address
  now += 10 * MINUTE + 1;
  assert.equal((await run(A, 'site11.example.com')).status, 200);

  // Keys and values hold the address only as its HMAC, and the stored lists stay bounded.
  const stored = JSON.stringify([...backend.entries.keys(), ...backend.writes]);
  assert.ok(!stored.includes(IP) && !stored.includes('203.0.113.51'), 'no raw address in Runtime Cache');
  const addressKeys = [...backend.entries.keys()].filter((k) => k.startsWith('rate:addr:'));
  assert.equal(addressKeys.length, 2);
  for (const key of addressKeys) assert.match(key, /^rate:addr:[0-9a-f]{16}$/);
  for (const w of backend.writes.filter((x) => x.key.startsWith('rate:'))) {
    const times = JSON.parse(w.json);
    assert.ok(Array.isArray(times) && times.length <= checker.RATE.global && times.every(Number.isFinite));
    if (w.key.startsWith('rate:addr:')) assert.ok(times.length <= checker.RATE.perAddress);
    assert.ok(w.options.ttl > 0 && w.options.ttl <= 600);
    assert.ok(!w.options.name.includes('203.0.113'));
  }
});

test('the global cap holds for the whole deployment, not per instance', async () => {
  const cap = checker.RATE.global;
  assert.equal(cap, 60);
  // Alternate instances and addresses: memory alone would allow 2 x cap.
  for (let i = 0; i < cap; i++) assert.equal((await run(i % 2 ? B : A, `g${i}.example.com`, `198.51.100.${i}`)).status, 200, `check ${i}`);
  for (const instance of [A, B]) {
    const r = await run(instance, 'one-more.example.com', '198.51.100.200');
    assert.equal(r.status, 429);
    assert.match(r.body.error, /busy/);
    assert.ok(r.body.retry_after > 0 && r.body.retry_after <= 60);
  }
  const list = await backend.get('rate:global');
  assert.equal(list.length, cap); // bounded: never more numbers than the cap
  now += MINUTE + 1;
  assert.equal((await run(B, 'one-more.example.com', '198.51.100.200')).status, 200);
});

test('a result checked on one instance is a cache hit on another: no requests, not counted', async () => {
  assert.equal((await run(A, 'good.example.com')).body.cached, false);
  const made = net.calls.length;
  const hit = await run(B, 'https://GOOD.example.com:443/#top');
  assert.equal(hit.status, 200);
  assert.equal(hit.body.cached, true);
  assert.equal(hit.body.url, 'https://good.example.com/');
  assert.equal(net.calls.length, made, 'a shared hit makes no outbound request');
  assert.ok(hit.body.starter_files.every((f) => f.content.length > 0));

  // 9 fresh checks on A, the same 9 again on B (hits, not counted), then B still allows the 10th.
  for (let i = 0; i < 9; i++) assert.equal((await run(A, `c${i}.example.com`, '192.0.2.7')).status, 200);
  for (let i = 0; i < 9; i++) {
    const r = await run(B, `c${i}.example.com`, '192.0.2.7');
    assert.equal(r.status, 200);
    assert.equal(r.body.cached, true);
  }
  assert.equal((await run(B, 'c9.example.com', '192.0.2.7')).body.cached, false);
  assert.equal((await run(B, 'c10.example.com', '192.0.2.7')).status, 429);
  assert.equal((await run(A, 'c3.example.com', '192.0.2.7')).status, 200); // still served from cache

  // After 10 minutes the shared result is stale on every instance.
  now += 11 * MINUTE;
  const before = net.calls.length;
  assert.equal((await run(B, 'good.example.com', '192.0.2.8')).body.cached, false);
  assert.ok(net.calls.length > before);
});

test('a shared entry for another URL, or of the wrong shape, is ignored', async () => {
  await run(A, 'one.example.com');
  const entry = await backend.get(checker.sharedKeys.result('https://one.example.com/'));
  assert.equal(entry.key, 'https://one.example.com/');
  await backend.set(checker.sharedKeys.result('https://two.example.com/'), entry, { ttl: 600 }); // wrong key inside
  await backend.set(checker.sharedKeys.result('https://three.example.com/'), { key: 'https://three.example.com/', at: now, result: 'nope' }, { ttl: 600 });
  assert.equal((await run(B, 'two.example.com')).body.cached, false);
  assert.equal((await run(B, 'two.example.com')).body.url, 'https://two.example.com/');
  assert.equal((await run(B, 'three.example.com')).body.cached, false);
  // Garbage in a rate list counts as nothing rather than crashing.
  await backend.set('rate:global', ['x', null, 1e300, -5], { ttl: 60 });
  assert.equal((await run(B, 'four.example.com', '192.0.2.99')).status, 200);
});

for (const fail of ['throw', 'reject', 'hang']) {
  test(`Runtime Cache that ${fail}s: checks still work and the in-memory limits still apply`, async () => {
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const broken = fakeSharedCache({ now: () => now, fail });
      wire(A, broken);
      A.deps.sharedTimeoutMs = 5;
      const started = Date.now();
      for (let i = 0; i < 10; i++) assert.equal((await run(A, `f${i}.example.com`)).status, 200, `check ${i}`);
      assert.ok(Date.now() - started < 3000, 'a hanging cache does not hang the checker');
      const limited = await run(A, 'f10.example.com');
      assert.equal(limited.status, 429);
      assert.match(limited.body.error, /at most 10 per 10 minutes/);
      const hit = await run(A, 'f3.example.com'); // the memory cache still answers
      assert.equal(hit.status, 200);
      assert.equal(hit.body.cached, true);
      // The global cap falls back to memory too.
      for (let i = 0; i < checker.RATE.global - 10; i++) assert.equal((await run(A, `h${i}.example.com`, `198.51.100.${i}`)).status, 200);
      assert.match((await run(A, 'h-last.example.com', '198.51.100.250')).body.error, /busy/);
      // Logged without the address, the URL or the key.
      assert.ok(warnings.every((w) => !w.includes('203.0.113') && !w.includes('example.com') && !w.includes('rate:')), warnings.join('\n'));
    } finally {
      console.warn = warn;
    }
  });
}

test('no shared layer at all (null): memory limits only', async () => {
  wire(A, null);
  for (let i = 0; i < 10; i++) assert.equal((await run(A, `m${i}.example.com`)).status, 200);
  assert.equal((await run(A, 'm10.example.com')).status, 429);
});

test('preview deployments use the shared layer too: /api/check answers 200 and writes Runtime Cache, not Blob', async () => {
  process.env.VERCEL_ENV = 'preview';
  try {
    const r = await call('GET', `/api/check?url=${encodeURIComponent('preview.example.com')}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.cached, false);
    assert.ok(backend.entries.has(checker.sharedKeys.result('https://preview.example.com/')));
    assert.ok(backend.entries.has('rate:global'));
    const again = await B.check('preview.example.com', { ip: IP });
    assert.equal(again.cached, true);
  } finally {
    delete process.env.VERCEL_ENV;
  }
});
