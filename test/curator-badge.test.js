// The curator's replies carry the boardforagents.com badge while that domain is verified (active or
// grace), and never otherwise. The model call goes to a stubbed fetch: no network, no keys.
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { call, reset, verify, post, cron, advance, dns, agents, store, DAY } = require('./helpers');
const curator = require('../lib/curator');

const BASE = 'http://localhost'; // no dot in the host, so the IndexNow ping is skipped
const OIDC = 'test-oidc-token'; // makes client() pick AI Gateway; the request never leaves the process
const html = (path, theme) => call('GET', path, { headers: { accept: 'text/html', cookie: `ab_theme=${theme}` } });

// The helpers' fetch throws on any call; each test here answers only the AI Gateway messages call.
const blocked = globalThis.fetch;
let modelCalls;
function stubModel(answer) {
  modelCalls = 0;
  globalThis.fetch = async (url, init) => {
    const href = String(url instanceof Request ? url.url : url);
    if (!href.startsWith('https://ai-gateway.vercel.sh/') || !href.includes('/v1/messages')) return blocked(url, init);
    modelCalls++;
    const message = {
      id: 'msg_test', type: 'message', role: 'assistant', model: 'test', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: JSON.stringify(answer) }],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    return new Response(JSON.stringify(message), { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
  };
}

// Two notices; the curator matches the request to the offer, so it writes one reply on the request.
// beforeRun runs after both notices are saved, just before the curator.
async function curate(beforeRun = () => {}) {
  const offer = await post({ agent: 'offerer', category: 'offer', title: 'I translate documents' });
  const request = await post({ agent: 'asker', category: 'request', title: 'Need a translator' });
  assert.equal(offer.status, 201);
  assert.equal(request.status, 201);
  stubModel({ language: 'en', verdict: 'ok', matches: [{ id: offer.json.id, reason: 'They offer translation.' }] });
  beforeRun();
  await curator.run(request.json.id, BASE, OIDC);
  assert.equal(modelCalls, 1, 'the model was called once');
  const stored = (await store.read()).posts.find((p) => p.id === request.json.id);
  const replies = stored.replies.filter((r) => r.agent === 'board-curator');
  assert.equal(replies.length, 1, 'the curator reply was written');
  return { id: request.json.id, reply: replies[0] };
}

beforeEach(() => reset());
afterEach(() => { globalThis.fetch = blocked; });

test('domain active: the curator reply carries the boardforagents.com snapshot', async () => {
  await verify('boardforagents.com');
  const { id, reply } = await curate();
  assert.deepEqual(reply.verified, agents.snapshot('boardforagents.com'));
  assert.deepEqual(reply.verified, { domain: 'boardforagents.com', method: 'dns-txt', status: 'active' });
  assert.equal(reply.agent, 'board-curator');
  assert.equal(reply.ai, true);

  // The API shows it like any verified reply.
  const api = await call('GET', `/api/posts/${id}`);
  assert.deepEqual(api.json.replies.find((r) => r.agent === 'board-curator').verified, reply.verified);

  // The badge renders on the reply in both designs; the notice itself is still anonymous, so its
  // "For agents" note is unchanged.
  for (const theme of ['modern', 'classic']) {
    const page = await html(`/p/${id}`, theme);
    assert.equal(page.status, 200, theme);
    assert.ok(page.text.includes(`data-theme="${theme}"`), theme);
    assert.ok(page.text.includes('class="verified" href="/?domain=boardforagents.com"'), theme);
    assert.ok(page.text.includes('This notice was written by an unknown agent'), theme);
  }
  // The Markdown mirror marks the reply the same way as any verified reply.
  const md = await call('GET', `/p/${id}.md`);
  assert.ok(md.text.includes('- board-curator [verified: boardforagents.com] ('), md.text);
});

test('domain in grace: the reply still carries the badge', async () => {
  const { claim } = await verify('boardforagents.com');
  dns.stub.set(claim.txt_name, { status: 'NXDOMAIN' });
  advance(DAY);
  await cron();
  assert.equal((await call('GET', '/api/agents/boardforagents.com')).json.status, 'grace');
  const { reply } = await curate();
  assert.deepEqual(reply.verified, agents.snapshot('boardforagents.com'));
});

test('domain never verified: the reply is written without a badge', async () => {
  await verify('example.com'); // another verified domain does not count
  const { id, reply } = await curate();
  assert.equal(reply.verified, undefined);
  for (const theme of ['modern', 'classic']) {
    assert.ok(!(await html(`/p/${id}`, theme)).text.includes('class="verified"'), theme);
  }
  assert.ok(!(await call('GET', `/p/${id}.md`)).text.includes('[verified:'));
});

test('domain lapsed: the reply is written without a badge', async () => {
  const { claim } = await verify('boardforagents.com');
  dns.stub.set(claim.txt_name, { status: 'NXDOMAIN' });
  advance(DAY);
  await cron(); // grace
  advance(3 * DAY);
  await cron(); // lapsed
  assert.equal((await call('GET', '/api/agents/boardforagents.com')).json.status, 'lapsed');
  const { reply } = await curate();
  assert.equal(reply.verified, undefined);
});

test('domain revoked: the reply is written without a badge', async () => {
  await verify('boardforagents.com');
  await agents.adminRevoke('boardforagents.com');
  const { reply } = await curate();
  assert.equal(reply.verified, undefined);
});

test('feature flag off: the reply is written without a badge, even with the domain active', async () => {
  await verify('boardforagents.com');
  process.env.VERIFIED_AGENTS = 'off';
  const { reply } = await curate();
  assert.equal(reply.verified, undefined);
});

test('a failing lookup does not stop the reply from being written', async (t) => {
  await verify('boardforagents.com');
  const { reply } = await curate(() => {
    t.mock.method(agents.store, 'read', async () => { throw new Error('blob unavailable'); });
    t.mock.method(console, 'warn', () => {});
  });
  assert.equal(reply.verified, undefined);
  assert.equal(console.warn.mock.callCount(), 1);
  assert.match(String(console.warn.mock.calls[0].arguments[0]), /badge lookup failed/);
});

test('badge() and apply(): snapshot only for a live domain; apply() without one writes no badge', async () => {
  assert.equal(curator.DOMAIN, 'boardforagents.com');
  assert.equal(await curator.badge(), null);
  await verify('boardforagents.com');
  assert.deepEqual(await curator.badge(), agents.snapshot('boardforagents.com'));
  delete process.env.VERIFIED_AGENTS;
  assert.equal(await curator.badge(), null);

  const data = { posts: [
    { id: 'a', title: 'A', replies: [] },
    { id: 'b', title: 'B', replies: [] },
  ] };
  const result = { language: 'en', verdict: 'ok', matches: [{ id: 'b', reason: 'r' }] };
  assert.equal(curator.apply(data, 'a', result, BASE), true);
  assert.equal(data.posts[0].replies[0].verified, undefined);
  const snap = agents.snapshot('boardforagents.com');
  curator.apply(data, 'a', result, BASE, snap);
  assert.deepEqual(data.posts[0].replies[1].verified, snap);
  assert.notEqual(data.posts[0].replies[1].verified, snap, 'the reply gets its own copy');
});
