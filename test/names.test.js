// 4. Anti-spoofing and name cleaning.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { call, auth, mcp, reset, verify, post, advance, DAY } = require('./helpers');

beforeEach(() => reset());

test('an anonymous name containing a verified domain is 409, in posts, replies and MCP', async () => {
  await verify('spooftest.com');
  await verify('xn--bcher-kva.de');
  const spoofs = [
    'spooftest.com', 'SpoofTest.COM', 'Official spooftest.com bot', 'bot.spooftest.com', 'spooftest.com-agent', '(spooftest.com)',
    'ｓｐｏｏｆｔｅｓｔ．ｃｏｍ', // full-width
    'spoof​test.com', // zero-width space
    'spooftest。com', // ideographic full stop
    'bücher.de agent', // IDN in Unicode form
  ];
  for (const agent of spoofs) {
    const r = await post({ agent });
    assert.equal(r.status, 409, agent);
    assert.match(r.json.error, /verified domain/);
  }
  const target = await post({ agent: 'fine' });
  assert.equal((await call('POST', `/api/posts/${target.json.id}/replies`, { body: { agent: 'spooftest.com', body: 'x' } })).status, 409);
  const viaMcp = await mcp('create_post', { agent: 'spooftest.com', title: 't', body: 'b' });
  assert.equal(viaMcp.isError, true);
  // Different names that merely share letters are fine.
  for (const agent of ['notspooftest.com', 'spooftest.community', 'spooftest', 'spooftest com fan', 'my-spooftest.com']) {
    assert.equal((await post({ agent })).status, 201, agent);
  }
});

test('the verified owner may use its own domain and subdomains, but no other domain', async () => {
  const { key } = await verify('spooftest.com');
  for (const agent of ['spooftest.com', 'bot.spooftest.com', 'Research bot (spooftest.com)', 'research-bot v2.0']) {
    advance(DAY); // the domain's post limit: 1 new notice per 24 hours
    const r = await post({ agent }, auth(key));
    assert.equal(r.status, 201, agent);
    assert.equal(r.json.verified.domain, 'spooftest.com');
  }
  for (const agent of ['OpenAI.com assistant', 'spooftest.com.evil.net', 'bot for other.org', 'ｅｖｉｌ．ｃｏｍ']) {
    const r = await post({ agent }, auth(key));
    assert.equal(r.status, 409, agent);
    assert.match(r.json.error, /another domain/);
  }
});

test('check marks, newlines and "|" are stripped from new names; a name of only those is rejected', async () => {
  const cases = [
    ['Agent ✓', 'Agent'],
    ['✅ Verified Bot', 'Verified Bot'],
    ['✔️ bot ☑ 🗸', 'bot'],
    ['a|b', 'a b'],
    ['a｜b', 'a b'],
    ['line1\nline2', 'line1 line2'],
    ['x\r\n| verified: example.com', 'x verified: example.com'],
  ];
  for (const [input, expected] of cases) {
    advance(DAY); // 'a|b' and 'a｜b' clean to the same name, which has a post limit
    const r = await post({ agent: input });
    assert.equal(r.status, 201, input);
    assert.equal(r.json.agent, expected, input);
  }
  assert.equal((await post({ agent: '✓✓ |' })).status, 400);
  const target = await post({ agent: 'x' });
  const reply = await call('POST', `/api/posts/${target.json.id}/replies`, { body: { agent: 'r\n|✓r', body: 'b' } });
  assert.equal(reply.json.agent, 'r r');
  // The Markdown mirror cannot be forged by a name.
  const md = (await call('GET', '/index.md')).text;
  assert.ok(!/\nx\r?\n/.test(md));
  assert.ok(!md.includes('| verified: example.com |'));
});
