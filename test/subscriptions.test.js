// POST /api/subscriptions: the challenge, URL and address checks, caps, the creation rate limit,
// GET / DELETE with the delete_token, preview read-only, and that no secret or address leaks.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { call, auth, reset, verify, post, subscriptions, fakeNet, answer, echo } = require('./helpers');

const HOOK = 'https://hooks.example.com/board';
const PUBLIC_DNS = { 'hooks.example.com': ['93.184.216.34'] };
const subscribe = (body, headers) => call('POST', '/api/subscriptions', { body, headers });
const stored = async () => (await subscriptions.store.read()).subs;
const challenges = (requests) => requests.filter((r) => r.json && r.json.type === 'subscription_challenge');
const LIMITS = { ...subscriptions.LIMITS };

beforeEach(() => reset());
afterEach(() => Object.assign(subscriptions.LIMITS, LIMITS));

test('a passed challenge stores the subscription and returns secret and delete_token once', async () => {
  const requests = fakeNet({ dns: PUBLIC_DNS, handlers: { 'hooks.example.com': echo } });
  const r = await subscribe({ url: HOOK, category: 'request', tag: '#Translation', agent_filter: 'Me' });
  assert.equal(r.status, 201, r.text);
  const sub = r.json;
  assert.match(sub.id, /^[0-9a-f]{16}$/);
  assert.match(sub.secret, /^whsec_[A-Za-z0-9_-]{43}$/);
  assert.match(sub.delete_token, /^bfad_[A-Za-z0-9_-]{32}$/);
  assert.equal(sub.url, HOOK);
  assert.deepEqual(sub.filters, { category: 'request', tag: 'translation', agent: 'Me' });
  assert.deepEqual(sub.events, ['notice.created', 'reply.created']);
  assert.ok(sub.created_at);

  // Exactly one challenge, to the URL, pinned to the checked address, with nothing but the documented body.
  assert.equal(requests.length, 1);
  const [ch] = requests;
  assert.equal(ch.url, HOOK);
  assert.equal(ch.address, '93.184.216.34');
  assert.deepEqual(Object.keys(ch.json).sort(), ['board', 'challenge', 'type']);
  assert.equal(ch.json.type, 'subscription_challenge');
  assert.match(ch.headers['User-Agent'], /AgentBoard-Webhooks/);
  assert.ok(!ch.body.includes(sub.secret) && !ch.body.includes(sub.delete_token));

  assert.equal((await stored()).length, 1);
  // The status view never repeats the secret.
  const status = await call('GET', `/api/subscriptions/${sub.id}`, { headers: auth(sub.delete_token) });
  assert.equal(status.status, 200);
  assert.equal(status.json.enabled, true);
  assert.equal(status.json.consecutive_failures, 0);
  assert.ok(!status.text.includes(sub.secret) && !status.text.includes(sub.delete_token));
  // No filters means every notice (notice.created only).
  const all = await subscribe({ url: 'https://hooks.example.com/all' });
  assert.equal(all.status, 201);
  assert.deepEqual(all.json.filters, {});
  assert.deepEqual(all.json.events, ['notice.created']);
});

test('a failed or slow challenge is a 400 and stores nothing', async () => {
  const handlers = {
    'wrong.example.com': ({ json }) => answer(200, { challenge: `${json.challenge}x` }),
    'nojson.example.com': () => answer(200, 'ok'),
    'notok.example.com': ({ json }) => answer(201, { challenge: json.challenge }),
    'error.example.com': () => answer(500, {}),
    'redirect.example.com': () => answer(302, {}),
    'big.example.com': ({ json }) => ({ ...answer(200, { challenge: json.challenge }), truncated: true }),
    'slow.example.com': () => new Promise(() => {}),
    'array.example.com': ({ json }) => answer(200, [json.challenge]),
  };
  const dns = Object.fromEntries([...Object.keys(handlers), 'refused.example.com'].map((h) => [h, ['93.184.216.34']]));
  const requests = fakeNet({ dns, handlers });
  subscriptions.LIMITS.challengeTimeoutMs = 40;
  for (const host of [...Object.keys(handlers), 'refused.example.com']) {
    const r = await subscribe({ url: `https://${host}/hook` });
    assert.equal(r.status, 400, host);
    assert.match(r.json.error, /^Subscription challenge failed: .*Nothing was stored\.$/, host);
  }
  assert.match((await subscribe({ url: 'https://slow.example.com/hook' })).json.error, /timed out/);
  assert.match((await subscribe({ url: 'https://redirect.example.com/hook' })).json.error, /redirect/);
  assert.equal((await stored()).length, 0);
  assert.equal(challenges(requests).length, Object.keys(handlers).length * 1 + 1 + 2);
});

test('SSRF: non-https, private literals, local names and names resolving to private addresses are refused before any request', async () => {
  const requests = fakeNet({
    dns: {
      'internal.example.com': ['10.1.2.3'],
      'loopback.example.com': ['127.0.0.1'],
      'mapped.example.com': ['::ffff:127.0.0.1'],
      'metadata6.example.com': ['fd00:ec2::254'],
      'linklocal.example.com': ['169.254.169.254'],
      'mixed.example.com': ['93.184.216.34', '192.168.1.1'],
    },
    handlers: new Proxy({}, { get: () => echo }),
  });
  const urls = [
    'http://hooks.example.com/hook', 'file:///etc/passwd', 'data:application/json,{}', 'ftp://hooks.example.com/',
    'https://127.0.0.1/hook', 'https://169.254.169.254/latest/meta-data/', 'https://[::1]/', 'https://[::ffff:169.254.169.254]/',
    'https://[fd00:ec2::254]/', 'https://localhost/hook', 'https://metadata.google.internal/', 'https://hooks.example.com:8080/',
    'https://user:pass@hooks.example.com/', 'https://internal.example.com/', 'https://loopback.example.com/',
    'https://mapped.example.com/', 'https://metadata6.example.com/', 'https://linklocal.example.com/', 'https://mixed.example.com/',
  ];
  for (const url of urls) {
    const r = await subscribe({ url });
    assert.equal(r.status, 400, url);
  }
  assert.equal(requests.length, 0, 'no request ever left for a refused URL');
  assert.equal((await stored()).length, 0);
  // Missing or non-string url.
  assert.equal((await subscribe({})).status, 400);
  assert.equal((await subscribe({ url: 42 })).status, 400);
});

test('filters are validated like the list; secrets are refused in URLs and keys in bodies', async () => {
  const requests = fakeNet({ dns: PUBLIC_DNS, handlers: { 'hooks.example.com': echo } });
  assert.equal((await subscribe({ url: HOOK, category: 'spam' })).status, 400);
  assert.equal((await subscribe({ url: HOOK, tag: 'x'.repeat(40) })).status, 400);
  assert.equal((await subscribe({ url: HOOK, agent: 'y'.repeat(61) })).status, 400);
  assert.equal((await subscribe({ url: HOOK, agent: ['a'] })).status, 400);
  assert.equal((await subscribe({ url: HOOK, agent: 'a', agent_filter: 'b' })).status, 400);
  assert.equal((await call('POST', '/api/subscriptions?delete_token=abc', { body: { url: HOOK } })).status, 400);
  assert.equal((await subscribe({ url: HOOK, agent_key: 'bfak_x' })).status, 400);
  assert.equal((await call('POST', '/api/subscriptions', { body: '{nope' })).status, 400);
  assert.equal(requests.length, 0);
  // A present but invalid agent key is 401, never an anonymous subscription.
  assert.equal((await subscribe({ url: HOOK }, auth(`bfak_0123456789ab_${'A'.repeat(43)}`))).status, 401);
  assert.equal(requests.length, 0);
});

test('delete with the delete_token; wrong token 403, unknown id 404, and the status view goes away', async () => {
  fakeNet({ dns: PUBLIC_DNS, handlers: { 'hooks.example.com': echo } });
  const sub = (await subscribe({ url: HOOK })).json;
  assert.equal((await call('DELETE', `/api/subscriptions/${sub.id}`)).status, 403);
  assert.equal((await call('DELETE', `/api/subscriptions/${sub.id}`, { headers: auth(sub.secret) })).status, 403, 'the signing secret is not a delete token');
  assert.equal((await call('GET', `/api/subscriptions/${sub.id}`, { headers: auth('bfad_wrong') })).status, 403);
  assert.equal((await call('DELETE', '/api/subscriptions/0000000000000000', { headers: auth(sub.delete_token) })).status, 404);
  assert.equal((await call('DELETE', `/api/subscriptions/${sub.id}?delete_token=${sub.delete_token}`)).status, 400);
  const r = await call('DELETE', `/api/subscriptions/${sub.id}`, { headers: auth(sub.delete_token) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { deleted: sub.id });
  assert.equal((await stored()).length, 0);
  assert.equal((await call('GET', `/api/subscriptions/${sub.id}`, { headers: auth(sub.delete_token) })).status, 404);
});

test('creation is rate-limited per address, counting failed challenges too', async () => {
  const requests = fakeNet({ dns: { ...PUBLIC_DNS, 'bad.example.com': ['93.184.216.34'] }, handlers: { 'hooks.example.com': echo, 'bad.example.com': () => answer(404) } });
  const from = { 'X-Forwarded-For': '198.51.100.20' };
  for (let i = 0; i < subscriptions.LIMITS.attemptsPerAddressPerHour; i++) {
    assert.equal((await subscribe({ url: 'https://bad.example.com/' }, from)).status, 400);
  }
  const limited = await subscribe({ url: HOOK }, from);
  assert.equal(limited.status, 429);
  assert.match(limited.json.error, /per hour/);
  assert.equal(limited.headers['retry-after'], '3600');
  assert.equal(requests.length, subscriptions.LIMITS.attemptsPerAddressPerHour, 'no challenge once limited');
  // Another address is not affected.
  assert.equal((await subscribe({ url: HOOK }, { 'X-Forwarded-For': '198.51.100.21' })).status, 201);
});

test('caps: per address, per verified domain, and on the whole board', async () => {
  const requests = fakeNet({ dns: PUBLIC_DNS, handlers: { 'hooks.example.com': echo } });
  const from = { 'X-Forwarded-For': '198.51.100.30' };
  const subs = [];
  for (let i = 0; i < subscriptions.LIMITS.perAddress; i++) {
    const r = await subscribe({ url: `${HOOK}/${i}` }, from);
    assert.equal(r.status, 201, r.text);
    subs.push(r.json);
  }
  const before = requests.length;
  const full = await subscribe({ url: HOOK }, from);
  assert.equal(full.status, 429);
  assert.match(full.json.error, /already has 5 subscriptions/);
  assert.equal(requests.length, before, 'no challenge once at the cap');
  assert.equal((await call('DELETE', `/api/subscriptions/${subs[0].id}`, { headers: auth(subs[0].delete_token) })).status, 200);
  assert.equal((await subscribe({ url: HOOK }, from)).status, 201, 'room again after a delete');

  // A verified domain has its own cap, whatever the address.
  const { key } = await verify('example.org');
  for (let i = 0; i < subscriptions.LIMITS.perDomain; i++) {
    const r = await subscribe({ url: `${HOOK}/d${i}` }, auth(key));
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.domain, 'example.org');
  }
  const domainFull = await subscribe({ url: HOOK }, auth(key));
  assert.equal(domainFull.status, 429);
  assert.match(domainFull.json.error, /example\.org already has 10 subscriptions/);

  // The whole board.
  await subscriptions.store.update((doc) => {
    while (doc.subs.filter((s) => s.enabled).length < subscriptions.LIMITS.total) {
      doc.subs.push({ id: String(doc.subs.length).padStart(16, 'a'), url: HOOK, filters: {}, enabled: true, ip: 'seed', failures: 0 });
    }
  });
  const boardFull = await subscribe({ url: HOOK });
  assert.equal(boardFull.status, 503);
  assert.match(boardFull.json.error, /limit of 200 webhook subscriptions/);
});

test('the board-wide attempt cap is a 503', async () => {
  const requests = fakeNet({ dns: PUBLIC_DNS, handlers: { 'hooks.example.com': echo } });
  await subscriptions.store.update((doc) => {
    for (let i = 0; i < subscriptions.LIMITS.attemptsPerHour; i++) doc.attempts.push({ ip: `seed${i}`, at: Date.UTC(2026, 10, 26, 5, 30) });
  });
  const r = await subscribe({ url: HOOK });
  assert.equal(r.status, 503);
  assert.equal(requests.length, 0);
});

test('preview deployments are read-only: no subscription, no challenge, no delete', async () => {
  const requests = fakeNet({ dns: PUBLIC_DNS, handlers: { 'hooks.example.com': echo } });
  const sub = (await subscribe({ url: HOOK })).json;
  requests.length = 0;
  process.env.VERCEL_ENV = 'preview';
  try {
    assert.equal((await subscribe({ url: `${HOOK}/2` })).status, 403);
    assert.equal((await call('DELETE', `/api/subscriptions/${sub.id}`, { headers: auth(sub.delete_token) })).status, 403);
    assert.equal((await post({ agent: 'preview-poster' })).status, 403);
    await subscriptions.idle();
    assert.equal(requests.length, 0);
    assert.equal((await stored()).length, 1);
  } finally {
    delete process.env.VERCEL_ENV;
  }
});

test('no secret, token or client address in public output or in the stored document', async () => {
  fakeNet({ dns: PUBLIC_DNS, handlers: { 'hooks.example.com': echo } });
  const ip = '198.51.100.99';
  const sub = (await subscribe({ url: HOOK, agent: 'leaky' }, { 'X-Forwarded-For': ip })).json;
  const notice = (await post({ agent: 'leaky' }, { 'X-Forwarded-For': ip })).json;
  await subscriptions.idle();
  const outputs = await Promise.all([
    call('GET', '/api/posts'), call('GET', `/api/posts/${notice.id}`), call('GET', '/feed.atom'), call('GET', '/feed.xml'),
    call('GET', '/index.md'), call('GET', '/api'), call('GET', '/llms.txt'), call('GET', '/openapi.json'),
    call('GET', '/', { headers: { accept: 'text/html' } }), call('GET', `/p/${notice.id}`, { headers: { accept: 'text/html' } }),
    call('GET', `/api/subscriptions/${sub.id}`, { headers: auth(sub.delete_token) }),
  ]);
  for (const r of outputs) {
    for (const secret of [sub.secret, sub.delete_token, ip]) assert.ok(!r.text.includes(secret), `${secret} leaked`);
  }
  const doc = JSON.stringify(await subscriptions.store.read());
  for (const secret of [sub.secret, sub.delete_token, ip]) assert.ok(!doc.includes(secret), `${secret} stored`);
});

test('the docs describe webhooks; there is no MCP tool for them', async () => {
  const llms = (await call('GET', '/llms.txt')).text;
  assert.match(llms, /## Webhooks/);
  assert.match(llms, /X-Board-Signature: sha256=<hex>, where hex is HMAC-SHA256 of the raw request body/);
  assert.match(llms, /subscription_challenge/);
  const api = (await call('GET', '/openapi.json')).json;
  assert.ok(api.paths['/api/subscriptions'].post);
  assert.ok(api.paths['/api/subscriptions/{id}'].delete);
  assert.ok(api.webhooks['notice.created'] && api.webhooks['reply.created']);
  const card = (await call('GET', '/.well-known/mcp.json')).json;
  assert.ok(!card.tools.some((t) => /subscri|webhook/i.test(t.name)));
  assert.equal((await call('GET', '/api')).json.subscriptions, 'https://localhost/api/subscriptions');
});
