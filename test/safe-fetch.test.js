// The SSRF guard of the site checker (lib/safe-fetch.js). DNS and transport are injected: no network,
// except one test that talks to a server on 127.0.0.1 through the low-level transport to prove pinning.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const safe = require('../lib/safe-fetch');
const { fakeNet } = require('./check-fixtures');

const PUBLIC = '93.184.216.34';
const code = (fn) => { try { fn(); } catch (err) { return err.code; } return 'ok'; };
const codeOf = async (promise) => { try { await promise; } catch (err) { return err.code; } return 'ok'; };

test('IPv4: loopback, private, link-local, CGNAT, 0/8, multicast, reserved, broadcast and documentation ranges are blocked', () => {
  const blocked = ['127.0.0.1', '127.255.255.254', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.0.1',
    '192.168.255.255', '169.254.0.1', '169.254.169.254', '100.64.0.1', '100.127.255.255', '0.0.0.0', '0.1.2.3', '224.0.0.1',
    '239.255.255.250', '240.0.0.1', '255.255.255.255', '192.0.0.8', '192.0.2.1', '198.18.0.1', '198.51.100.7', '203.0.113.9'];
  for (const ip of blocked) assert.equal(safe.isBlockedAddress(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', PUBLIC, '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '192.169.0.1']) {
    assert.equal(safe.isBlockedAddress(ip), false, ip);
  }
  for (const junk of ['', 'abc', '1.2.3', '256.1.1.1', '01.2.3.4x']) assert.equal(safe.isBlockedAddress(junk), true, junk);
});

test('IPv6: loopback, unspecified, ULA, link-local, multicast, mapped/compatible, NAT64 and 6to4 of private IPv4 are blocked', () => {
  const blocked = ['::1', '::', '0:0:0:0:0:0:0:1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'fe80::1%eth0', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:192.168.1.1',
    '::127.0.0.1', '::10.0.0.1', '::ffff:0:127.0.0.1', '64:ff9b::127.0.0.1', '64:ff9b::a9fe:a9fe', '64:ff9b::10.0.0.1', '64:ff9b:1::1',
    '2002:7f00:1::', '2002:c0a8:101::1', '2001:db8::1', '2001::1', '3fff::1', '100::1', '[::1]'];
  for (const ip of blocked) assert.equal(safe.isBlockedAddress(ip), true, ip);
  for (const ip of ['2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8', '64:ff9b::8.8.8.8', '2002:808:808::1']) {
    assert.equal(safe.isBlockedAddress(ip), false, ip);
  }
  assert.deepEqual(safe.v6Bytes('::ffff:127.0.0.1').slice(10), [255, 255, 127, 0, 0, 1]);
  assert.equal(safe.v6Bytes('not:an:ip'), null);
});

test('URLs: numeric IPv4 encodings and IPv6 literals of private addresses are refused before any lookup', () => {
  for (const url of ['http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://0x7f.1/', 'http://127.1/',
    'http://017700000001/', 'http://127.0.0.1./', 'http://0/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[0:0:0:0:0:ffff:7f00:1]/',
    'http://169.254.169.254/latest/meta-data/', 'http://[fd00::1]/', 'http://[64:ff9b::a9fe:a9fe]/', 'http://①②⑦.0.0.1/', 'http://0xa9.0xfe.0xa9.0xfe/']) {
    assert.equal(code(() => safe.checkUrl(url)), 'blocked', url);
  }
  assert.equal(safe.checkUrl('http://8.8.8.8/').hostname, '8.8.8.8');
  assert.equal(safe.checkUrl('http://[2606:4700:4700::1111]/').hostname, '[2606:4700:4700::1111]');
});

test('URLs: local and metadata host names, single labels, odd schemes, ports and credentials are refused', () => {
  for (const url of ['http://localhost/', 'http://LOCALHOST./', 'http://app.localhost/', 'http://printer.local/', 'http://db.internal/',
    'http://metadata.google.internal/', 'http://metadata/', 'http://intranet/', 'http://router.home.arpa/', 'http://1.0.0.127.in-addr.arpa/',
    'http://instance-data/', 'ftp://example.com/', 'file:///etc/passwd', 'gopher://example.com/', 'http://example.com:8080/',
    'https://example.com:22/', 'http://example.com:6379/', 'http://user:pass@example.com/', 'http://user@example.com/']) {
    assert.equal(code(() => safe.checkUrl(url)), 'blocked', url);
  }
  assert.equal(code(() => safe.checkUrl('not a url')), 'invalid_url');
  assert.equal(code(() => safe.checkUrl(`https://example.com/${'a'.repeat(3000)}`)), 'invalid_url');
  assert.equal(code(() => safe.checkUrl('')), 'invalid_url');
  assert.equal(safe.checkUrl('https://example.com:443/a?b=1#frag').href, 'https://example.com/a?b=1');
  assert.equal(safe.checkUrl('http://example.com:80/').href, 'http://example.com/');
  assert.equal(safe.checkUrl('http://example.com:443/').port, '443'); // the other standard port is allowed
});

test('DNS: a name that resolves to any private address is blocked, without revealing the address', async () => {
  const resolve = async (host) => ({
    'evil.example.com': [{ address: '10.0.0.5', family: 4 }],
    'mixed.example.com': [{ address: PUBLIC, family: 4 }, { address: '127.0.0.1', family: 4 }],
    'v6.example.com': [{ address: '::ffff:169.254.169.254', family: 6 }],
    'ok.example.com': [{ address: PUBLIC, family: 4 }, { address: '2606:4700::1', family: 6 }],
    'empty.example.com': [],
  })[host] || Promise.reject(new Error('ENOTFOUND'));
  for (const host of ['evil.example.com', 'mixed.example.com', 'v6.example.com']) {
    await assert.rejects(safe.resolvePublic(host, { resolve }), (err) => {
      assert.equal(err.code, 'blocked');
      assert.doesNotMatch(err.message, /10\.0\.0\.5|127\.0\.0\.1|169\.254/);
      return true;
    }, host);
  }
  assert.deepEqual(await safe.resolvePublic('ok.example.com', { resolve }), { address: PUBLIC, family: 4 });
  assert.equal(await codeOf(safe.resolvePublic('empty.example.com', { resolve })), 'dns');
  assert.equal(await codeOf(safe.resolvePublic('nx.example.com', { resolve })), 'dns');
  assert.equal(await codeOf(safe.resolvePublic('slow.example.com', { resolve: () => new Promise(() => {}), dnsTimeoutMs: 30 })), 'timeout');
});

test('the pinned lookup always answers with the validated address, in both callback shapes', () => {
  const lookup = safe.pinnedLookup(PUBLIC, 4);
  lookup('anything.example.com', {}, (err, address, family) => { assert.equal(address, PUBLIC); assert.equal(family, 4); });
  lookup('anything.example.com', (err, address) => assert.equal(address, PUBLIC));
  lookup('anything.example.com', { all: true }, (err, list) => assert.deepEqual(list, [{ address: PUBLIC, family: 4 }]));
});

test('the real transport connects to the pinned address, never to what the host name resolves to', async () => {
  const seen = [];
  const server = http.createServer((req, res) => { seen.push({ host: req.headers.host, url: req.url, ua: req.headers['user-agent'] }); res.end('pinned'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    // "pinned.invalid" cannot resolve anywhere: the request only works because the socket goes to the pinned IP.
    const res = await safe.nodeTransport({ url: `http://pinned.invalid:${port}/x?y=1`, address: '127.0.0.1', family: 4, headers: { 'user-agent': safe.USER_AGENT } });
    const body = await safe.readCapped(res.body, undefined, { maxBytes: 100 });
    assert.equal(body.buffer.toString(), 'pinned');
    assert.deepEqual(seen, [{ host: `pinned.invalid:${port}`, url: '/x?y=1', ua: safe.USER_AGENT }]);
    // An aborted signal destroys the request.
    const controller = new AbortController();
    controller.abort(new safe.FetchError('timeout', 'stop'));
    await assert.rejects(safe.nodeTransport({ url: `http://pinned.invalid:${port}/`, address: '127.0.0.1', family: 4, headers: {}, signal: controller.signal }));
  } finally {
    server.close();
  }
});

test('session: every request goes to the validated address; one lookup per host (no DNS rebinding)', async () => {
  let answers = 0;
  const net = fakeNet({ routes: { 'https://site.example.com/a': { body: 'a' }, 'https://site.example.com/b': { body: 'b' } } });
  // A rebinding resolver: public first, private afterwards. The session never asks twice.
  const resolve = async () => (answers++ === 0 ? [{ address: PUBLIC, family: 4 }] : [{ address: '127.0.0.1', family: 4 }]);
  const session = safe.createSession({ resolve, transport: net.transport });
  assert.equal((await session.fetch('https://site.example.com/a')).text, 'a');
  assert.equal((await session.fetch('https://site.example.com/b')).text, 'b');
  session.close();
  assert.equal(answers, 1);
  assert.deepEqual(net.calls.map((c) => c.address), [PUBLIC, PUBLIC]);
  assert.equal(net.calls[0].headers['user-agent'], safe.USER_AGENT);
});

test('redirects: each hop is validated again; private, local, metadata, odd-port and non-http targets are never contacted', async () => {
  const targets = ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://localhost/admin', 'http://[::1]/',
    'http://inside.example.com/', 'file:///etc/passwd', 'http://site.example.com:8080/', 'http://2130706433/'];
  for (const target of targets) {
    const net = fakeNet({
      hosts: { 'site.example.com': PUBLIC, 'inside.example.com': '192.168.1.10' },
      routes: { 'https://site.example.com/': { status: 302, location: target } },
    });
    const session = safe.createSession({ resolve: net.resolve, transport: net.transport });
    await assert.rejects(session.fetch('https://site.example.com/'), (err) => err.code === 'blocked' && /redirect/i.test(err.message), target);
    session.close();
    assert.equal(net.calls.length, 1, `only the first hop was requested for ${target}`);
  }
});

test('redirects: relative and cross-host hops work; more than the maximum fails; maxRedirects 0 returns the Location', async () => {
  const net = fakeNet({
    hosts: { 'a.example.com': PUBLIC, 'b.example.com': '93.184.216.35' },
    routes: {
      'https://a.example.com/': { status: 301, location: '/start' },
      'https://a.example.com/start': { status: 302, location: 'https://b.example.com/end' },
      'https://b.example.com/end': { body: 'done' },
      'https://a.example.com/loop': { status: 302, location: '/loop' },
    },
  });
  const session = safe.createSession({ resolve: net.resolve, transport: net.transport });
  const res = await session.fetch('https://a.example.com/');
  assert.equal(res.text, 'done');
  assert.equal(res.url, 'https://b.example.com/end');
  assert.deepEqual(res.redirects, ['https://a.example.com/start', 'https://b.example.com/end']);
  assert.equal(net.calls[2].address, '93.184.216.35');
  assert.equal(await codeOf(session.fetch('https://a.example.com/loop')), 'too_many_redirects');
  const first = await session.fetch('https://a.example.com/', { maxRedirects: 0 });
  assert.equal(first.status, 301);
  assert.equal(first.location, 'https://a.example.com/start');
  session.close();
});

test('size cap: an endless body is aborted (error, or truncated when asked) and the source stops being read', async () => {
  let pulled = 0;
  const endless = () => Readable.from((function* () { for (;;) { pulled++; yield Buffer.alloc(16 * 1024, 97); } })());
  const net = fakeNet({ hosts: { 'big.example.com': PUBLIC }, routes: { 'https://big.example.com/': { type: 'text/plain', stream: endless } } });
  const session = safe.createSession({ resolve: net.resolve, transport: net.transport });
  assert.equal(await codeOf(session.fetch('https://big.example.com/', { maxBytes: 64 * 1024 })), 'too_large');
  assert.ok(pulled < 20, `stopped early (${pulled} chunks)`);
  pulled = 0;
  const cut = await session.fetch('https://big.example.com/', { maxBytes: 50000, truncate: true });
  assert.equal(cut.truncated, true);
  assert.equal(cut.text.length, 50000);
  assert.ok(pulled < 20);
  session.close();
});

test('size cap applies after decompression (gzip bomb)', async () => {
  const bomb = zlib.gzipSync(Buffer.alloc(5 * 1024 * 1024, 0));
  assert.ok(bomb.length < 10 * 1024);
  const net = fakeNet({ hosts: { 'zip.example.com': PUBLIC }, routes: { 'https://zip.example.com/': { type: 'text/html', headers: { 'content-encoding': 'gzip' }, body: bomb } } });
  const session = safe.createSession({ resolve: net.resolve, transport: net.transport });
  assert.equal(await codeOf(session.fetch('https://zip.example.com/', { maxBytes: 256 * 1024 })), 'too_large');
  const small = fakeNet({ hosts: { 'zip.example.com': PUBLIC }, routes: { 'https://zip.example.com/': { type: 'text/plain', headers: { 'content-encoding': 'gzip' }, body: zlib.gzipSync('hello') } } });
  const s2 = safe.createSession({ resolve: small.resolve, transport: small.transport });
  assert.equal((await s2.fetch('https://zip.example.com/')).text, 'hello');
  session.close();
  s2.close();
});

test('only text-like content types are read', async () => {
  let pulled = 0;
  const net = fakeNet({
    hosts: { 'bin.example.com': PUBLIC },
    routes: { 'https://bin.example.com/': { type: 'application/octet-stream', stream: () => Readable.from((function* () { pulled++; yield Buffer.from('x'); })()) } },
  });
  const session = safe.createSession({ resolve: net.resolve, transport: net.transport });
  const res = await session.fetch('https://bin.example.com/');
  assert.equal(res.skipped, 'not text');
  assert.equal(res.text, '');
  assert.equal(pulled, 0);
  for (const type of ['text/html', 'text/plain', 'application/json', 'application/linkset+json', 'application/ld+json', 'application/xml', 'application/rss+xml', '']) {
    assert.equal(safe.isTextish(type), true, type);
  }
  for (const type of ['image/png', 'application/pdf', 'application/zip', 'video/mp4']) assert.equal(safe.isTextish(type), false, type);
  session.close();
});

test('timeouts: a server that never answers, a body that never ends, and the session deadline', async () => {
  const net = fakeNet({
    hosts: { 'slow.example.com': PUBLIC },
    routes: {
      'https://slow.example.com/hang': { hang: true },
      'https://slow.example.com/drip': { type: 'text/plain', stream: () => new Readable({ read() {} }) },
    },
  });
  const session = safe.createSession({ resolve: net.resolve, transport: net.transport });
  let started = Date.now();
  assert.equal(await codeOf(session.fetch('https://slow.example.com/hang', { timeoutMs: 50 })), 'timeout');
  assert.ok(Date.now() - started < 1000);
  started = Date.now();
  assert.equal(await codeOf(session.fetch('https://slow.example.com/drip', { timeoutMs: 50 })), 'timeout');
  assert.ok(Date.now() - started < 1000);
  session.close();
  const short = safe.createSession({ resolve: net.resolve, transport: net.transport, deadlineMs: 60 });
  assert.equal(await codeOf(short.fetch('https://slow.example.com/hang', { timeoutMs: 5000 })), 'aborted');
  assert.equal(await codeOf(short.fetch('https://slow.example.com/drip')), 'aborted');
  short.close();
});

test('request budget: redirects count, and nothing is sent once it is used up', async () => {
  const net = fakeNet({ hosts: { 'b.example.com': PUBLIC }, routes: { 'https://b.example.com/r': { status: 302, location: '/ok' }, 'https://b.example.com/ok': { body: 'ok' } } });
  const session = safe.createSession({ resolve: net.resolve, transport: net.transport, maxRequests: 3 });
  await session.fetch('https://b.example.com/r'); // 2 requests
  await session.fetch('https://b.example.com/ok'); // 3
  assert.equal(await codeOf(session.fetch('https://b.example.com/ok')), 'budget');
  assert.equal(net.calls.length, 3);
  assert.equal(session.requests, 3);
  session.close();
});

test('a transport failure becomes a generic network error (no internal details)', async () => {
  const session = safe.createSession({ resolve: async () => [{ address: PUBLIC, family: 4 }], transport: async () => { throw new Error('ECONNREFUSED 93.184.216.34:443 secret-internal-detail'); } });
  await assert.rejects(session.fetch('https://down.example.com/'), (err) => err.code === 'network' && !/secret|ECONN/.test(err.message));
  session.close();
});
