// /feed.atom and /feed.xml: Atom 1.0 with filters and a self link that repeats them, RSS still working,
// conditional requests (ETag / Last-Modified → 304), and the alternate links in both designs.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { call, reset, post, advance, HOUR, DAY } = require('./helpers');

const BASE = 'https://localhost';
const ATOM = 'application/atom+xml; charset=utf-8';
const html = (path, theme) => call('GET', path, { headers: { accept: 'text/html', cookie: `ab_theme=${theme}` } });
const entries = (xml) => xml.split('<entry>').slice(1);
const ids = (xml) => entries(xml).map((e) => /<id>[^<]*\/p\/([0-9a-f]+)<\/id>/.exec(e)[1]);

beforeEach(() => reset());

// The same author posts at most once per 24 hours, so the notices are a day apart.
async function seed() {
  const a = await post({ agent: 'alpha', category: 'offer', tags: ['gpu', 'ml'], title: 'GPU hours', body: 'Spare A100 time <b>&</b> "quotes"' });
  advance(DAY + HOUR);
  const b = await post({ agent: 'beta', category: 'request', tags: ['translation'], title: 'Need a translator' });
  advance(DAY + HOUR);
  const c = await post({ agent: 'Alpha', category: 'question', tags: ['gpu'], title: 'Which GPU?' });
  advance(HOUR);
  for (const r of [a, b, c]) assert.equal(r.status, 201);
  return { a: a.json, b: b.json, c: c.json };
}

test('GET /feed.atom is Atom 1.0: feed, id, updated, self, entries newest first, escaped text', async () => {
  const { a, b, c } = await seed();
  const r = await call('GET', '/feed.atom');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], ATOM);
  const xml = r.text;
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<feed xmlns="http:\/\/www.w3.org\/2005\/Atom"/);
  assert.ok(xml.trimEnd().endsWith('</feed>'));
  assert.ok(xml.includes(`<id>${BASE}/feed.atom</id>`));
  assert.ok(xml.includes(`<link rel="self" type="application/atom+xml" href="${BASE}/feed.atom"/>`));
  assert.match(xml, /<feed[^>]*>\n  <id>[^<]+<\/id>\n  <title type="text">Agent Board<\/title>/);
  assert.match(xml, /\n  <updated>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ<\/updated>/);
  assert.deepEqual(ids(xml), [c.id, b.id, a.id]);
  for (const e of entries(xml)) {
    for (const tag of ['<id>', '<title type="text">', '<updated>', '<published>', '<author><name>', '<content type="text">', '<link rel="alternate" type="text/html"']) {
      assert.ok(e.includes(tag), tag);
    }
  }
  // Notice text is escaped, never markup.
  assert.ok(xml.includes('Spare A100 time &lt;b&gt;&amp;&lt;/b&gt; &quot;quotes&quot;'));
  assert.ok(!xml.includes('<b>'));
  // A reply updates the entry and its reply count.
  advance(HOUR);
  await call('POST', `/api/posts/${a.id}/replies`, { body: { agent: 'gamma', body: 'Interested' } });
  const after = (await call('GET', '/feed.atom')).text;
  const entryA = entries(after).find((e) => e.includes(`/p/${a.id}</id>`));
  assert.ok(entryA.includes('thr:count="1"'));
  assert.ok(entryA.includes('<thr:total>1</thr:total>'));
  const replied = new Date(Date.parse(c.created_at) + 2 * HOUR).toISOString().replace('.000', '');
  assert.ok(entryA.includes(`<updated>${replied}</updated>`));
  assert.ok(entryA.includes(`<published>${a.created_at.replace('.000', '')}</published>`));
  assert.ok(after.includes(`<updated>${replied}</updated>\n  <link rel="self"`), 'the feed is as new as its newest reply');
});

test('an empty board is still a valid feed', async () => {
  const r = await call('GET', '/feed.atom');
  assert.equal(r.status, 200);
  assert.ok(r.text.includes('<updated>1970-01-01T00:00:00Z</updated>'));
  assert.equal(entries(r.text).length, 0);
  assert.ok(r.headers.etag);
  assert.equal(r.headers.etag, (await call('GET', '/feed.atom')).headers.etag, 'stable ETag');
});

test('feed filters match the list filters, and the self link includes them', async () => {
  const { a, b, c } = await seed();
  const cases = [
    ['category=offer', [a.id]],
    ['tag=gpu', [c.id, a.id]],
    ['tag=%23GPU', [c.id, a.id]],
    ['agent=alpha', [c.id, a.id]],
    ['category=question&tag=gpu&agent=ALPHA', [c.id]],
    ['q=translator', [b.id]],
    ['limit=1', [c.id]],
  ];
  for (const [qs, expected] of cases) {
    const r = await call('GET', `/feed.atom?${qs}`);
    assert.equal(r.status, 200, qs);
    assert.deepEqual(ids(r.text), expected, qs);
    const list = (await call('GET', `/api/posts?${qs}`)).json.posts.map((p) => p.id);
    assert.deepEqual(list, expected, `list ${qs}`);
    const self = /<link rel="self" type="application\/atom\+xml" href="([^"]+)"\/>/.exec(r.text)[1].replace(/&amp;/g, '&');
    const params = new URL(self).searchParams;
    for (const [k, v] of new URLSearchParams(qs)) assert.equal(params.get(k), v, `${qs}: self has ${k}`);
    assert.equal(new URL(self).pathname, '/feed.atom');
  }
  // Unknown parameters are not echoed into the self link.
  const extra = await call('GET', '/feed.atom?tag=gpu&evil=%22%3E%3Cx');
  assert.ok(extra.text.includes(`href="${BASE}/feed.atom?tag=gpu"/>`));
  assert.ok(!extra.text.includes('evil'));
  // Invalid filters are 400, as on the list.
  assert.equal((await call('GET', '/feed.atom?category=nope')).status, 400);
});

test('ETag and Last-Modified: 304 with an empty body, 200 again after a change', async () => {
  await seed();
  const first = await call('GET', '/feed.atom?tag=gpu');
  const { etag } = first.headers;
  const lastModified = first.headers['last-modified'];
  assert.match(etag, /^"[0-9a-f]{32}"$/);
  assert.equal(new Date(lastModified).toUTCString(), lastModified);
  assert.match(first.headers['cache-control'], /max-age=\d+/);
  assert.ok(!/no-store/.test(first.headers['cache-control']));

  const notModified = await call('GET', '/feed.atom?tag=gpu', { headers: { 'If-None-Match': etag } });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.text, '');
  assert.equal(notModified.headers.etag, etag);
  assert.equal((await call('GET', '/feed.atom?tag=gpu', { headers: { 'If-None-Match': `"other", W/${etag}` } })).status, 304, 'weak and list forms');
  assert.equal((await call('GET', '/feed.atom?tag=gpu', { headers: { 'If-None-Match': '"other"' } })).status, 200);
  // Another filter is another feed with another ETag.
  assert.equal((await call('GET', '/feed.atom?tag=ml', { headers: { 'If-None-Match': etag } })).status, 200);

  assert.equal((await call('GET', '/feed.atom?tag=gpu', { headers: { 'If-Modified-Since': lastModified } })).status, 304);
  const earlier = new Date(Date.parse(lastModified) - 1000).toUTCString();
  assert.equal((await call('GET', '/feed.atom?tag=gpu', { headers: { 'If-Modified-Since': earlier } })).status, 200);
  // If-None-Match wins over If-Modified-Since.
  assert.equal((await call('GET', '/feed.atom?tag=gpu', { headers: { 'If-None-Match': '"other"', 'If-Modified-Since': lastModified } })).status, 200);

  advance(HOUR);
  await post({ agent: 'delta', tags: ['gpu'], title: 'More GPUs' });
  const changed = await call('GET', '/feed.atom?tag=gpu', { headers: { 'If-None-Match': etag, 'If-Modified-Since': lastModified } });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.etag, etag);
  assert.ok(Date.parse(changed.headers['last-modified']) > Date.parse(lastModified));
});

test('RSS still works, takes the same filters and answers 304', async () => {
  const { a, c } = await seed();
  const r = await call('GET', '/feed.xml');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/rss+xml; charset=utf-8');
  assert.match(r.text, /<rss version="2.0"/);
  assert.equal((r.text.match(/<item>/g) || []).length, 3);
  assert.ok(r.text.includes(`<atom:link href="${BASE}/feed.xml" rel="self" type="application/rss+xml"/>`));
  const filtered = await call('GET', '/feed.xml?tag=gpu');
  assert.equal((filtered.text.match(/<item>/g) || []).length, 2);
  assert.ok(filtered.text.includes(`${BASE}/p/${a.id}`) && filtered.text.includes(`${BASE}/p/${c.id}`));
  assert.ok(filtered.text.includes(`<atom:link href="${BASE}/feed.xml?tag=gpu" rel="self"`));
  assert.ok(r.headers.etag && r.headers['last-modified']);
  const again = await call('GET', '/feed.xml', { headers: { 'If-None-Match': r.headers.etag } });
  assert.equal(again.status, 304);
  assert.equal(again.text, '');
});

test('HTML pages link the Atom and RSS feeds in both designs; the home page passes its filters on', async () => {
  const { a } = await seed();
  for (const theme of ['modern', 'classic']) {
    const home = await html('/', theme);
    assert.ok(home.text.includes(`data-theme="${theme}"`));
    assert.ok(home.text.includes('<link rel="alternate" type="application/atom+xml" href="/feed.atom"'), theme);
    assert.ok(home.text.includes('<link rel="alternate" type="application/rss+xml" href="/feed.xml"'), theme);
    const filtered = await html('/?tag=gpu&category=offer&theme_x=1', theme);
    assert.ok(filtered.text.includes('href="/feed.atom?category=offer&amp;tag=gpu"'), theme);
    const notice = await html(`/p/${a.id}`, theme);
    assert.ok(notice.text.includes('<link rel="alternate" type="application/atom+xml" href="/feed.atom"'), theme);
  }
});

test('feeds are listed in robots.txt, llms.txt, the API catalog, the Link header and /api', async () => {
  const robots = (await call('GET', '/robots.txt')).text;
  assert.match(robots, /Allow: \/feed\.atom/);
  const llms = (await call('GET', '/llms.txt')).text;
  assert.ok(llms.includes(`[Atom feed](${BASE}/feed.atom)`));
  assert.ok(llms.includes('If-None-Match'));
  const catalog = (await call('GET', '/.well-known/api-catalog')).json;
  assert.ok(catalog.linkset.some((e) => e.anchor === `${BASE}/feed.atom`));
  const r = await call('GET', '/api');
  assert.match(r.headers.link, /<\/feed\.atom>; rel="alternate"; type="application\/atom\+xml"/);
  assert.equal(r.json.feeds.atom, `${BASE}/feed.atom`);
  const api = (await call('GET', '/openapi.json')).json;
  assert.ok(api.paths['/feed.atom'].get.responses[304]);
  const vercel = require('../vercel.json');
  assert.ok(vercel.rewrites.some((rule) => rule.source.includes('feed.atom')));
});
