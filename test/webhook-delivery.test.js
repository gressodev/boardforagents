// Webhook delivery: after a notice or reply is saved, matching subscriptions get a signed POST in the
// background. Posting never depends on it. Fake DNS and transport only.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { call, auth, mcp, reset, post, subscriptions, fakeNet, answer, echo } = require('./helpers');

const DNS = { 'a.example.com': ['93.184.216.34'], 'b.example.com': ['93.184.216.35'], 'c.example.com': ['2606:4700::6810:1'] };
const subscribe = async (body) => {
  const r = await call('POST', '/api/subscriptions', { body });
  assert.equal(r.status, 201, r.text);
  return r.json;
};
const deliveries = (requests, host) => requests.filter((r) => r.json && r.json.event && (!host || r.host === host));
const verifySignature = (secret, req) => {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.body).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['X-Board-Signature']));
};
const status = async (sub) => (await call('GET', `/api/subscriptions/${sub.id}`, { headers: auth(sub.delete_token) })).json;
const LIMITS = { ...subscriptions.LIMITS };

beforeEach(() => reset());
afterEach(() => {
  Object.assign(subscriptions.LIMITS, LIMITS);
  delete process.env.SUBSCRIPTION_PEPPER;
});

test('a new notice is POSTed, signed, to matching subscriptions only', async () => {
  const requests = fakeNet({ dns: DNS, handlers: { 'a.example.com': echo, 'b.example.com': echo, 'c.example.com': echo } });
  const offers = await subscribe({ url: 'https://a.example.com/hook', category: 'offer', tag: 'gpu' });
  const all = await subscribe({ url: 'https://b.example.com/hook' });
  const other = await subscribe({ url: 'https://c.example.com/hook', agent: 'someone-else' });

  const created = await post({ agent: 'seller', category: 'offer', tags: ['GPU', 'ml'], title: 'GPU time', body: 'Cheap' });
  assert.equal(created.status, 201);
  await subscriptions.idle();

  const toA = deliveries(requests, 'a.example.com');
  assert.equal(toA.length, 1);
  const [d] = toA;
  assert.equal(d.url, 'https://a.example.com/hook');
  assert.equal(d.address, '93.184.216.34');
  assert.equal(d.headers['Content-Type'], 'application/json');
  assert.match(d.headers['User-Agent'], /^AgentBoard-Webhooks\//);
  assert.equal(d.headers['X-Board-Event'], 'notice.created');
  assert.equal(d.headers['X-Board-Subscription'], offers.id);
  assert.equal(d.headers['X-Board-Delivery'], d.json.delivery_id);
  assert.match(d.headers['X-Board-Signature'], /^sha256=[0-9a-f]{64}$/);
  assert.ok(verifySignature(offers.secret, d), 'HMAC-SHA256 of the raw body with the secret');
  assert.ok(!verifySignature(all.secret, d), 'another subscription\'s secret does not verify');
  assert.equal(d.json.event, 'notice.created');
  assert.equal(d.json.subscription_id, offers.id);
  assert.equal(d.json.board, 'https://localhost');
  assert.equal(d.json.reply, undefined);
  assert.deepEqual(Object.keys(d.json.notice).sort(),
    ['agent', 'body', 'category', 'contact', 'created_at', 'expires_at', 'id', 'reply_count', 'tags', 'title', 'url']);
  assert.equal(d.json.notice.id, created.json.id);
  assert.equal(d.json.notice.url, `https://localhost/p/${created.json.id}`);
  assert.match(d.json.note, /untrusted/);
  // Never the delete_token, hashes or ledger data.
  assert.ok(!d.body.includes(created.json.delete_token));
  assert.ok(!/delete_token|key_hash|post_log|"ip"/.test(d.body));

  assert.equal(deliveries(requests, 'b.example.com').length, 1, 'the unfiltered subscription gets every notice');
  assert.equal(deliveries(requests, 'c.example.com').length, 0, 'a non-matching agent filter gets nothing');

  // Non-matching category and tag.
  await post({ agent: 'asker', category: 'request', tags: ['gpu'] });
  await post({ agent: 'seller2', category: 'offer', tags: ['cpu'] });
  await subscriptions.idle();
  assert.equal(deliveries(requests, 'a.example.com').length, 1);
  assert.equal(deliveries(requests, 'b.example.com').length, 3);
  assert.equal((await status(offers)).last_success_at !== undefined, true);
});

test('MCP create_post and reply_to_post deliver too', async () => {
  const requests = fakeNet({ dns: DNS, handlers: { 'a.example.com': echo } });
  const mine = await subscribe({ url: 'https://a.example.com/hook', agent: 'mcp-agent' });
  const created = await mcp('create_post', { agent: 'mcp-agent', title: 'Via MCP', body: 'Hello' });
  assert.equal(created.isError, false, created.text);
  await mcp('reply_to_post', { id: created.data.id, agent: 'friend', body: 'Hi back' });
  await subscriptions.idle();
  const got = deliveries(requests);
  assert.deepEqual(got.map((d) => d.json.event), ['notice.created', 'reply.created']);
  assert.ok(got.every((d) => verifySignature(mine.secret, d)));
  assert.ok(!got[0].body.includes(created.data.delete_token));
});

test('replies go only to subscriptions that filter on the notice\'s agent', async () => {
  const requests = fakeNet({ dns: DNS, handlers: { 'a.example.com': echo, 'b.example.com': echo, 'c.example.com': echo } });
  const mine = await subscribe({ url: 'https://a.example.com/hook', agent: 'Me' });
  await subscribe({ url: 'https://b.example.com/hook' }); // unfiltered: new notices only
  await subscribe({ url: 'https://c.example.com/hook', agent: 'them' });
  const notice = (await post({ agent: 'me', title: 'My question' })).json;
  const theirs = (await post({ agent: 'them', title: 'Their notice' })).json;
  await subscriptions.idle();
  requests.length = 0;

  const r = await call('POST', `/api/posts/${notice.id}/replies`, { body: { agent: 'helper', body: 'Here is an answer' } });
  assert.equal(r.status, 201);
  assert.equal(r.json.body, 'Here is an answer');
  assert.equal(r.json.notice, undefined, 'the REST answer is still just the reply');
  await subscriptions.idle();
  const got = deliveries(requests);
  assert.equal(got.length, 1);
  assert.equal(got[0].host, 'a.example.com');
  assert.equal(got[0].json.event, 'reply.created');
  assert.equal(got[0].headers['X-Board-Event'], 'reply.created');
  assert.equal(got[0].json.notice.id, notice.id);
  assert.equal(got[0].json.notice.reply_count, 1);
  assert.equal(got[0].json.notice.replies, undefined, 'the thread itself is not sent');
  assert.deepEqual(got[0].json.reply, { id: r.json.id, agent: 'helper', body: 'Here is an answer', created_at: r.json.created_at });
  assert.ok(verifySignature(mine.secret, got[0]));

  requests.length = 0;
  await call('POST', `/api/posts/${theirs.id}/replies`, { body: { agent: 'helper', body: 'Another' } });
  await subscriptions.idle();
  assert.deepEqual(deliveries(requests).map((d) => d.host), ['c.example.com']);
});

test('posting succeeds when delivery fails, and the failure is recorded', async () => {
  const requests = fakeNet({
    dns: { ...DNS },
    handlers: {
      'a.example.com': (req) => (req.json.type === 'subscription_challenge' ? echo(req) : answer(500)),
      'b.example.com': (req) => (req.json.type === 'subscription_challenge' ? echo(req) : Promise.reject(new Error('ECONNRESET'))),
      'c.example.com': (req) => (req.json.type === 'subscription_challenge' ? echo(req) : new Promise(() => {})),
    },
  });
  subscriptions.LIMITS.deliveryTimeoutMs = 30;
  const subs = [];
  for (const host of ['a', 'b', 'c']) subs.push(await subscribe({ url: `https://${host}.example.com/hook` }));
  const created = await post({ agent: 'unlucky', title: 'Still posted' });
  assert.equal(created.status, 201);
  assert.ok(created.json.delete_token);
  assert.equal((await call('GET', `/api/posts/${created.json.id}`)).status, 200);
  await subscriptions.idle();
  assert.equal(deliveries(requests).length, 3);
  const states = await Promise.all(subs.map(status));
  assert.deepEqual(states.map((s) => s.last_error), ['http_500', 'network', 'timeout']);
  assert.ok(states.every((s) => s.consecutive_failures === 1 && s.enabled));
});

test('a delivery is refused when the name now resolves to a private address (rebinding)', async () => {
  let addresses = ['93.184.216.34'];
  const requests = fakeNet({ dns: { 'a.example.com': () => addresses }, handlers: { 'a.example.com': echo } });
  const sub = await subscribe({ url: 'https://a.example.com/hook' });
  addresses = ['169.254.169.254'];
  await post({ agent: 'poster' });
  await subscriptions.idle();
  assert.equal(deliveries(requests).length, 0, 'no connection');
  assert.equal((await status(sub)).last_error, 'blocked_address');
  addresses = ['::ffff:10.0.0.1'];
  await post({ agent: 'poster-2' });
  await subscriptions.idle();
  assert.equal(deliveries(requests).length, 0);
  assert.equal((await status(sub)).consecutive_failures, 2);
});

test(`after ${LIMITS.maxFailures} failures in a row the subscription is disabled; a success resets the count`, async () => {
  let healthy = true;
  const requests = fakeNet({
    dns: DNS,
    handlers: { 'a.example.com': (req) => (req.json.type === 'subscription_challenge' || healthy ? echo(req) : answer(503)) },
  });
  const sub = await subscribe({ url: 'https://a.example.com/hook' });
  let n = 0;
  const notice = async () => { assert.equal((await post({ agent: `agent-${n++}` })).status, 201); await subscriptions.idle(); };

  healthy = false;
  for (let i = 0; i < LIMITS.maxFailures - 1; i++) await notice();
  assert.equal((await status(sub)).consecutive_failures, LIMITS.maxFailures - 1);
  healthy = true;
  await notice();
  assert.equal((await status(sub)).consecutive_failures, 0, 'a success resets the count');

  healthy = false;
  for (let i = 0; i < LIMITS.maxFailures; i++) await notice();
  const disabled = await status(sub);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.consecutive_failures, LIMITS.maxFailures);
  assert.ok(disabled.disabled_at);
  const count = deliveries(requests).length;
  healthy = true;
  await notice();
  assert.equal(deliveries(requests).length, count, 'a disabled subscription gets nothing');
  // It no longer counts toward the caps, and can be deleted.
  assert.equal((await call('DELETE', `/api/subscriptions/${sub.id}`, { headers: auth(sub.delete_token) })).status, 200);
});

test('SUBSCRIPTION_PEPPER: the secret is derived from it, never stored, and old subscriptions keep their secret', async () => {
  const requests = fakeNet({ dns: DNS, handlers: { 'a.example.com': echo, 'b.example.com': echo } });
  const before = await subscribe({ url: 'https://a.example.com/hook' }); // built-in pepper
  process.env.SUBSCRIPTION_PEPPER = 'test-only-pepper';
  const after = await subscribe({ url: 'https://b.example.com/hook' });
  assert.notEqual(before.secret, after.secret);
  const doc = JSON.stringify(await subscriptions.store.read());
  assert.ok(!doc.includes(before.secret) && !doc.includes(after.secret) && !doc.includes('test-only-pepper'));
  await post({ agent: 'pepper-1' });
  await subscriptions.idle();
  const [toA] = deliveries(requests, 'a.example.com');
  const [toB] = deliveries(requests, 'b.example.com');
  assert.ok(verifySignature(before.secret, toA), 'setting the variable later does not change older secrets');
  assert.ok(verifySignature(after.secret, toB));
  // If the variable disappears, subscriptions made with it cannot be signed, so they are not delivered.
  delete process.env.SUBSCRIPTION_PEPPER;
  requests.length = 0;
  await post({ agent: 'pepper-2' });
  await subscriptions.idle();
  assert.deepEqual(deliveries(requests).map((d) => d.host), ['a.example.com']);
  assert.equal((await status(after)).last_error, 'no_secret');
});

test('hidden notices do not trigger reply deliveries', async () => {
  const requests = fakeNet({ dns: DNS, handlers: { 'a.example.com': echo } });
  await subscribe({ url: 'https://a.example.com/hook', agent: 'spammer' });
  const notice = (await post({ agent: 'spammer' })).json;
  await subscriptions.idle();
  const { store } = require('./helpers');
  await store.update((data) => { data.posts.find((p) => p.id === notice.id).ai = { verdict: 'spam' }; });
  requests.length = 0;
  await call('POST', `/api/posts/${notice.id}/replies`, { body: { agent: 'x', body: 'y' } });
  await subscriptions.idle();
  assert.equal(deliveries(requests).length, 0);
});

test('preview deployments never deliver, even if asked directly', async () => {
  const requests = fakeNet({ dns: DNS, handlers: { 'a.example.com': echo } });
  await subscribe({ url: 'https://a.example.com/hook' });
  const notice = (await post({ agent: 'previewed' })).json;
  await subscriptions.idle();
  requests.length = 0;
  process.env.VERCEL_ENV = 'preview';
  try {
    await subscriptions.deliver('notice.created', notice, null, 'https://localhost');
    assert.equal((await call('POST', `/api/posts/${notice.id}/replies`, { body: { agent: 'x', body: 'y' } })).status, 403);
  } finally {
    delete process.env.VERCEL_ENV;
  }
  await subscriptions.idle();
  assert.equal(requests.length, 0);
});
