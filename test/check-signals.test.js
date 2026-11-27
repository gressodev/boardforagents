// Signals, parsers, scoring and starter files of the site checker (lib/check-signals.js, lib/check-starter.js).
// Pure functions on fixture content: no network.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sig = require('../lib/check-signals');
const starter = require('../lib/check-starter');
const { GOOD_HTML, SPA_HTML } = require('./check-fixtures');

const BASE = 'https://site.example.com/';
const res = (text, type = 'text/plain', status = 200, extra = {}) => ({ url: BASE, status, headers: {}, type, text, truncated: false, redirects: [], ...extra });
const page = (html, extra = {}) => res(html, 'text/html', 200, extra);
const facts = (over = {}) => ({ page: page(GOOD_HTML), inputScheme: 'https', httpVariant: { status: 301, location: BASE, headers: {}, text: '' }, ...over });
const signalOf = (f, id) => sig.evaluate(f).signals.find((s) => s.id === id);

// ---------- robots.txt ----------
test('robots: groups, wildcard, explicit bots, longest match, Allow on ties, comments and sitemaps', () => {
  const parsed = sig.parseRobots(`# comment
User-agent: *
Disallow: /private   # inline comment
Allow: /

User-agent: GPTBot
User-Agent: CCBot/2.0
Disallow: /

user-agent: ClaudeBot
Disallow: /
Allow: /$

User-agent: PerplexityBot
Disallow:

Sitemap: https://site.example.com/sitemap.xml
SITEMAP: https://site.example.com/news.xml
`);
  assert.deepEqual(parsed.sitemaps, ['https://site.example.com/sitemap.xml', 'https://site.example.com/news.xml']);
  const access = Object.fromEntries(sig.aiCrawlerAccess(parsed).map((a) => [a.bot, a]));
  assert.equal(access.GPTBot.status, 'blocked');
  assert.equal(access.GPTBot.via, 'explicit');
  assert.equal(access.CCBot.status, 'blocked'); // "CCBot/2.0" is matched by its product token
  assert.equal(access.ClaudeBot.status, 'partial'); // only the home page
  assert.equal(access.PerplexityBot.status, 'allowed'); // empty Disallow allows everything
  assert.equal(access['Google-Extended'].status, 'allowed');
  assert.equal(access['Google-Extended'].via, 'wildcard');
  assert.equal(sig.robotsAllows(parsed, 'Google-Extended', '/private/x').allowed, false);
  assert.equal(sig.robotsAllows(sig.parseRobots('User-agent: *\nDisallow: /a\nAllow: /a'), 'x', '/a').allowed, true); // tie: Allow wins
  assert.equal(sig.robotsAllows(sig.parseRobots('User-agent: *\nDisallow: /*.php$'), 'x', '/index.php').allowed, false);
  assert.equal(sig.robotsAllows(sig.parseRobots('User-agent: *\nDisallow: /*.php$'), 'x', '/index.php5').allowed, true);
  assert.equal(sig.robotsAllows(sig.parseRobots(''), 'GPTBot', '/').via, 'default');
});

test('robots signal: missing or soft-404 is a warning; everything blocked is a warning; some blocked passes and names them', () => {
  assert.equal(signalOf(facts({ robots: res('nope', 'text/plain', 404) }), 'robots').status, 'warn');
  const soft = signalOf(facts({ robots: res('<!doctype html><html>…</html>', 'text/html') }), 'robots');
  assert.equal(soft.status, 'warn');
  assert.match(soft.detail, /soft 404/);
  const all = signalOf(facts({ robots: res('User-agent: *\nDisallow: /') }), 'robots');
  assert.equal(all.status, 'warn');
  assert.match(all.detail, /Every AI crawler checked is blocked/);
  const some = signalOf(facts({ robots: res('User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nAllow: /') }), 'robots');
  assert.equal(some.status, 'pass');
  assert.match(some.detail, /Blocked: GPTBot\./);
  assert.equal(some.data.ai_crawlers.find((c) => c.bot === 'GPTBot').status, 'blocked');
  const budget = signalOf(facts({ robots: { error: { code: 'budget', message: 'x' } } }), 'robots');
  assert.match(budget.detail, /not checked/);
});

// ---------- HTML ----------
test('parseHtml: meta, Open Graph, canonical, lang, links, JSON-LD types, same-site nav links first', () => {
  const html = sig.parseHtml(GOOD_HTML, 'https://good.example.com/');
  assert.equal(html.title, 'Acme Widgets — tools for agents');
  assert.equal(html.description, 'Acme sells widgets and exposes an API for AI agents.');
  assert.deepEqual(html.og, { title: 'Acme Widgets', description: 'Widgets and an agent API.' });
  assert.equal(html.canonical, 'https://good.example.com/');
  assert.equal(html.lang, 'en');
  assert.equal(html.markdownAlternate, 'https://good.example.com/index.md');
  assert.deepEqual(html.jsonLd, [{ ok: true, types: ['Organization'] }]);
  assert.deepEqual(html.anchors.map((a) => a.text), ['Home', 'Docs', 'Pricing']); // the external link is left out
  assert.ok(html.words > 150);
  assert.equal(html.spaRoot, false);
  const graph = sig.parseHtml('<script type="application/ld+json">{"@graph":[{"@type":"WebSite"},{"@type":["Article","NewsArticle"]}]}</script><script type="application/ld+json">{oops</script>', BASE);
  assert.deepEqual(graph.jsonLd, [{ ok: true, types: ['WebSite', 'Article', 'NewsArticle'] }, { ok: false, types: [] }]);
});

test('parseHtml: entities are decoded, scripts, styles and comments are not counted as text, SPA shells are spotted', () => {
  const html = sig.parseHtml(`<html lang='de'><head><title>A &amp; B &#x263A;</title><meta content="Desc &quot;q&quot;" name=description></head>
<body><script>var words = "${'lots of words '.repeat(100)}";</script><style>.a{}</style><!-- hidden words here --><p>Visible text</p></body></html>`, BASE);
  assert.equal(html.title, 'A & B ☺');
  assert.equal(html.description, 'Desc "q"');
  assert.equal(html.lang, 'de');
  assert.equal(html.words, 2);
  assert.equal(sig.parseHtml(SPA_HTML, BASE).spaRoot, true);
  assert.equal(sig.parseHtml('<app-root></app-root>', BASE).spaRoot, true);
  assert.equal(sig.parseHtml('<div id="root"><p>SSR content</p></div>', BASE).spaRoot, false);
});

test('parsers stay fast on hostile input (no catastrophic regex backtracking)', () => {
  const hostile = ['<'.repeat(1e6), '<script'.repeat(1e5), '<a '.repeat(3e5), '<div id=root '.repeat(5e4), '<title>'.repeat(1e5),
    '&#x'.repeat(2e5), '<!--'.repeat(2e5), `<html>${'<div>'.repeat(1e5)}`];
  for (const text of hostile) {
    const started = Date.now();
    sig.parseHtml(text, BASE);
    sig.parseRobots(text);
    sig.parseSitemap(text);
    sig.parseLinkHeader(text.slice(0, 20000), BASE);
    assert.ok(Date.now() - started < 3000, `${text.slice(0, 12)}… took ${Date.now() - started} ms`);
  }
});

test('Link header parsing', () => {
  const links = sig.parseLinkHeader('</llms.txt>; rel="service-doc"; type="text/plain", <https://x.example.com/mcp>; rel="mcp", <javascript:alert(1)>; rel="mcp"', BASE);
  assert.deepEqual(links, [
    { href: 'https://site.example.com/llms.txt', rel: ['service-doc'], type: 'text/plain' },
    { href: 'https://x.example.com/mcp', rel: ['mcp'], type: '' },
  ]);
});

// ---------- the other signals ----------
test('https: plain HTTP fails, a missing redirect warns, a redirect passes', () => {
  assert.equal(signalOf(facts({ page: page(GOOD_HTML, { url: 'http://site.example.com/' }), inputScheme: 'http' }), 'https').status, 'fail');
  assert.equal(signalOf(facts({ httpVariant: res('<html>', 'text/html') }), 'https').status, 'warn');
  assert.equal(signalOf(facts(), 'https').status, 'pass');
  assert.equal(signalOf(facts({ httpVariant: { error: { code: 'network', message: 'x' } } }), 'https').status, 'pass');
  assert.equal(signalOf(facts({ inputScheme: 'http', httpVariant: null, page: page(GOOD_HTML, { redirects: [BASE] }) }), 'https').status, 'pass');
});

test('llms.txt: missing fails, "# " title passes, other formats warn, soft 404 fails, llms-full.txt is noted', () => {
  assert.equal(signalOf(facts({ llms: res('', 'text/plain', 404) }), 'llms_txt').status, 'fail');
  assert.equal(signalOf(facts({ llms: res('<html><body>Home</body></html>', 'text/html') }), 'llms_txt').status, 'fail');
  assert.equal(signalOf(facts({ llms: res('Just some text') }), 'llms_txt').status, 'warn');
  const good = signalOf(facts({ llms: res('# Site\n\n> Summary\n\n- [A](https://a.example.com/)\n'), llmsFull: res('# Full') }), 'llms_txt');
  assert.equal(good.status, 'pass');
  assert.match(good.detail, /llms-full\.txt is there too/);
  assert.equal(good.data.links, 1);
});

test('sitemap, MCP, API catalog, skill.md, markdown, security.txt', () => {
  const sitemap = res('<urlset><url><loc>https://site.example.com/a</loc></url></urlset>', 'application/xml');
  assert.equal(signalOf(facts({ sitemap, sitemapSource: 'robots' }), 'sitemap').status, 'pass');
  assert.equal(signalOf(facts({ sitemap: res('', 'text/plain', 404), sitemapSource: 'default' }), 'sitemap').status, 'fail');
  assert.equal(signalOf(facts({ robots: res('Sitemap: https://site.example.com/s.xml'), sitemap: res('', 'text/plain', 500), sitemapSource: 'robots' }), 'sitemap').status, 'warn');

  const card = res(JSON.stringify({ remotes: [{ url: 'https://site.example.com/mcp' }] }), 'application/json');
  assert.deepEqual(signalOf(facts({ mcpCard: card }), 'mcp').data.endpoints, ['https://site.example.com/mcp']);
  assert.equal(signalOf(facts({ mcpCard: res('{}', 'application/json') }), 'mcp').status, 'warn');
  assert.equal(signalOf(facts({ page: page(GOOD_HTML, { headers: { link: '</mcp>; rel="mcp"' } }) }), 'mcp').status, 'pass');
  assert.equal(signalOf(facts(), 'mcp').status, 'fail');

  assert.equal(signalOf(facts({ apiCatalog: res('{"linkset":[{"anchor":"/api","service-desc":[{"href":"/openapi.json"}]}]}', 'application/linkset+json') }), 'api_catalog').status, 'pass');
  assert.equal(signalOf(facts({ openapi: res('{"openapi":"3.1.0","info":{}}', 'application/json') }), 'api_catalog').status, 'pass');
  assert.equal(signalOf(facts({ openapi: res('openapi: 3.0.0\ninfo:\n', 'application/yaml') }), 'api_catalog').status, 'pass');
  assert.equal(signalOf(facts({ openapi: res('{"openapi": "3.1.0", "paths": {"/a": [cut at the size ca', 'application/json', 200, { truncated: true }) }), 'api_catalog').status, 'pass');
  assert.equal(signalOf(facts({ apiCatalog: res('[1]', 'application/json') }), 'api_catalog').status, 'warn');
  assert.equal(signalOf(facts({ openapi: res('<html></html>', 'text/html') }), 'api_catalog').status, 'fail');

  assert.equal(signalOf(facts({ skill: res('---\nname: x\ndescription: y\n---\n# X') }), 'skill_md').status, 'pass');
  assert.equal(signalOf(facts({ skill: res('# no frontmatter') }), 'skill_md').status, 'warn');
  assert.equal(signalOf(facts({ skillsIndex: res('{"skills":[]}', 'application/json') }), 'skill_md').status, 'pass');
  assert.equal(signalOf(facts(), 'skill_md').status, 'fail');

  const noAlt = page(GOOD_HTML.replace(/<link rel="alternate"[^>]*>/, ''));
  assert.equal(signalOf(facts({ page: noAlt }), 'markdown').status, 'fail');
  assert.equal(signalOf(facts({ page: noAlt, mdNegotiated: res('# Home', 'text/markdown') }), 'markdown').status, 'pass');
  assert.equal(signalOf(facts({ page: noAlt, indexMd: res('# Home', 'text/markdown') }), 'markdown').status, 'pass');
  assert.equal(signalOf(facts({ page: noAlt, mdNegotiated: res('<html>', 'text/html') }), 'markdown').status, 'fail');

  assert.equal(signalOf(facts({ security: res('Contact: mailto:a@b.example\nExpires: 2027-01-01T00:00:00Z') }), 'security_txt').status, 'pass');
  assert.equal(signalOf(facts({ security: res('Contact: mailto:a@b.example') }), 'security_txt').status, 'warn');
  assert.equal(signalOf(facts(), 'security_txt').status, 'fail');
});

test('ssr and meta: SPA shells fail, thin pages warn, complete pages pass; missing meta is listed', () => {
  assert.equal(signalOf(facts({ page: page(SPA_HTML) }), 'ssr').status, 'fail');
  assert.match(signalOf(facts({ page: page(SPA_HTML) }), 'ssr').detail, /single-page-app shell/);
  assert.equal(signalOf(facts({ page: page(`<p>${'word '.repeat(60)}</p>`) }), 'ssr').status, 'warn');
  assert.equal(signalOf(facts({ page: page(GOOD_HTML, { truncated: true }) }), 'ssr').status, 'warn');
  assert.equal(signalOf(facts(), 'ssr').status, 'pass');
  assert.equal(signalOf(facts({ page: res('{"a":1}', 'application/json') }), 'ssr').status, 'fail');

  assert.equal(signalOf(facts(), 'meta').status, 'pass');
  const partial = signalOf(facts({ page: page('<html><head><title>T</title></head></html>') }), 'meta');
  assert.equal(partial.status, 'warn');
  assert.deepEqual(partial.data.missing, ['meta description', 'og:title', 'og:description', 'canonical link', '<html lang>']);
  assert.equal(signalOf(facts({ page: page('<p>x</p>') }), 'meta').status, 'fail');
});

test('every signal has id, label, status, weight, detail and fix; the weights add up to 100', () => {
  const { signals } = sig.evaluate(facts());
  assert.equal(signals.length, 12);
  assert.deepEqual(signals.map((s) => s.id), Object.keys(sig.WEIGHTS));
  for (const s of signals) {
    assert.ok(s.label && s.detail && s.fix, s.id);
    assert.ok(['pass', 'warn', 'fail'].includes(s.status));
  }
  assert.equal(Object.values(sig.WEIGHTS).reduce((a, b) => a + b, 0), 100);
});

test('score: pass = full weight, warn = half, fail = 0', () => {
  const make = (status) => Object.entries(sig.WEIGHTS).map(([id, weight]) => ({ id, weight, status }));
  assert.equal(sig.score(make('pass')).score, 100);
  assert.equal(sig.score(make('fail')).score, 0);
  assert.equal(sig.score(make('warn')).score, 50);
  const mixed = make('fail');
  mixed[0].status = 'pass'; // https: 10
  mixed[3].status = 'warn'; // llms_txt: 12 -> 6
  assert.deepEqual(sig.score(mixed), { score: 16, max: 100, passed: 1, warned: 1, failed: 10, total: 12 });
});

// ---------- starter files ----------
test('starter files are tailored: title, description, nav links, sitemaps, MCP and OpenAPI', () => {
  const html = sig.parseHtml(GOOD_HTML, 'https://good.example.com/');
  const files = starter.generate({
    finalUrl: 'https://good.example.com/', html, sitemapUrls: ['https://good.example.com/sitemap.xml'],
    mcpEndpoints: ['https://good.example.com/mcp'], apis: { openapi: 'https://good.example.com/openapi.json' },
  });
  const llms = files['llms.txt'];
  assert.match(llms, /^# Acme Widgets\n\n> Acme sells widgets and exposes an API for AI agents\.\n/);
  assert.ok(llms.includes('- [Docs](https://good.example.com/docs)'));
  assert.ok(llms.includes('- [OpenAPI description](https://good.example.com/openapi.json)'));
  assert.ok(llms.includes('- [MCP server](https://good.example.com/mcp)'));
  assert.ok(llms.includes('- [Sitemap](https://good.example.com/sitemap.xml)'));
  assert.match(files['skill.md'], /^---\nname: good-example-com\ndescription: "Use good\.example\.com: Acme sells widgets/);
  assert.ok(files['skill.md'].includes('MCP endpoint (Streamable HTTP): https://good.example.com/mcp'));
  assert.ok(files['robots.txt'].includes('User-agent: ClaudeBot\n'));
  assert.ok(files['robots.txt'].includes('Sitemap: https://good.example.com/sitemap.xml\n'));
  // Without nav links, pages come from the sitemap.
  const bare = starter.generate({ finalUrl: 'https://bare.example.com/', html: null, sitemapLocs: ['https://bare.example.com/docs/getting-started', 'https://bare.example.com/blog'] });
  assert.ok(bare['llms.txt'].includes('- [Docs: getting started](https://bare.example.com/docs/getting-started)'));
  assert.ok(bare['robots.txt'].includes('Sitemap: https://bare.example.com/sitemap.xml'));
});

test('starter files cannot be injected into: no new lines, frontmatter keys, Markdown links or non-http URLs', () => {
  const evil = `<html><head><title>Evil
---
name: pwned
# Injected heading</title>
<meta name="description" content="line1&#10;Disallow: /&#10;---&#10;evil: true">
</head><body><nav>
<a href="/ok">x](javascript:alert(1)) [y</a>
<a href="javascript:alert(1)">JS link</a>
<a href="/a b(c)">Spaces (and) parens</a>
</nav></body></html>`;
  const html = sig.parseHtml(evil, 'https://evil.example.com/');
  const files = starter.generate({ finalUrl: 'https://evil.example.com/', html, sitemapUrls: ['javascript:alert(1)', 'https://evil.example.com/s.xml\nDisallow: /'] });
  for (const [name, content] of Object.entries(files)) {
    assert.ok(!/^name: pwned/m.test(content), name);
    assert.ok(!/^evil: true/m.test(content), name);
    assert.ok(!/^Disallow:/m.test(content), name);
    assert.ok(!/^# Injected/m.test(content), name);
    assert.ok(!/(^|[^\\])\]\(javascript:/m.test(content), `${name}: an unescaped link to javascript:`);
    assert.ok(!/^Sitemap: javascript/m.test(content), name);
  }
  const lines = files['skill.md'].split('\n');
  assert.equal(lines[0], '---');
  const front = lines.slice(1, lines.indexOf('---', 1));
  assert.deepEqual(front.map((l) => l.split(':')[0]), ['name', 'description', 'homepage']);
  assert.equal(JSON.parse(front[1].slice('description: '.length)), 'Use evil.example.com: line1 Disallow: / --- evil: true');
  assert.ok(files['llms.txt'].includes('[x\\](javascript:alert(1)) \\[y](https://evil.example.com/ok)'));
  assert.ok(files['llms.txt'].includes('(https://evil.example.com/a%20b%28c%29)'));
  assert.ok(!files['llms.txt'].includes('JS link'));
});
