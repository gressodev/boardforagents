// 2. Key auth over REST and MCP, claims, key management, deleting with a key, public status.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { call, auth, mcp, reset, verify, post, advance, dns, HOUR } = require('./helpers');

const ANON_KEYS = ['id', 'category', 'title', 'body', 'agent', 'contact', 'tags', 'created_at', 'expires_at', 'replies', 'delete_token'];
const VERIFIED = { domain: 'example.com', method: 'dns-txt', status: 'active' };
const fakeKey = (id = '0123456789ab') => `bfak_${id}_${'A'.repeat(43)}`;
const count = async () => (await call('GET', '/api/posts?limit=500')).json.count;

beforeEach(() => reset());

test('a valid key verifies a post and a reply; the snapshot is { domain, method, status }', async () => {
  const { key, check } = await verify('example.com');
  assert.match(key, /^bfak_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
  assert.equal(check.domain, 'example.com');
  assert.equal(check.status, 'active');
  const created = await post({ agent: 'research-bot' }, auth(key));
  assert.equal(created.status, 201);
  assert.deepEqual(created.json.verified, VERIFIED);
  assert.ok(created.json.delete_token, 'verified posts still receive a delete_token');
  const reply = await call('POST', `/api/posts/${created.json.id}/replies`, { body: { agent: 'helper', body: 'hi' }, headers: auth(key) });
  assert.equal(reply.status, 201);
  assert.deepEqual(reply.json.verified, VERIFIED);
  const got = await call('GET', `/api/posts/${created.json.id}`);
  assert.deepEqual(got.json.verified, VERIFIED);
  assert.deepEqual(got.json.replies[0].verified, VERIFIED);
});

test('no key: anonymous, with exactly today\'s JSON shape', async () => {
  await verify('example.com');
  const created = await post({ agent: 'someone' });
  assert.equal(created.status, 201);
  assert.deepEqual(Object.keys(created.json), ANON_KEYS);
  const reply = await call('POST', `/api/posts/${created.json.id}/replies`, { body: { agent: 'x', body: 'y' } });
  assert.deepEqual(Object.keys(reply.json), ['id', 'agent', 'body', 'created_at']);
  // A non-board bearer token on a post is ignored, as before.
  assert.equal((await post({ agent: 'other' }, auth('some-oauth-token'))).status, 201);
});

test('an invalid, malformed or revoked key is 401 and never an anonymous post', async () => {
  const { key } = await verify('example.com');
  const before = await count();
  for (const bad of [fakeKey(), 'bfak_nope', `${key.slice(0, -1)}${key.endsWith('A') ? 'B' : 'A'}`]) {
    const r = await post({ agent: 'x' }, auth(bad));
    assert.equal(r.status, 401, bad);
    assert.equal(r.headers['www-authenticate'], 'Bearer');
  }
  // Revoke a second key, then use it.
  const second = await call('POST', '/api/agents/example.com/keys', { body: { label: 'second' }, headers: auth(key) });
  assert.equal(second.status, 201);
  assert.equal((await post({ agent: 'x' }, auth(second.json.agent_key))).status, 201);
  const revoked = await call('DELETE', `/api/agents/example.com/keys/${second.json.key_id}`, { headers: auth(key) });
  assert.equal(revoked.status, 200);
  const r = await post({ agent: 'x' }, auth(second.json.agent_key));
  assert.equal(r.status, 401);
  assert.match(r.json.error, /revoked/);
  const reply = await call('POST', '/api/posts/doesnotexist/replies', { body: { agent: 'x', body: 'y' }, headers: auth(fakeKey()) });
  assert.equal(reply.status, 401);
  assert.equal(await count(), before + 1);
});

test('MCP: agent_key argument and Authorization header both work; a bad agent_key is an error', async () => {
  const { key } = await verify('example.com');
  const list = await call('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  const create = list.json.result.tools.find((t) => t.name === 'create_post');
  assert.ok(create.inputSchema.properties.agent_key);
  const viaArg = await mcp('create_post', { agent: 'mcp-bot', title: 't', body: 'b', agent_key: key });
  assert.equal(viaArg.isError, false, viaArg.text);
  assert.deepEqual(viaArg.data.verified, VERIFIED);
  const viaHeader = await mcp('create_post', { agent: 'mcp-bot', title: 't', body: 'b' }, auth(key));
  assert.deepEqual(viaHeader.data.verified, VERIFIED);
  const reply = await mcp('reply_to_post', { id: viaArg.data.id, agent: 'mcp-bot', body: 'r', agent_key: key });
  assert.deepEqual(reply.data.verified, VERIFIED);
  const before = await count();
  const bad = await mcp('create_post', { agent: 'mcp-bot', title: 't', body: 'b', agent_key: fakeKey() });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Invalid agent key/);
  const garbage = await mcp('create_post', { agent: 'mcp-bot', title: 't', body: 'b', agent_key: 'not-a-key' });
  assert.equal(garbage.isError, true);
  assert.equal(await count(), before);
  const anon = await mcp('create_post', { agent: 'anon', title: 't', body: 'b' });
  assert.equal(anon.data.verified, undefined);
  // delete_post with the key in the header, no delete_token
  const del = await mcp('delete_post', { id: viaArg.data.id }, auth(key));
  assert.equal(del.isError, false, del.text);
});

test('keys in the query string or JSON body are rejected', async () => {
  const { key } = await verify('example.com');
  const before = await count();
  assert.equal((await call('POST', `/api/posts?agent_key=${key}`, { body: { agent: 'a', title: 't', body: 'b' } })).status, 400);
  assert.equal((await call('POST', `/api/posts?token=${key}`, { body: { agent: 'a', title: 't', body: 'b' } })).status, 400);
  assert.equal((await post({ agent: 'a', agent_key: key })).status, 400);
  const created = await post({ agent: 'a' }, auth(key));
  assert.equal((await call('DELETE', `/api/posts/${created.json.id}?delete_token=${key}`)).status, 400);
  assert.equal((await call('POST', `/api/agents/example.com/keys?agent_key=${key}`, { body: {} })).status, 400);
  assert.equal(await count(), before + 1);
});

test('an agent key deletes any post of its domain, and only those', async () => {
  const { key } = await verify('example.com');
  const other = await verify('other.example.org');
  const mine = await post({ agent: 'a' }, auth(key));
  const theirs = await post({ agent: 'b' }, auth(other.key));
  const anon = await post({ agent: 'c' });
  assert.equal((await call('DELETE', `/api/posts/${theirs.json.id}`, { headers: auth(key) })).status, 403);
  assert.equal((await call('DELETE', `/api/posts/${anon.json.id}`, { headers: auth(key) })).status, 403);
  assert.equal((await call('DELETE', `/api/posts/${mine.json.id}`, { headers: auth(fakeKey()) })).status, 401);
  assert.equal((await call('DELETE', `/api/posts/${mine.json.id}`, { headers: auth(key) })).status, 200);
  // the delete_token still works for verified posts
  assert.equal((await call('DELETE', `/api/posts/${theirs.json.id}`, { headers: auth(theirs.json.delete_token) })).status, 200);
  assert.equal((await call('DELETE', `/api/posts/${anon.json.id}`, { headers: auth(anon.json.delete_token) })).status, 200);
});

test('named keys: up to 5, a key of another domain cannot manage them', async () => {
  const { key } = await verify('example.com');
  const other = await verify('example.net');
  for (let i = 2; i <= 5; i++) {
    const r = await call('POST', '/api/agents/example.com/keys', { body: { label: `bot-${i}` }, headers: auth(key) });
    assert.equal(r.status, 201);
    assert.equal(r.json.label, `bot-${i}`);
  }
  assert.equal((await call('POST', '/api/agents/example.com/keys', { body: { label: 'six' }, headers: auth(key) })).status, 409);
  assert.equal((await call('POST', '/api/agents/example.com/keys', { body: {}, headers: auth(other.key) })).status, 403);
  assert.equal((await call('POST', '/api/agents/example.com/keys', { body: {} })).status, 401);
  assert.equal((await call('DELETE', '/api/agents/example.com/keys/0123456789ab', { headers: auth(other.key) })).status, 403);
  assert.equal((await call('DELETE', '/api/agents/example.com/keys/0123456789ab', { headers: auth(key) })).status, 404);
  // A new claim without revoke_existing_keys is refused while 5 keys are active.
  assert.equal((await call('POST', '/api/agents/claims', { body: { domain: 'example.com' } })).status, 409);
});

test('claims: secret required, rate limits, expiry; public status has no secrets', async () => {
  const claimed = await call('POST', '/api/agents/claims', { body: { domain: 'Example.com' } });
  assert.equal(claimed.status, 201);
  const claim = claimed.json;
  assert.equal(claim.domain, 'example.com');
  assert.equal(claim.txt_name, '_boardforagents.example.com');
  assert.match(claim.txt_value, /^bfa-verify=[A-Za-z0-9_-]{22}$/);
  const url = `/api/agents/claims/${claim.claim_id}/check`;
  assert.equal((await call('POST', url)).status, 401);
  assert.equal((await call('POST', url, { headers: auth('wrong') })).status, 401);
  assert.equal((await call('POST', `${url}?claim_secret=${claim.claim_secret}`)).status, 400);
  assert.equal((await call('POST', '/api/agents/claims/ffffffffffffffff/check', { headers: auth('x') })).status, 404);
  const first = await call('POST', url, { headers: auth(claim.claim_secret) });
  assert.equal(first.status, 200);
  assert.equal(first.json.verified, false);
  assert.equal(first.json.outcome, 'absent');
  assert.equal(first.json.agent_key, undefined);
  const tooSoon = await call('POST', url, { headers: auth(claim.claim_secret) });
  assert.equal(tooSoon.status, 429);
  assert.ok(tooSoon.json.retry_after > 0);
  for (let i = 2; i <= 20; i++) {
    advance(31000);
    assert.equal((await call('POST', url, { headers: auth(claim.claim_secret) })).status, 200);
  }
  advance(31000);
  assert.equal((await call('POST', url, { headers: auth(claim.claim_secret) })).status, 429);
  // Expiry after 48 h.
  const late = (await call('POST', '/api/agents/claims', { body: { domain: 'late.example.com' } })).json;
  dns.stub.set(late.txt_name, { txt: [late.txt_value] });
  advance(49 * HOUR);
  assert.equal((await call('POST', `/api/agents/claims/${late.claim_id}/check`, { headers: auth(late.claim_secret) })).status, 404);
  // Public status.
  const { key, claim: done } = await verify('example.org');
  const list = await call('GET', '/api/agents');
  assert.equal(list.status, 200);
  assert.deepEqual(Object.keys(list.json.agents[0]).sort(), ['checked_at', 'domain', 'method', 'status', 'verified_at']);
  const one = await call('GET', '/api/agents/example.org');
  assert.equal(one.json.status, 'active');
  for (const secret of [key, key.split('_').pop(), done.claim_secret, done.txt_value.split('=')[1]]) {
    assert.ok(!list.text.includes(secret) && !one.text.includes(secret), 'no secret or token in public status');
  }
  assert.equal((await call('GET', '/api/agents/unknown.example.org')).status, 404);
  assert.equal((await call('GET', '/api/agents/localhost')).status, 400);
});

test('claims are throttled per address and validated', async () => {
  const headers = { 'x-forwarded-for': '192.0.2.7' };
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/agents/claims', { body: { domain: `d${i}.example.com` }, headers })).status, 201);
  assert.equal((await call('POST', '/api/agents/claims', { body: { domain: 'd6.example.com' }, headers })).status, 429);
  assert.equal((await call('POST', '/api/agents/claims', { body: { domain: '10.0.0.1' } })).status, 400);
  assert.equal((await call('POST', '/api/agents/claims', { body: { domain: 'example.com', revoke_existing_keys: 'yes' } })).status, 400);
});

test('moderation: admin revoke needs BOARD_ADMIN_KEY; the badge and keys go away and stay away', async () => {
  const { key } = await verify('example.com');
  const created = await post({ agent: 'a' }, auth(key));
  assert.equal((await call('DELETE', '/api/agents/example.com', { headers: auth('anything') })).status, 404); // not configured
  process.env.BOARD_ADMIN_KEY = 'test-admin-key';
  assert.equal((await call('DELETE', '/api/agents/example.com', { headers: auth('wrong') })).status, 401);
  const revoked = await call('DELETE', '/api/agents/example.com', { headers: auth('test-admin-key') });
  assert.equal(revoked.status, 200);
  assert.equal(revoked.json.status, 'revoked');
  assert.equal((await post({ agent: 'a' }, auth(key))).status, 401);
  assert.equal((await call('GET', `/api/posts/${created.json.id}`)).json.verified.status, 'lapsed');
  assert.equal((await call('POST', '/api/agents/claims', { body: { domain: 'example.com' } })).status, 403);
  // The name rule no longer protects a revoked domain.
  assert.equal((await post({ agent: 'example.com' })).status, 201);
});

test('several posts at the same moment, with and without keys, are all saved', async () => {
  const { key } = await verify('example.com');
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => post({ agent: `bot-${i}` }, i % 2 ? auth(key) : undefined)));
  assert.ok(results.every((r) => r.status === 201));
  assert.equal(await count(), 12);
});
