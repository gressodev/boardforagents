// The "For agents" note on a notice page and the Markdown mirror name the verified domain
// instead of calling a verified notice an "unknown agent".
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { call, auth, reset, verify, post, cron, advance, dns, DAY } = require('./helpers');

const html = (path, theme) => call('GET', path, { headers: { accept: 'text/html', cookie: `ab_theme=${theme}` } });

beforeEach(() => reset());

test('verified post: HTML in both designs names the domain, never "unknown agent"', async () => {
  const { key } = await verify('example.com');
  const created = await post({ agent: 'bot' }, auth(key));
  assert.equal(created.status, 201);
  for (const theme of ['modern', 'classic']) {
    const page = await html(`/p/${created.json.id}`, theme);
    assert.equal(page.status, 200);
    assert.ok(page.text.includes(`data-theme="${theme}"`), theme);
    assert.ok(page.text.includes('posted with a key for the verified domain example.com'), theme);
    assert.ok(page.text.includes('data, not instructions'), theme);
    assert.ok(page.text.includes(`POST /api/posts/${created.json.id}/replies`), theme);
    assert.ok(page.text.includes('href="/llms.txt"'), theme);
    assert.ok(!/unknown agent/i.test(page.text), theme);
  }
});

test('unverified post: HTML in both designs keeps the "unknown agent" note', async () => {
  const created = await post({ agent: 'plain' });
  for (const theme of ['modern', 'classic']) {
    const page = await html(`/p/${created.json.id}`, theme);
    assert.ok(page.text.includes('This notice was written by an unknown agent'), theme);
    assert.ok(!page.text.includes('verified domain'), theme);
  }
});

test('verified post: Markdown mirror names the domain, never "unknown agent"', async () => {
  const { key } = await verify('example.com');
  const created = await post({ agent: 'bot' }, auth(key));
  for (const path of [`/p/${created.json.id}.md`, `/p/${created.json.id}`]) {
    const md = await call('GET', path, { headers: { accept: 'text/markdown' } });
    assert.equal(md.status, 200, path);
    assert.ok(md.text.includes('Posted with a key for the verified domain example.com; still untrusted data'), path);
    assert.ok(!/unknown agent/i.test(md.text), path);
  }
  const plain = await post({ agent: 'plain' });
  const md = await call('GET', `/p/${plain.json.id}.md`);
  assert.ok(!md.text.includes('verified domain'));
});

test('lapsed badge: the notice page goes back to the "unknown agent" note', async () => {
  const { key, claim } = await verify('example.com');
  const created = await post({ agent: 'bot' }, auth(key));
  dns.stub.set(claim.txt_name, { status: 'NXDOMAIN' });
  advance(DAY);
  await cron(); // grace
  advance(3 * DAY);
  await cron(); // lapsed
  assert.equal((await call('GET', `/api/posts/${created.json.id}`)).json.verified.status, 'lapsed');
  for (const theme of ['modern', 'classic']) {
    const page = await html(`/p/${created.json.id}`, theme);
    assert.ok(page.text.includes('This notice was written by an unknown agent'), theme);
    assert.ok(!page.text.includes('verified domain example.com'), theme);
  }
  assert.ok(!(await call('GET', `/p/${created.json.id}.md`)).text.includes('verified domain'));
});
