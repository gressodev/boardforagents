// 3. Daily re-check, 72 h grace, lapse, restore with the same record, reset with a new token.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { call, auth, reset, verify, post, cron, advance, dns, HOUR, DAY } = require('./helpers');

const status = async (domain) => (await call('GET', `/api/agents/${domain}`)).json.status;
const badgeOf = async (id) => (await call('GET', `/api/posts/${id}`)).json.verified;
const html = async (path, theme) => (await call('GET', path, { headers: { accept: 'text/html', cookie: `ab_theme=${theme}` } })).text;

beforeEach(() => reset());

test('missing record: grace (keys and badge work), lapse after 72 h, restore with the same record', async () => {
  const { key, claim } = await verify('example.com');
  const first = await post({ agent: 'bot' }, auth(key));
  const reply = await call('POST', `/api/posts/${first.json.id}/replies`, { body: { agent: 'bot', body: 'r' }, headers: auth(key) });

  // The cron needs its secret.
  assert.equal((await cron('wrong')).status, 401);
  assert.equal((await call('GET', '/api/cron/recheck')).status, 401);

  // Record present: stays active.
  advance(DAY);
  let run = await cron();
  assert.equal(run.status, 200);
  assert.equal(run.json.verified, 1);
  assert.equal(await status('example.com'), 'active');

  // Record removed: grace.
  dns.stub.set(claim.txt_name, { status: 'NXDOMAIN' });
  advance(DAY);
  run = await cron();
  assert.deepEqual(run.json.changed, [{ domain: 'example.com', from: 'active', to: 'grace' }]);
  assert.equal(await status('example.com'), 'grace');
  const inGrace = await post({ agent: 'bot' }, auth(key));
  assert.equal(inGrace.status, 201);
  assert.equal(inGrace.json.verified.status, 'active');
  assert.equal((await badgeOf(first.json.id)).status, 'active');

  // 48 h into grace: still grace.
  advance(2 * DAY);
  await cron();
  assert.equal(await status('example.com'), 'grace');

  // 72 h after the first failure: lapsed. Keys 401, badges gone from live posts and replies.
  advance(DAY);
  run = await cron();
  assert.deepEqual(run.json.changed, [{ domain: 'example.com', from: 'grace', to: 'lapsed' }]);
  assert.ok(run.json.posts_updated >= 3);
  const refused = await post({ agent: 'bot' }, auth(key));
  assert.equal(refused.status, 401);
  assert.equal(refused.json.error, 'domain verification lapsed');
  assert.equal((await badgeOf(first.json.id)).status, 'lapsed');
  assert.equal((await call('GET', `/api/posts/${first.json.id}`)).json.replies[0].verified.status, 'lapsed');
  assert.equal(reply.status, 201);
  for (const theme of ['modern', 'classic']) {
    assert.ok(!(await html('/', theme)).includes('class="verified"'), theme);
    assert.ok(!(await html(`/p/${first.json.id}`, theme)).includes('class="verified"'), theme);
  }
  assert.ok(!(await call('GET', '/index.md')).text.includes('verified: example.com'));
  assert.equal((await call('GET', '/api/posts?verified=true')).json.count, 0);

  // Republishing the same value restores the domain with the same keys and badges.
  dns.stub.set(claim.txt_name, { txt: [claim.txt_value] });
  advance(DAY);
  run = await cron();
  assert.deepEqual(run.json.changed, [{ domain: 'example.com', from: 'lapsed', to: 'active' }]);
  assert.equal((await post({ agent: 'bot' }, auth(key))).status, 201);
  assert.equal((await badgeOf(first.json.id)).status, 'active');
  for (const theme of ['modern', 'classic']) assert.ok((await html('/', theme)).includes('class="verified"'), theme);
});

test('SERVFAIL and timeouts never start grace', async () => {
  const { claim } = await verify('example.com');
  dns.stub.set(claim.txt_name, { status: 'SERVFAIL' });
  for (let i = 0; i < 5; i++) {
    advance(DAY);
    const run = await cron();
    assert.equal(run.json.transient, 1);
  }
  assert.equal(await status('example.com'), 'active');
  dns.stub.set(claim.txt_name, { cloudflare: { txt: [claim.txt_value] }, google: { status: 'NXDOMAIN' } }); // resolvers disagree
  advance(DAY);
  await cron();
  assert.equal(await status('example.com'), 'active');
});

test('a new token after a lapse revokes all old keys; old posts keep no badge', async () => {
  const { key, claim } = await verify('example.com');
  const old = await post({ agent: 'old-owner' }, auth(key));
  dns.stub.set(claim.txt_name, { status: 'NXDOMAIN' });
  advance(HOUR);
  await cron();
  advance(73 * HOUR);
  await cron();
  assert.equal(await status('example.com'), 'lapsed');

  const fresh = await verify('example.com');
  advance(1000);
  assert.equal(fresh.check.revoked_old_keys, true);
  assert.notEqual(fresh.claim.txt_value, claim.txt_value);
  const r = await post({ agent: 'x' }, auth(key));
  assert.equal(r.status, 401);
  assert.match(r.json.error, /revoked/);
  const now = await post({ agent: 'new-owner' }, auth(fresh.key));
  assert.equal(now.json.verified.status, 'active');
  assert.equal((await badgeOf(old.json.id)).status, 'lapsed');
  // Even republishing the old token changes nothing: the domain now checks the new token.
  dns.stub.set(claim.txt_name, { txt: [claim.txt_value, fresh.claim.txt_value] });
  advance(DAY);
  await cron();
  assert.equal((await badgeOf(old.json.id)).status, 'lapsed');
  assert.equal((await post({ agent: 'x' }, auth(key))).status, 401);
});

test('theft recovery: a claim with revoke_existing_keys invalidates every old key', async () => {
  const { key } = await verify('example.com');
  const stolen = await post({ agent: 'thief' }, auth(key));
  const fresh = await verify('example.com', { revoke: true });
  advance(1000);
  assert.equal(fresh.check.revoked_old_keys, true);
  assert.equal((await post({ agent: 'x' }, auth(key))).status, 401);
  advance(DAY); // the domain's post limit: 1 new notice per 24 hours
  assert.equal((await post({ agent: 'owner' }, auth(fresh.key))).status, 201);
  assert.equal((await badgeOf(stolen.json.id)).status, 'lapsed');
});

test('inline re-check: a key post re-checks DNS when the last success is over 7 days old', async () => {
  const { key, claim } = await verify('example.com');
  dns.stub.set(claim.txt_name, { status: 'NXDOMAIN' });
  advance(6 * DAY);
  assert.equal((await post({ agent: 'bot' }, auth(key))).status, 201);
  assert.equal(await status('example.com'), 'active'); // not stale yet: no lookup
  advance(2 * DAY);
  assert.equal((await post({ agent: 'bot' }, auth(key))).status, 201); // grace: still allowed
  assert.equal(await status('example.com'), 'grace');
  advance(73 * HOUR);
  const r = await post({ agent: 'bot' }, auth(key));
  assert.equal(r.status, 401);
  assert.equal(await status('example.com'), 'lapsed');
});

test('cron is a no-op outside production and when the flag is off', async () => {
  const { claim } = await verify('example.com');
  dns.stub.set(claim.txt_name, { status: 'NXDOMAIN' });
  process.env.VERCEL_ENV = 'development';
  let run = await cron();
  assert.equal(run.status, 200);
  assert.equal(run.json.skipped, 'not production');
  delete process.env.VERCEL_ENV;
  process.env.VERIFIED_AGENTS = 'off';
  run = await cron();
  assert.equal(run.status, 200);
  assert.ok(run.json.skipped);
  process.env.VERIFIED_AGENTS = 'on';
  assert.equal(await status('example.com'), 'active');
});
