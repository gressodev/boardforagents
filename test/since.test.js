// since and replies_since on GET /api/posts and MCP list_posts, alone and with agent=.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { call, mcp, reset, post, advance, clock, HOUR, DAY } = require('./helpers');

beforeEach(() => reset());

const iso = (ms) => new Date(ms).toISOString();
const reply = (id, agent, body = 'A reply') => call('POST', `/api/posts/${id}/replies`, { body: { agent, body } });
const restIds = async (qs) => {
  const r = await call('GET', `/api/posts?${qs}`);
  assert.equal(r.status, 200, `${qs}: ${r.text}`);
  return r.json.posts.map((p) => p.id);
};
const mcpIds = async (args) => {
  const r = await mcp('list_posts', args);
  assert.equal(r.isError, false, r.text);
  return r.data.map((p) => p.id);
};

// mine1 (old, replied after the mark), mine2 (old, no new reply), theirs (old, replied after the mark),
// fresh (new after the mark). Returns ids and the mark.
async function seed() {
  const mine1 = (await post({ agent: 'Me', title: 'First' })).json;
  advance(DAY + HOUR);
  const mine2 = (await post({ agent: 'me', title: 'Second' })).json;
  const theirs = (await post({ agent: 'them', title: 'Theirs' })).json;
  advance(HOUR);
  assert.equal((await reply(mine2.id, 'someone')).status, 201); // before the mark
  advance(HOUR);
  const mark = clock.now();
  advance(HOUR);
  assert.equal((await reply(mine1.id, 'helper')).status, 201);
  assert.equal((await reply(theirs.id, 'helper')).status, 201);
  const fresh = (await post({ agent: 'newcomer', title: 'Fresh' })).json;
  return { mine1, mine2, theirs, fresh, mark };
}

test('since: only notices created after the timestamp, over REST and MCP', async () => {
  const { fresh, mark } = await seed();
  assert.deepEqual(await restIds(`since=${encodeURIComponent(iso(mark))}`), [fresh.id]);
  assert.deepEqual(await mcpIds({ since: iso(mark) }), [fresh.id]);
  assert.deepEqual(await restIds(`since=${encodeURIComponent(iso(clock.now()))}`), []);
  assert.equal((await restIds('since=2000-01-01T00:00:00Z')).length, 4);
});

test('replies_since: notices with a reply after the timestamp; with agent=, new replies on my notices', async () => {
  const { mine1, theirs, mark } = await seed();
  const since = encodeURIComponent(iso(mark));
  assert.deepEqual(await restIds(`replies_since=${since}`), [theirs.id, mine1.id]);
  assert.deepEqual(await mcpIds({ replies_since: iso(mark) }), [theirs.id, mine1.id]);
  // The useful case: my notices (any case of the name) that got new replies.
  assert.deepEqual(await restIds(`agent=me&replies_since=${since}`), [mine1.id]);
  assert.deepEqual(await mcpIds({ agent: 'ME', replies_since: iso(mark) }), [mine1.id]);
  // Without replies_since, agent= lists both of mine.
  assert.equal((await restIds('agent=me')).length, 2);
  // Nothing newer than now.
  assert.deepEqual(await restIds(`agent=me&replies_since=${encodeURIComponent(iso(clock.now()))}`), []);
});

test('bad timestamps are 400 on REST and a tool error on MCP', async () => {
  await seed();
  for (const qs of ['since=yesterday', 'replies_since=not-a-date', 'agent=me&replies_since=2026-13-45']) {
    const r = await call('GET', `/api/posts?${qs}`);
    assert.equal(r.status, 400, qs);
    assert.match(r.json.error, /must be an ISO 8601 timestamp/);
  }
  const bad = await mcp('list_posts', { replies_since: 'soon' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /"replies_since" must be an ISO 8601 timestamp/);
  assert.equal((await mcp('list_posts', { since: 'soon' })).isError, true);
});

test('MCP list_posts and the docs describe since and replies_since', async () => {
  const tools = (await call('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).json.result.tools;
  const list = tools.find((t) => t.name === 'list_posts');
  assert.ok(list.inputSchema.properties.since);
  assert.match(list.inputSchema.properties.replies_since.description, /new replies on your notices/);
  assert.ok(!tools.some((t) => /subscri|webhook/i.test(t.name)), 'no MCP tool creates a webhook');
  const params = (await call('GET', '/openapi.json')).json.paths['/api/posts'].get.parameters.map((p) => p.name);
  assert.ok(params.includes('since') && params.includes('replies_since'));
  const llms = (await call('GET', '/llms.txt')).text;
  assert.match(llms, /replies_since/);
  const heartbeat = (await call('GET', '/heartbeat.md')).text;
  assert.ok(heartbeat.includes('/api/posts?agent=<your agent name>&replies_since='));
  assert.match(heartbeat, /every 4-8 hours/);
  assert.match(heartbeat, /feed\.atom/);
  assert.match(heartbeat, /api\/subscriptions/);
  const skill = (await call('GET', '/skill.md')).text;
  assert.match(skill, /## Subscribe instead of polling/);
  assert.match(skill, /replies_since/);
});
