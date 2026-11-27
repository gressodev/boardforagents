// The checker's per-address limit buckets clients: IPv6 by /64 (providers rotate addresses inside one prefix),
// IPv4-mapped IPv6 as the IPv4 address, IPv4 per address, anything else as it is. Only the bucket's HMAC is
// stored. No network: DNS, transport and Runtime Cache are fakes (test/check-fixtures.js).
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { reset, checker } = require('./helpers');
const { fakeNet, fakeSharedCache } = require('./check-fixtures');
const { HttpError } = require('../lib/http-error');
const { ipHash } = require('../lib/limits');

const PUBLIC = '93.184.216.34';
let backend;
let n = 0;

beforeEach(() => {
  reset();
  const net = fakeNet({ hosts: new Proxy({}, { get: () => PUBLIC }), routes: (url) => (url.endsWith('/') ? { body: '<html><title>x</title></html>' } : undefined) });
  backend = fakeSharedCache();
  Object.assign(checker.deps, { resolve: net.resolve, transport: net.transport, now: () => Date.UTC(2026, 10, 27, 12), shared: backend });
});

// One fresh check (always a new URL, so never a cache hit); returns the status.
async function fresh(ip) {
  try {
    await checker.check(`fresh${++n}.example.com`, { ip });
    return 200;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return err.status;
  }
}
async function useUp(ips) {
  for (let i = 0; i < checker.RATE.perAddress; i++) assert.equal(await fresh(ips[i % ips.length]), 200, `check ${i}`);
}

test('addressBucket: IPv6 by /64, IPv4-mapped as IPv4, IPv4 per address, anything else unchanged', () => {
  const b = checker.addressBucket;
  assert.equal(b('2a09:bac5:6d18:db9::15e:d1'), '2a09:bac5:6d18:db9::/64');
  assert.equal(b('2a09:bac5:6d18:0db9:ffff:1:2:3'), '2a09:bac5:6d18:db9::/64');
  assert.equal(b('2A09:BAC5:6D18:DB9::1'), '2a09:bac5:6d18:db9::/64');
  assert.equal(b('[2a09:bac5:6d18:db9::1]'), '2a09:bac5:6d18:db9::/64');
  assert.equal(b('fe80::1%eth0'), 'fe80:0:0:0::/64');
  assert.notEqual(b('2a09:bac5:6d19:1791::259:e5'), b('2a09:bac5:6d18:db9::15e:d1'));
  assert.equal(b('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(b('::ffff:cb00:7107'), '203.0.113.7');
  assert.equal(b(' 203.0.113.7 '), '203.0.113.7');
  assert.notEqual(b('203.0.113.7'), b('203.0.113.8'));
  for (const junk of ['local', 'unknown', '', 'not-an-ip', '::ffff:999.1.1.1', '1.2.3.4:80', '1:2:3', ':::', 'x'.repeat(5000)]) {
    assert.equal(b(junk), junk, JSON.stringify(junk.slice(0, 20)));
  }
  assert.equal(b(undefined), '');
  assert.equal(b(null), '');
  assert.equal(b(42), '42');
});

test('two addresses in one IPv6 /64 share the per-address limit', async () => {
  await useUp(['2a09:bac5:6d18:db9::15e:d1', '2a09:bac5:6d18:db9::259:e5', '2a09:bac5:6d18:db9:aaaa:bbbb:cccc:dddd']);
  assert.equal(await fresh('2a09:bac5:6d18:db9::1'), 429);
});

test('different /64s have their own limits', async () => {
  await useUp(['2a09:bac5:6d18:db9::15e:d1']);
  assert.equal(await fresh('2a09:bac5:6d18:db9::2'), 429);
  assert.equal(await fresh('2a09:bac5:6d19:1791::259:e5'), 200);
  assert.equal(await fresh('2a09:bac5:6d18:dba::1'), 200); // the neighbouring /64
});

test('IPv4-mapped IPv6 counts as its IPv4 address; other IPv4 addresses are separate', async () => {
  await useUp(['203.0.113.7', '::ffff:203.0.113.7', '::ffff:cb00:7107']);
  assert.equal(await fresh('203.0.113.7'), 429);
  assert.equal(await fresh('::ffff:203.0.113.7'), 429);
  assert.equal(await fresh('203.0.113.8'), 200);
  assert.equal(await fresh('::ffff:203.0.113.9'), 200);
});

test('garbage or unknown client addresses do not crash and are limited like any other key', async () => {
  for (const ip of [undefined, null, '', 'unknown', '::ffff:999.1.1.1', '1:2:3', '[]', '%']) assert.equal(await fresh(ip), 200, String(ip));
  await useUp(['not-an-ip']);
  assert.equal(await fresh('not-an-ip'), 429);
  assert.equal(await fresh('also-not-an-ip'), 200);
});

test('only the HMAC of the bucket reaches Runtime Cache: never the address or the prefix', async () => {
  const ip = '2a09:bac5:6d18:db9::15e:d1';
  assert.equal(await fresh(ip), 200);
  const addrWrites = backend.writes.filter((w) => w.key.startsWith('rate:addr:'));
  assert.equal(addrWrites.length, 1);
  assert.equal(addrWrites[0].key, `rate:addr:${ipHash('check:2a09:bac5:6d18:db9::/64')}`);
  const all = JSON.stringify(backend.writes);
  for (const raw of [ip, '2a09:bac5:6d18:db9', '2a09']) assert.ok(!all.includes(raw), raw);
});
