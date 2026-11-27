// TODO REMOVE together with GET /api/check/diag (temporary shared-layer diagnostics, preview deployments only).
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { call, reset } = require('./helpers');

const IP = '203.0.113.77';

beforeEach(() => reset());
afterEach(() => { delete process.env.VERCEL_ENV; });

test('GET /api/check/diag is 404 outside preview deployments', async () => {
  for (const env of [undefined, 'production', 'development']) {
    if (env === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = env;
    const r = await call('GET', '/api/check/diag', { headers: { 'x-forwarded-for': IP } });
    assert.equal(r.status, 404, `VERCEL_ENV=${env}`);
    assert.ok(!r.text.includes('ip_hash_prefix'), `VERCEL_ENV=${env}`);
  }
});

test('on preview it answers booleans and numbers only, never the address', async () => {
  process.env.VERCEL_ENV = 'preview';
  const r = await call('GET', '/api/check/diag', { headers: { 'x-forwarded-for': IP } });
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes(IP));
  const leaves = [];
  const walk = (value, path) => {
    if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
    else leaves.push([path, value]);
  };
  walk(r.json, '');
  for (const [path, value] of leaves) {
    if (path === '.limiter.ip_hash_prefix') assert.match(value, /^[0-9a-f]{8}$/);
    else assert.ok(typeof value === 'boolean' || typeof value === 'number', `${path} is ${typeof value}`);
  }
  // Tests run against the fake shared cache (test/helpers.js), so the roundtrips succeed.
  assert.equal(r.json.backend.deps_shared_overridden, true);
  assert.equal(r.json.roundtrip_with_ttl_and_name.match, true);
  assert.equal(r.json.roundtrip_without_options.match, true);
  assert.equal(r.json.client.ip_present, true);
  // The same address gives the same hash prefix.
  const again = await call('GET', '/api/check/diag', { headers: { 'x-forwarded-for': IP } });
  assert.equal(again.json.limiter.ip_hash_prefix, r.json.limiter.ip_hash_prefix);
});
