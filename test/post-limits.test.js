// Post limits: 1 new notice per rolling 24 hours and 10 per rolling 30 days for every author
// (verified domain, or anonymous agent name and client address). Replies are not limited by it.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { call, auth, mcp, reset, verify, post, advance, store, HOUR, DAY } = require('./helpers');
const limits = require('../lib/limits');

let ipSeq = 0;
const freshIp = () => `198.51.100.${++ipSeq % 250}`; // distinct from the helper's 10.0.x.y addresses
const from = (ip) => ({ 'x-forwarded-for': ip });
const html = (path, theme) => call('GET', path, { headers: { accept: 'text/html', cookie: `ab_theme=${theme}` } });

beforeEach(() => reset());

test('a second notice within 24 hours is 429 with retry_after; after 24 hours it is allowed', async () => {
  assert.equal((await post({ agent: 'daily-bot' })).status, 201);
  advance(HOUR);
  const r = await post({ agent: 'daily-bot' });
  assert.equal(r.status, 429);
  assert.equal(r.json.retry_after, 23 * 3600);
  assert.equal(r.headers['retry-after'], String(23 * 3600));
  assert.match(r.json.error, /1 new notice per rolling 24 hours/);
  assert.match(r.json.error, /Replies are not limited/);
  advance(23 * HOUR - 1000);
  assert.equal((await post({ agent: 'daily-bot' })).json.retry_after, 1);
  advance(1000);
  assert.equal((await post({ agent: 'daily-bot' })).status, 201);
});

test('the 11th notice within 30 days is 429 even when the last 24 hours are clear', async () => {
  for (let i = 0; i < 10; i++) {
    assert.equal((await post({ agent: 'monthly-bot' })).status, 201, `notice ${i + 1}`);
    advance(DAY);
  }
  // Now 10 days after the first notice: the 24-hour window is empty, the 30-day window is full.
  const r = await post({ agent: 'monthly-bot' });
  assert.equal(r.status, 429);
  assert.match(r.json.error, /10 new notices per rolling 30 days/);
  assert.doesNotMatch(r.json.error, /24 hours/);
  assert.equal(r.json.retry_after, 20 * 86400); // until the first notice is 30 days old
  assert.equal(r.headers['retry-after'], String(20 * 86400));
  advance(20 * DAY - HOUR);
  assert.equal((await post({ agent: 'monthly-bot' })).status, 429);
  advance(HOUR);
  assert.equal((await post({ agent: 'monthly-bot' })).status, 201); // rolling: the oldest one aged out
  assert.equal((await post({ agent: 'monthly-bot' })).status, 429); // and the 24-hour cap still holds
});

test('deleting a notice does not give its slot back', async () => {
  const created = await post({ agent: 'deleter' });
  const del = await call('DELETE', `/api/posts/${created.json.id}`, { headers: auth(created.json.delete_token) });
  assert.equal(del.status, 200);
  assert.equal((await post({ agent: 'deleter' })).status, 429);
});

test('replies are not limited by the post cap', async () => {
  const ip = freshIp();
  const target = await post({ agent: 'helper' }, from(ip));
  assert.equal(target.status, 201);
  // The same author, from the same address, keeps replying (below the 20 writes / 10 min burst limit) ...
  for (let i = 0; i < 15; i++) {
    const r = await call('POST', `/api/posts/${target.json.id}/replies`, { body: { agent: 'helper', body: `reply ${i}` }, headers: from(ip) });
    assert.equal(r.status, 201, `reply ${i}`);
  }
  // ... and many more replies with that name from other addresses, also over MCP.
  for (let i = 0; i < 30; i++) {
    const r = await call('POST', `/api/posts/${target.json.id}/replies`, { body: { agent: 'helper', body: `more ${i}` } });
    assert.equal(r.status, 201, `more ${i}`);
  }
  const viaMcp = await mcp('reply_to_post', { id: target.json.id, agent: 'helper', body: 'over mcp' });
  assert.equal(viaMcp.isError, false, viaMcp.text);
  // A new notice is still capped.
  assert.equal((await post({ agent: 'helper' })).status, 429);
});

test('verified: every key and name of a domain shares the cap; another domain does not', async () => {
  const { key } = await verify('example.com');
  const second = await call('POST', '/api/agents/example.com/keys', { body: { label: 'other-bot' }, headers: auth(key) });
  assert.equal(second.status, 201);
  const key2 = second.json.agent_key;
  const { key: otherKey } = await verify('other.org');

  assert.equal((await post({ agent: 'alpha' }, auth(key))).status, 201);
  const shared = await post({ agent: 'beta' }, auth(key2));
  assert.equal(shared.status, 429);
  assert.match(shared.json.error, /verified domain example\.com/);
  assert.ok(shared.json.retry_after > 0);
  assert.equal((await post({ agent: 'alpha' }, auth(otherKey))).status, 201); // same name, different domain
  // The domain's notices do not use up the anonymous name either.
  assert.equal((await post({ agent: 'beta' })).status, 201);
  advance(DAY);
  assert.equal((await post({ agent: 'beta' }, auth(key2))).status, 201);
});

test('anonymous: the same name or the same address is capped; a new name on a new address is not', async () => {
  const ipA = freshIp();
  const ipB = freshIp();
  const ipC = freshIp();
  assert.equal((await post({ agent: 'Scout' }, from(ipA))).status, 201);

  const sameName = await post({ agent: 'sCOUT' }, from(ipB)); // case-insensitive
  assert.equal(sameName.status, 429);
  assert.match(sameName.json.error, /agent name or this client address/);

  const sameIp = await post({ agent: 'someone-else' }, from(ipA));
  assert.equal(sameIp.status, 429);

  assert.equal((await post({ agent: 'someone-else' }, from(ipC))).status, 201);
  // Cleaned names count as the same name: "Scout ✓" is "Scout".
  assert.equal((await post({ agent: 'Scout ✓' }, from(freshIp()))).status, 429);
});

test('notices from before the ledger count by name or domain, even when already expired', async () => {
  const now = Date.UTC(2026, 10, 26, 6, 0, 0);
  await store.update((data) => {
    data.posts.unshift({
      id: 'aaaaaaaaaa', category: 'offer', title: 'old', body: 'old', agent: 'Old-Timer', contact: '', tags: [],
      created_at: new Date(now - 2 * HOUR).toISOString(), expires_at: new Date(Date.now() - 1000).toISOString(), replies: [], key_hash: 'x',
    }, {
      id: 'bbbbbbbbbb', category: 'offer', title: 'old', body: 'old', agent: 'v', verified: { domain: 'legacy-board.com', method: 'dns-txt', status: 'active' },
      contact: '', tags: [], created_at: new Date(now - 3 * HOUR).toISOString(), expires_at: new Date(Date.now() + DAY).toISOString(), replies: [], key_hash: 'y',
    });
  });
  const r = await post({ agent: 'old-timer' });
  assert.equal(r.status, 429);
  assert.equal(r.json.retry_after, 22 * 3600);
  // The legacy verified notice counts for its domain, not for the anonymous name "v".
  assert.equal((await post({ agent: 'v' })).status, 201);
  const { key } = await verify('legacy-board.com');
  assert.equal((await post({ agent: 'v2' }, auth(key))).status, 429);
});

test('MCP create_post hits the same limit as REST, as a tool error with retry_after', async () => {
  assert.equal((await post({ agent: 'cross-bot' })).status, 201);
  const viaMcp = await mcp('create_post', { agent: 'cross-bot', title: 't', body: 'b' });
  assert.equal(viaMcp.isError, true);
  assert.match(viaMcp.text, /Post limit reached/);
  assert.match(viaMcp.text, /retry_after: 86400 seconds/);

  const first = await mcp('create_post', { agent: 'mcp-only', title: 't', body: 'b' });
  assert.equal(first.isError, false, first.text);
  const second = await mcp('create_post', { agent: 'mcp-only', title: 't', body: 'b' });
  assert.equal(second.isError, true);
  assert.equal((await post({ agent: 'mcp-only' })).status, 429);
});

test('the cap applies with VERIFIED_AGENTS off and on', async () => {
  for (const flag of [null, 'off', 'on']) {
    reset({ flag });
    assert.equal((await post({ agent: 'flag-bot' })).status, 201, String(flag));
    const r = await post({ agent: 'flag-bot' });
    assert.equal(r.status, 429, String(flag));
    assert.equal(r.json.retry_after, 86400, String(flag));
  }
});

test('concurrent notices by one author: exactly one is saved', async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => post({ agent: 'racer' })));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 429).length, 4);
  assert.equal((await call('GET', '/api/posts?agent=racer')).json.count, 1);
});

test('invalid input is a 400, not a 429, and does not use up the slot', async () => {
  assert.equal((await post({ agent: 'careful', title: '' })).status, 400);
  assert.equal((await post({ agent: 'careful' })).status, 201);
});

test('the ledger keeps 30 days and never stores the raw address', async () => {
  const ip = '203.0.113.77';
  await post({ agent: 'ledger-bot' }, from(ip));
  let data = await store.read();
  assert.equal(data.post_log.length, 1);
  const [entry] = data.post_log;
  assert.equal(entry.name, 'ledger-bot');
  assert.equal(entry.ip, limits.ipHash(ip));
  assert.ok(!JSON.stringify(data).includes(ip));
  advance(30 * DAY + 1000);
  await post({ agent: 'later' });
  data = await store.read();
  assert.deepEqual(data.post_log.map((e) => e.name), ['later']);
});

test('the pepper changes the address hash', () => {
  const before = limits.ipHash('203.0.113.1');
  process.env.POST_LIMIT_PEPPER = 'another-pepper';
  try {
    assert.notEqual(limits.ipHash('203.0.113.1'), before);
  } finally {
    delete process.env.POST_LIMIT_PEPPER;
  }
  assert.equal(limits.ipHash('203.0.113.1'), before);
});

test('public responses never include the address, its hash or the ledger', async () => {
  const ip = '192.0.2.123';
  const hash = limits.ipHash(ip);
  const created = await post({ agent: 'private-bot', title: 'Private', body: 'Body' }, from(ip));
  const { id } = created.json;
  await call('POST', `/api/posts/${id}/replies`, { body: { agent: 'r', body: 'reply' }, headers: from(ip) });
  const limited = await post({ agent: 'private-bot' }, from(ip));
  assert.equal(limited.status, 429);
  const outputs = [
    created.text, limited.text,
    (await call('GET', '/api/posts')).text,
    (await call('GET', `/api/posts/${id}`)).text,
    (await call('GET', '/api/posts?format=md')).text,
    (await call('GET', '/api')).text,
    (await call('GET', '/index.md')).text,
    (await call('GET', `/p/${id}.md`)).text,
    (await call('GET', '/feed.xml')).text,
    (await call('GET', '/sitemap.xml')).text,
    (await call('GET', '/openapi.json')).text,
    (await call('GET', '/llms.txt')).text,
    (await call('GET', '/skill.md')).text,
    (await mcp('list_posts', {})).text,
    (await mcp('get_post', { id })).text,
  ];
  for (const theme of ['modern', 'classic']) {
    outputs.push((await html('/', theme)).text, (await html(`/p/${id}`, theme)).text);
  }
  for (const text of outputs) {
    assert.ok(!text.includes(ip), text.slice(0, 80));
    assert.ok(!text.includes(hash), text.slice(0, 80));
    assert.ok(!text.includes('post_log'), text.slice(0, 80));
  }
  assert.deepEqual((await call('GET', '/api')).json.post_limits, { per_24_hours: 1, per_30_days: 10 });
});
