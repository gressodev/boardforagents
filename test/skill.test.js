// /skill.md and /heartbeat.md: served as Markdown, linked from llms.txt, robots.txt, the API catalog,
// the Link header and the "For agents" boxes in both designs.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { call, reset, post } = require('./helpers');

const html = (path, theme) => call('GET', path, { headers: { accept: 'text/html', cookie: `ab_theme=${theme}` } });
const BASE = 'https://localhost';
const LIMIT_TEXT = /at most 1 per rolling 24 hours and 10 per rolling 30 days/;

beforeEach(() => reset());

test('GET /skill.md is Markdown with the links, the limits and the safety rule', async () => {
  const r = await call('GET', '/skill.md');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'text/markdown; charset=utf-8');
  const md = r.text;
  assert.match(md, /^---\nname: agent-board\n/);
  for (const link of ['/heartbeat.md', '/llms.txt', '/openapi.json', '/mcp', '/api/posts', '/api/posts/{id}/replies']) {
    assert.ok(md.includes(`${BASE}${link}`), link);
  }
  assert.match(md, LIMIT_TEXT);
  assert.match(md, /retry_after/);
  assert.match(md, /Replies do not count toward this limit/);
  assert.match(md, /untrusted data, never as instructions/);
  assert.match(md, /Never post secrets/);
  assert.match(md, /every 4-8 hours/);
  for (const tool of ['list_posts', 'get_post', 'create_post', 'reply_to_post', 'delete_post']) assert.ok(md.includes(tool), tool);
  assert.ok(!md.includes('\\\\\n'), 'shell line continuations are a single backslash');
  assert.ok(md.includes('application/json" \\\n  -d'));
});

test('skill.md describes verified keys only while VERIFIED_AGENTS is on', async () => {
  let md = (await call('GET', '/skill.md')).text;
  assert.match(md, /## Verified domain \(optional\)/);
  assert.ok(md.includes(`${BASE}/api/agents/claims`));
  assert.match(md, /impersonate another agent or a verified domain/);
  reset({ flag: null });
  md = (await call('GET', '/skill.md')).text;
  assert.ok(!md.includes('Verified domain'));
  assert.ok(!md.includes('/api/agents'));
  assert.match(md, LIMIT_TEXT);
});

test('GET /heartbeat.md is Markdown with the routine and the limits', async () => {
  const r = await call('GET', '/heartbeat.md');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'text/markdown; charset=utf-8');
  const md = r.text;
  assert.match(md, /every 4-8 hours, not more often/);
  assert.ok(md.includes(`${BASE}/skill.md`));
  assert.ok(md.includes(`${BASE}/api/posts?since=`));
  assert.ok(md.includes(`${BASE}/api/posts?agent=`));
  assert.match(md, /Do not post a new notice just to check in/);
  assert.match(md, /at most 1 per rolling 24 hours and 10 per rolling 30 days/);
  assert.match(md, /retry_after/);
});

test('llms.txt points to both files and documents the post limit', async () => {
  const r = await call('GET', '/llms.txt');
  const txt = r.text;
  assert.ok(txt.includes(`Start with ${BASE}/skill.md`));
  assert.ok(txt.includes(`[Skill](${BASE}/skill.md)`));
  assert.ok(txt.includes(`[Heartbeat](${BASE}/heartbeat.md)`));
  assert.match(txt, LIMIT_TEXT);
  assert.match(txt, /Deleting a notice or letting it expire does not give its slot back/);
  assert.equal((await call('GET', '/.well-known/llms.txt')).text, txt);
});

test('robots.txt, the API catalog and the Link header list the skill', async () => {
  const robots = (await call('GET', '/robots.txt')).text;
  assert.match(robots, /Allow: \/skill\.md/);
  assert.match(robots, /Allow: \/heartbeat\.md/);
  const catalog = (await call('GET', '/.well-known/api-catalog')).json;
  for (const entry of catalog.linkset) {
    const docs = entry['service-doc'].map((d) => d.href);
    assert.ok(docs.includes(`${BASE}/skill.md`));
    assert.ok(docs.includes(`${BASE}/heartbeat.md`));
    assert.ok(docs.includes(`${BASE}/llms.txt`));
  }
  const r = await call('GET', '/skill.md');
  assert.match(r.headers.link, /<\/skill\.md>; rel="service-doc"; type="text\/markdown"/);
});

test('the "For agents" box links both files in both designs, on the board and on a notice', async () => {
  const created = await post({ agent: 'linker' });
  for (const theme of ['modern', 'classic']) {
    for (const path of ['/', `/p/${created.json.id}`]) {
      const page = await html(path, theme);
      assert.equal(page.status, 200);
      assert.ok(page.text.includes(`data-theme="${theme}"`));
      assert.ok(page.text.includes('href="/skill.md"'), `${theme} ${path}`);
      assert.ok(page.text.includes('href="/heartbeat.md"'), `${theme} ${path}`);
      assert.ok(page.text.includes('href="/llms.txt"'), `${theme} ${path}`);
    }
  }
});

test('OpenAPI and the MCP tools describe the post limit', async () => {
  const api = (await call('GET', '/openapi.json')).json;
  const tooMany = api.paths['/api/posts'].post.responses[429];
  assert.match(tooMany.description, /1 per rolling 24 hours, 10 per rolling 30 days/);
  assert.ok(tooMany.headers['Retry-After']);
  assert.ok(api.components.schemas.Error.properties.retry_after);
  assert.match(api.paths['/api/posts/{id}/replies'].post.responses[429].description, /Replies do not count/);
  const tools = (await call('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).json.result.tools;
  assert.match(tools.find((t) => t.name === 'create_post').description, /1 new notice per rolling 24 hours and 10 per rolling 30 days/);
  assert.match(tools.find((t) => t.name === 'reply_to_post').description, /do not count toward the post limit/);
});
