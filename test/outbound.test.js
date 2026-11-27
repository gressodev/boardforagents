// lib/outbound.js: which URLs and addresses are refused, DNS checked on every request, the connection pinned
// to the checked address, no redirects, a capped response. No live DNS or HTTP: a fake resolver and transport,
// and for the real transport a fake https module.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { reset, outbound, fakeNet, answer } = require('./helpers');

beforeEach(() => reset());

test('addresses: private, loopback, link-local, metadata, multicast, reserved and mapped forms are blocked', () => {
  const blocked = [
    '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1',
    '169.254.169.254', '169.254.170.2', '100.100.100.200', '168.63.129.16', '224.0.0.1', '239.255.255.250', '255.255.255.255',
    '240.0.0.1', '192.0.2.1', '198.51.100.7', '203.0.113.9', '198.18.0.1',
    '::', '::1', 'fe80::1', 'fe80::1%eth0', 'fc00::1', 'fd00:ec2::254', 'fd12:3456::1', 'ff02::1', 'fec0::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '::ffff:10.0.0.1', '::127.0.0.1',
    '64:ff9b::7f00:1', '2002:7f00:1::1', '2001:0:4136:e378::1', '2001:db8::1', '[::1]', 'not-an-ip', '',
  ];
  for (const ip of blocked) assert.equal(outbound.isBlockedAddress(ip), true, ip);
  for (const ip of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e']) {
    assert.equal(outbound.isBlockedAddress(ip), false, ip);
  }
});

test('URLs: https only, port 443, no credentials, no local names or private literals', () => {
  const refused = {
    'http://example.com/hook': 'not_https',
    'file:///etc/passwd': 'not_https',
    'data:text/plain,hi': 'not_https',
    'ftp://example.com/': 'not_https',
    'gopher://example.com/': 'not_https',
    'javascript:alert(1)': 'not_https',
    'https://user:pw@example.com/': 'invalid_url',
    'https://example.com:8443/': 'port',
    'https://example.com:22/': 'port',
    'https://localhost/': 'blocked_host',
    'https://LOCALHOST./': 'blocked_host',
    'https://api.localhost/': 'blocked_host',
    'https://metadata.google.internal/computeMetadata/v1/': 'blocked_host',
    'https://metadata/': 'blocked_host',
    'https://printer.local/': 'blocked_host',
    'https://intranet/': 'blocked_host',
    'https://127.0.0.1/': 'blocked_address',
    'https://2130706433/': 'blocked_address', // 127.0.0.1 as a number
    'https://0x7f.1/': 'blocked_address',
    'https://169.254.169.254/latest/meta-data/': 'blocked_address',
    'https://[::1]/': 'blocked_address',
    'https://[::ffff:127.0.0.1]/': 'blocked_address',
    'https://[fd00:ec2::254]/': 'blocked_address',
    'not a url': 'invalid_url',
    [`https://example.com/${'a'.repeat(2000)}`]: 'invalid_url',
  };
  for (const [url, code] of Object.entries(refused)) {
    assert.throws(() => outbound.checkUrl(url), (err) => err instanceof outbound.OutboundError && err.code === code, url);
  }
  assert.equal(outbound.checkUrl('https://hooks.example.com/a?b=c#frag').href, 'https://hooks.example.com/a?b=c');
  assert.equal(outbound.checkUrl('https://hooks.example.com:443/x').href, 'https://hooks.example.com/x');
});

test('post(): refused when any resolved address is private; connects only to the checked address', async () => {
  const calls = fakeNet({
    dns: {
      'public.example.com': ['93.184.216.34'],
      'mixed.example.com': ['93.184.216.34', '10.0.0.5'],
      'private.example.com': ['192.168.0.10'],
      'mapped.example.com': ['::ffff:169.254.169.254'],
      'metadata.example.com': ['fd00:ec2::254'],
      'empty.example.com': [],
    },
    handlers: { 'public.example.com': () => answer(200, { ok: true }) },
  });
  for (const host of ['mixed', 'private', 'mapped', 'metadata']) {
    await assert.rejects(outbound.post(`https://${host}.example.com/`, { body: '{}' }), (err) => err.code === 'blocked_address', host);
  }
  await assert.rejects(outbound.post('https://empty.example.com/', { body: '{}' }), (err) => err.code === 'dns_failed');
  await assert.rejects(outbound.post('https://unknown.example.com/', { body: '{}' }), (err) => err.code === 'dns_failed');
  assert.equal(calls.length, 0, 'no connection to a refused host');
  const ok = await outbound.post('https://public.example.com/hook', { body: '{"a":1}', headers: { 'X-Test': '1' } });
  assert.equal(ok.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].address, '93.184.216.34');
  assert.equal(calls[0].body, '{"a":1}');
});

test('post(): DNS is resolved again on every request (rebinding is caught)', async () => {
  let answers = ['93.184.216.34'];
  const calls = fakeNet({ dns: { 'rebind.example.com': () => answers }, handlers: { 'rebind.example.com': () => answer(200) } });
  assert.equal((await outbound.post('https://rebind.example.com/', { body: '{}' })).status, 200);
  answers = ['127.0.0.1'];
  await assert.rejects(outbound.post('https://rebind.example.com/', { body: '{}' }), (err) => err.code === 'blocked_address');
  assert.equal(calls.length, 1);
  assert.equal(calls.lookups.length, 2);
});

test('post(): redirects are failures, never followed; timeouts are reported', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const calls = fakeNet({
      dns: { 'r.example.com': ['93.184.216.34'], 'metadata.example.net': ['93.184.216.35'] },
      handlers: { 'r.example.com': () => ({ ...answer(status), headers: { location: 'https://metadata.example.net/' } }) },
    });
    await assert.rejects(outbound.post('https://r.example.com/', { body: '{}' }), (err) => err.code === 'redirect', String(status));
    assert.deepEqual(calls.map((c) => c.host), ['r.example.com'], 'the Location is never requested');
  }
  const calls = fakeNet({
    dns: { 'slow.example.com': ['93.184.216.34'], 'slowdns.example.com': () => new Promise(() => {}) },
    handlers: { 'slow.example.com': () => new Promise(() => {}) },
  });
  await assert.rejects(outbound.post('https://slow.example.com/', { body: '{}', timeoutMs: 30 }), (err) => err.code === 'timeout');
  await assert.rejects(outbound.post('https://slowdns.example.com/', { body: '{}', timeoutMs: 30 }), (err) => err.code === 'timeout');
  assert.deepEqual(calls.map((c) => c.host), ['slow.example.com'], 'a lookup that times out never connects');
});

// A stand-in for node:https: records the options and answers with a scripted response.
function fakeHttps({ status = 200, chunks = ['{"ok":true}'] } = {}) {
  const seen = {};
  return {
    seen,
    request(options, onResponse) {
      seen.options = options;
      const req = new EventEmitter();
      req.end = (body) => {
        seen.body = body;
        const res = Readable.from(chunks.map((c) => Buffer.from(c)));
        res.statusCode = status;
        setImmediate(() => onResponse(res));
      };
      return req;
    },
  };
}

test('the real transport pins the socket to the checked address, verifies TLS by name, and caps the body', async () => {
  const https = fakeHttps({ status: 200, chunks: ['{"challenge":"x"}'] });
  const request = outbound.makeRequest(https);
  const url = new URL('https://hooks.example.com/path?q=1');
  const got = await request({ url, address: '93.184.216.34', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}', maxBytes: 100 });
  assert.equal(got.status, 200);
  assert.equal(got.body.toString(), '{"challenge":"x"}');
  assert.equal(got.truncated, false);
  const o = https.seen.options;
  assert.equal(o.hostname, 'hooks.example.com');
  assert.equal(o.servername, 'hooks.example.com');
  assert.equal(o.port, 443);
  assert.equal(o.method, 'POST');
  assert.equal(o.path, '/path?q=1');
  assert.equal(o.agent, false);
  assert.equal(o.rejectUnauthorized, undefined, 'certificate checks stay on');
  assert.equal(o.headers['Content-Length'], 7);
  assert.equal(https.seen.body, '{"a":1}');
  // Whatever the socket asks, the lookup answers with the checked address only.
  await new Promise((done) => o.lookup('hooks.example.com', {}, (err, address, family) => {
    assert.equal(err, null); assert.equal(address, '93.184.216.34'); assert.equal(family, 4); done();
  }));
  await new Promise((done) => o.lookup('hooks.example.com', { all: true }, (err, list) => {
    assert.deepEqual(list, [{ address: '93.184.216.34', family: 4 }]); done();
  }));
  await new Promise((done) => o.lookup('hooks.example.com', (err, address) => { assert.equal(address, '93.184.216.34'); done(); }));

  const big = outbound.makeRequest(fakeHttps({ chunks: ['a'.repeat(60), 'b'.repeat(60), 'c'.repeat(60)] }));
  const capped = await big({ url, address: '2606:4700::1', headers: {}, body: '', maxBytes: 100 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.body.length, 100);

  const redirect = outbound.makeRequest(fakeHttps({ status: 302, chunks: [] }));
  assert.equal((await redirect({ url, address: '93.184.216.34', headers: {}, body: '', maxBytes: 10 })).status, 302);
});
