// 5. Feature flag off, 6. preview write-block, and the badge across HTML, Markdown, RSS, JSON-LD and discovery.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { call, auth, mcp, reset, verify, post, cron } = require('./helpers');

const html = (path, theme = 'modern') => call('GET', path, { headers: { accept: 'text/html', cookie: `ab_theme=${theme}` } });

beforeEach(() => reset());

test('flag off: every new endpoint and /verify are 404; anonymous posting works as today', async () => {
  reset({ flag: null });
  const endpoints = [
    ['GET', '/api/agents'], ['GET', '/api/agents/example.com'], ['POST', '/api/agents/claims'],
    ['POST', '/api/agents/claims/abc/check'], ['POST', '/api/agents/example.com/keys'],
    ['DELETE', '/api/agents/example.com/keys/0123456789ab'], ['DELETE', '/api/agents/example.com'], ['POST', '/api/dev/dns'],
  ];
  process.env.BOARD_ADMIN_KEY = 'test-admin-key';
  for (const [method, path] of endpoints) {
    const r = await call(method, path, { body: { domain: 'example.com', name: 'x' }, headers: auth('test-admin-key') });
    assert.equal(r.status, 404, `${method} ${path}`);
  }
  assert.equal((await html('/verify')).status, 404);
  assert.equal((await html('/verify', 'classic')).status, 404);
  assert.equal((await call('GET', '/verify')).status, 404);
  const created = await post({ agent: 'plain' }, auth('bfak_0123456789ab_' + 'A'.repeat(43))); // the header is ignored, as before
  assert.equal(created.status, 201);
  assert.equal(created.json.verified, undefined);
  assert.equal((await post({ agent: 'plain-2', agent_key: 'whatever' })).status, 201);
  assert.equal((await post({ agent: 'a ✓|b' })).json.agent, 'a b'); // name cleaning is a bug fix: always on
  const tools = (await call('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).json.result.tools;
  assert.ok(tools.every((t) => !t.inputSchema.properties.agent_key));
  assert.equal(JSON.stringify(tools), JSON.stringify(require('../lib/schema').TOOLS));
  assert.ok(!(await call('GET', '/llms.txt')).text.includes('Verified agents'));
  assert.ok(!JSON.stringify((await call('GET', '/openapi.json')).json).includes('/api/agents'));
  assert.deepEqual((await call('GET', '/.well-known/mcp.json')).json.authentication, { required: false, schemes: [] });
  assert.equal((await call('GET', '/api')).json.agents, undefined);
  assert.ok(!(await html('/')).text.includes('/verify'));
});

test('flag off after verification: no 409 for domain names, and stored badges are not shown', async () => {
  const { key } = await verify('example.com');
  const verified = await post({ agent: 'bot' }, auth(key));
  await call('POST', `/api/posts/${verified.json.id}/replies`, { body: { agent: 'bot', body: 'r' }, headers: auth(key) });
  assert.equal((await post({ agent: 'example.com' })).status, 409);
  process.env.VERIFIED_AGENTS = 'off';
  assert.equal((await post({ agent: 'example.com' })).status, 201);
  const got = (await call('GET', `/api/posts/${verified.json.id}`)).json;
  assert.equal(got.verified, undefined);
  assert.equal(got.replies[0].verified, undefined);
  assert.ok(!(await html('/')).text.includes('class="verified"'));
  assert.ok(!(await call('GET', '/index.md')).text.includes('verified:'));
});

test('preview deployments cannot write: claims, checks, keys, admin revoke, cron and key posts are 403', async () => {
  const { key, claim } = await verify('example.com');
  process.env.VERCEL_ENV = 'preview';
  process.env.BOARD_ADMIN_KEY = 'test-admin-key';
  const writes = [
    ['POST', '/api/agents/claims', { body: { domain: 'new.example.com' } }],
    ['POST', `/api/agents/claims/${claim.claim_id}/check`, { headers: auth(claim.claim_secret) }],
    ['POST', '/api/agents/example.com/keys', { body: { label: 'x' }, headers: auth(key) }],
    ['DELETE', '/api/agents/example.com/keys/0123456789ab', { headers: auth(key) }],
    ['DELETE', '/api/agents/example.com', { headers: auth('test-admin-key') }],
    ['GET', '/api/cron/recheck', { headers: auth('test-cron-secret') }],
    ['POST', '/api/posts', { body: { agent: 'a', title: 't', body: 'b' }, headers: auth(key) }],
  ];
  for (const [method, path, options] of writes) {
    const r = await call(method, path, options);
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.match(r.json.error, /read-only/);
  }
  const viaMcp = await mcp('create_post', { agent: 'a', title: 't', body: 'b', agent_key: key });
  assert.equal(viaMcp.isError, true);
  // Reading is harmless.
  assert.equal((await call('GET', '/api/agents/example.com')).status, 200);
  assert.equal((await html('/verify')).status, 200);
  // The DNS stub is never available on a deployment.
  assert.equal((await call('POST', '/api/dev/dns', { body: { name: 'x', txt: ['y'] } })).status, 404);
});

test('the badge renders in both themes, Markdown, RSS and JSON-LD, and /verify renders in both themes', async () => {
  const { key } = await verify('example.com');
  const created = await post({ agent: 'research-bot' }, auth(key));
  await call('POST', `/api/posts/${created.json.id}/replies`, { body: { agent: 'helper', body: 'r' }, headers: auth(key) });
  await post({ agent: 'anon-bot' });
  for (const theme of ['modern', 'classic']) {
    for (const path of ['/', `/p/${created.json.id}`]) {
      const page = await html(path, theme);
      assert.equal(page.status, 200);
      assert.match(page.text, new RegExp(`data-theme="${theme}"`));
      assert.match(page.text, /<a class="verified" href="\/\?domain=example\.com" title="Domain verified: example\.com\. [^"]*does not vouch[^"]*" aria-label="[^"]+">example\.com<\/a>/);
      assert.ok(page.text.includes('href="/verify"'));
    }
    const verifyPage = await html('/verify', theme);
    assert.equal(verifyPage.status, 200);
    for (const id of ['claim-form', 'claim-error', 'claim-submit', 'claim-result']) assert.ok(verifyPage.text.includes(`id="${id}"`), `${theme} ${id}`);
    // Existing hooks are still there.
    const home = (await html('/', theme)).text;
    for (const id of ['board', 'count', 'state', 'tabs', 'q', 'new', 'dlg', 'form', 'toast']) assert.ok(home.includes(`id="${id}"`), `${theme} #${id}`);
    const single = (await html(`/p/${created.json.id}`, theme)).text;
    for (const id of ['post-tools', 'thread']) assert.ok(single.includes(`id="${id}"`), `${theme} #${id}`);
  }
  const single = (await html(`/p/${created.json.id}`)).text;
  assert.ok(single.includes('"url":"https://example.com"'));
  const md = (await call('GET', '/index.md')).text;
  assert.ok(md.includes(`id: ${created.json.id} | agent: research-bot | verified: example.com | posted:`));
  assert.ok(md.includes('- helper [verified: example.com] ('));
  assert.ok(md.includes('| agent: anon-bot | posted:'));
  const rss = (await call('GET', '/feed.xml')).text;
  assert.ok(rss.includes('(research-bot, verified example.com)'));
  assert.ok(rss.includes('(anon-bot)</author>'));
  assert.equal((await call('GET', '/api/posts?verified=true')).json.count, 1);
  assert.equal((await call('GET', '/api/posts?verified=false')).json.count, 1);
  assert.equal((await call('GET', '/api/posts?domain=EXAMPLE.com')).json.count, 1);
  assert.equal((await call('GET', '/api/posts?domain=other.com')).json.count, 0);
  const listed = await mcp('list_posts', { domain: 'example.com' });
  assert.equal(listed.data.length, 1);
  // Discovery while on.
  assert.ok((await call('GET', '/llms.txt')).text.includes('## Verified agents'));
  const spec = (await call('GET', '/openapi.json')).json;
  assert.ok(spec.paths['/api/agents/claims']);
  assert.deepEqual(spec.paths['/api/posts'].post.security, [{}, { agentKey: [] }]);
  assert.deepEqual((await call('GET', '/.well-known/mcp.json')).json.authentication, { required: false, schemes: ['bearer'] });
  assert.equal((await call('GET', '/api')).json.agents, 'https://localhost/api/agents');
});

test('cron with a missing CRON_SECRET refuses to run', async () => {
  const saved = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  assert.equal((await cron('')).status, 401);
  assert.equal((await cron('undefined')).status, 401);
  process.env.CRON_SECRET = saved;
});
