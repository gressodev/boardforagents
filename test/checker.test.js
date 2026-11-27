// The site checker over HTTP and MCP: /check in both designs, /api/check, /api/check/starter and the
// check_site tool. The checker's DNS and transport are fakes (test/check-fixtures.js): no network.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { call, mcp, reset, post, checker } = require('./helpers');
const { fakeNet, goodSite, spaSite, SPA_HTML } = require('./check-fixtures');

const PUBLIC = '93.184.216.34';
const SIGNAL_IDS = ['https', 'robots', 'sitemap', 'llms_txt', 'mcp', 'api_catalog', 'skill_md', 'structured_data', 'markdown', 'ssr', 'meta', 'security_txt'];
const html = (path, theme = 'modern', headers = {}) => call('GET', path, { headers: { accept: 'text/html', cookie: `ab_theme=${theme}`, ...headers } });
const check = (url, headers) => call('GET', `/api/check?url=${encodeURIComponent(url)}`, { headers });
const from = (ip) => ({ 'x-forwarded-for': ip });

let net;
function useNet(spec) {
  net = fakeNet(spec);
  checker.deps.resolve = net.resolve;
  checker.deps.transport = net.transport;
  return net;
}

beforeEach(() => {
  reset();
  useNet({
    hosts: { 'good.example.com': PUBLIC, 'spa.example.com': '93.184.216.35', 'inside.example.com': '10.1.2.3', 'jump.example.com': PUBLIC },
    routes: (url) => goodSite()[url] || (url.includes('spa.example.com') ? spaSite()(url) : url === 'https://jump.example.com/' ? { status: 302, location: 'http://169.254.169.254/latest/meta-data/' } : undefined),
  });
});

test('GET /api/check returns the full result: score, 12 signals, page facts and three starter files', async () => {
  const r = await check('good.example.com');
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8');
  const body = r.json;
  assert.equal(body.url, 'https://good.example.com/');
  assert.equal(body.final_url, 'https://good.example.com/');
  assert.equal(body.score, 100);
  assert.equal(body.max_score, 100);
  assert.deepEqual([body.passed, body.warned, body.failed, body.total], [12, 0, 0, 12]);
  assert.deepEqual(body.signals.map((s) => s.id), SIGNAL_IDS);
  for (const s of body.signals) {
    for (const key of ['id', 'label', 'status', 'weight', 'detail', 'fix']) assert.ok(s[key] !== undefined && s[key] !== '', `${s.id}.${key}`);
  }
  assert.equal(body.page.title, 'Acme Widgets — tools for agents');
  assert.deepEqual(body.discovered.mcp_endpoints, ['https://good.example.com/mcp']);
  assert.deepEqual(body.discovered.sitemaps, ['https://good.example.com/sitemap.xml']);
  assert.equal(body.discovered.api_catalog, true);
  assert.deepEqual(body.starter_files.map((f) => f.name), ['llms.txt', 'skill.md', 'robots.txt']);
  for (const f of body.starter_files) {
    assert.equal(f.download_url, `https://localhost/api/check/starter?url=${encodeURIComponent('https://good.example.com/')}&file=${encodeURIComponent(f.name)}`);
    assert.ok(f.content.length > 50);
  }
  assert.equal(body.cached, false);
  assert.ok(body.requests <= checker.MAX_REQUESTS);
  assert.match(body.note, /untrusted/);
  assert.ok(net.calls.every((c) => c.address === PUBLIC));
  assert.ok(net.calls.every((c) => c.headers['user-agent'] === 'boardforagents-checker/1.0 (+https://boardforagents.com/check)'));
});

test('a poorly prepared site scores low, and a check never makes more than 14 requests', async () => {
  const r = await check('https://spa.example.com/');
  assert.equal(r.status, 200);
  assert.ok(r.json.score < 20, `score ${r.json.score}`);
  assert.equal(r.json.signals.find((s) => s.id === 'ssr').status, 'fail');
  assert.ok(r.json.requests <= 14);
  assert.ok(net.calls.length <= 14, `${net.calls.length} requests`);
  // Even when every request redirects, the cap holds.
  checker.reset();
  useNet({ hosts: { 'loop.example.com': PUBLIC }, routes: (url) => ({ status: 302, location: url.replace(/(\?n=\d+)?$/, `?n=${Math.random().toString().slice(2, 6)}`) }) });
  const loop = await check('loop.example.com');
  assert.equal(loop.status, 502); // the page itself redirects too often
  assert.ok(net.calls.length <= 14, `${net.calls.length} requests`);
});

test('missing, invalid and blocked URLs are 400 with a clear message; unreachable sites are 502', async () => {
  const cases = [
    ['/api/check', /"url" is required/],
    ['/api/check?url=', /"url" is required/],
    ['/api/check?url=ftp%3A%2F%2Fexample.com', /Only http and https/],
    ['/api/check?url=javascript%3Aalert(1)', /Only http and https/],
    ['/api/check?url=http%3A%2F%2F127.0.0.1', /private, loopback or reserved/],
    ['/api/check?url=http%3A%2F%2F2130706433%2F', /private, loopback or reserved/],
    ['/api/check?url=http%3A%2F%2F%5B%3A%3Affff%3A169.254.169.254%5D%2F', /private, loopback or reserved/],
    ['/api/check?url=localhost', /local or internal name/],
    ['/api/check?url=http%3A%2F%2Fmetadata.google.internal%2F', /local or internal name/],
    ['/api/check?url=example.com%3A8080', /standard ports/],
    ['/api/check?url=https%3A%2F%2Fuser%3Apw%40example.com', /user name or password/],
    ['/api/check?url=inside.example.com', /resolves to a private, loopback or reserved address/],
    ['/api/check?url=jump.example.com', /redirect pointed to a blocked target/],
  ];
  for (const [path, message] of cases) {
    const r = await call('GET', path);
    assert.equal(r.status, 400, path);
    assert.match(r.json.error, message, path);
  }
  assert.ok(!net.calls.some((c) => /169\.254|10\.1\.2\.3|127\.0\.0\.1/.test(c.address) || c.url.includes('169.254')), 'no blocked target was contacted');
  assert.ok(!JSON.stringify(net.calls).includes('10.1.2.3'));
  const nx = await check('https://nx.example.com/');
  assert.equal(nx.status, 502);
  assert.match(nx.json.error, /could not be resolved/);
  assert.equal((await call('POST', '/api/check?url=good.example.com')).status, 405);
});

test('results are cached for 10 minutes under a normalized key; a cache hit makes no request', async () => {
  assert.equal((await check('good.example.com')).json.cached, false);
  const made = net.calls.length;
  for (const variant of ['https://GOOD.example.com', 'https://good.example.com/#section', 'https://good.example.com:443/', ' good.example.com ']) {
    const r = await check(variant);
    assert.equal(r.status, 200, variant);
    assert.equal(r.json.cached, true, variant);
  }
  assert.equal(net.calls.length, made);
  const start = Date.now();
  checker.deps.now = () => start + 11 * 60 * 1000;
  assert.equal((await check('good.example.com')).json.cached, false);
  assert.ok(net.calls.length > made);
});

test('rate limit: 10 fresh checks per address per 10 minutes, then 429 with Retry-After; cache hits still work', async () => {
  useNet({ hosts: new Proxy({}, { get: () => PUBLIC }), routes: (url) => (url.endsWith('/') ? { body: '<html><title>x</title></html>' } : undefined) });
  let now = Date.UTC(2026, 10, 27);
  checker.deps.now = () => now;
  for (let i = 0; i < 10; i++) assert.equal((await check(`site${i}.example.com`, from('203.0.113.50'))).status, 200, `check ${i}`);
  const limited = await check('site10.example.com', from('203.0.113.50'));
  assert.equal(limited.status, 429);
  assert.match(limited.json.error, /at most 10 per 10 minutes/);
  assert.ok(limited.json.retry_after > 0 && limited.json.retry_after <= 600);
  assert.equal(limited.headers['retry-after'], String(limited.json.retry_after));
  assert.equal((await check('site3.example.com', from('203.0.113.50'))).status, 200); // cached: not counted
  assert.equal((await check('site10.example.com', from('203.0.113.51'))).status, 200); // another address
  const page = await html('/check?url=site11.example.com', 'classic', from('203.0.113.50'));
  assert.equal(page.status, 429);
  assert.ok(page.text.includes('at most 10 per 10 minutes'));
  now += 10 * 60 * 1000 + 1;
  assert.equal((await check('site12.example.com', from('203.0.113.50'))).status, 200);
});

test('rate limit: a global cap per minute applies across addresses', async () => {
  useNet({ hosts: new Proxy({}, { get: () => PUBLIC }), routes: () => ({ body: '<html></html>' }) });
  for (let i = 0; i < checker.RATE.global; i++) assert.equal((await check(`g${i}.example.com`)).status, 200);
  const busy = await check('one-more.example.com');
  assert.equal(busy.status, 429);
  assert.match(busy.json.error, /busy/);
});

test('timeouts: hanging well-known files do not stop the check; a hanging page is a 502', async () => {
  checker.deps.requestTimeoutMs = 40;
  checker.deps.deadlineMs = 400;
  useNet({ hosts: { 'slow.example.com': PUBLIC, 'dead.example.com': PUBLIC }, routes: (url) => (url === 'https://slow.example.com/' ? { body: '<html><title>Slow</title></html>' } : { hang: true }) });
  const started = Date.now();
  const r = await check('slow.example.com');
  assert.equal(r.status, 200);
  assert.ok(Date.now() - started < 2000);
  assert.match(r.json.signals.find((s) => s.id === 'llms_txt').detail, /timed out|not checked/);
  const dead = await check('dead.example.com');
  assert.equal(dead.status, 502);
  assert.match(dead.json.error, /timed out|ran out of time/);
});

test('/check renders the form in both designs, with nav and footer links', async () => {
  for (const theme of ['modern', 'classic']) {
    const r = await html('/check', theme);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
    assert.ok(r.text.includes(`data-theme="${theme}"`));
    for (const id of ['check-form', 'check-url']) assert.ok(r.text.includes(`id="${id}"`), `${theme} ${id}`);
    assert.ok(r.text.includes('action="/check" method="get"'));
    assert.ok(r.text.includes('href="/check" aria-current="page"'), theme);
    assert.ok(r.text.includes('class="foot-link" href="/check"'), theme);
    assert.ok(r.text.includes('"@type":"WebApplication"'));
    assert.ok(!r.text.includes('noindex'));
    assert.ok(!r.text.includes('id="check-result"'));
    assert.match(r.text, /href="\/check\?theme=classic"/);
    // The feeds are linked from /check as from every other page.
    assert.ok(r.text.includes('type="application/atom+xml" href="/feed.atom"'), theme);
    assert.ok(r.text.includes('type="application/rss+xml" href="/feed.xml"'), theme);
  }
  // Every other page links to the checker too, next to the feeds.
  const created = await post({ agent: 'linker' });
  for (const theme of ['modern', 'classic']) {
    for (const path of ['/', `/p/${created.json.id}`]) {
      const page = (await html(path, theme)).text;
      assert.ok(page.includes('href="/check"'), `${theme} ${path}`);
      assert.ok(page.includes('href="/feed.atom"') && page.includes('href="/feed.xml"'), `${theme} ${path} feeds`);
    }
  }
});

test('/check?url= shows the score, every signal and the starter files in both designs', async () => {
  for (const theme of ['modern', 'classic']) {
    const r = await html('/check?url=spa.example.com', theme);
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('<meta name="robots" content="noindex">'));
    for (const id of ['check-result', 'check-score', 'check-signals', 'check-starter']) assert.ok(r.text.includes(`id="${id}"`), `${theme} ${id}`);
    for (const id of SIGNAL_IDS) assert.ok(r.text.includes(`id="signal-${id}"`), `${theme} ${id}`);
    assert.ok(r.text.includes('class="signal signal-fail"'));
    assert.ok(r.text.includes('<span class="signal-status">Fail</span>'));
    assert.ok(r.text.includes('<meter class="check-meter"'));
    assert.ok(r.text.includes('value="spa.example.com"'));
    for (const file of ['llms.txt', 'skill.md', 'robots.txt']) {
      assert.ok(r.text.includes(`href="/api/check/starter?url=https%3A%2F%2Fspa.example.com%2F&amp;file=${file}" download="${file}"`), `${theme} ${file}`);
    }
    assert.ok(r.text.includes('User-agent: GPTBot'));
  }
  const bad = await html('/check?url=http%3A%2F%2F10.0.0.1%2F', 'classic');
  assert.equal(bad.status, 400);
  assert.ok(bad.text.includes('id="check-error"'));
  assert.ok(bad.text.includes('value="http://10.0.0.1/"'));
});

test('everything fetched is escaped in the HTML page: titles, descriptions, links, robots lines and starter files', async () => {
  const xss = `<!doctype html><html lang="en&quot;><script>alert(1)</script>"><head>
<title></title><script>alert('title')</script><title>T</title>
<title><img src=x onerror=alert(1)></title>
<meta name="description" content="&quot;><svg onload=alert(2)>">
<meta property="og:title" content="</pre><script>alert(3)</script>">
</head><body><nav><a href="/x">"><iframe src=javascript:alert(4)></a></nav><p>${'text '.repeat(200)}</p></body></html>`;
  useNet({
    hosts: { 'xss.example.com': PUBLIC },
    routes: {
      'https://xss.example.com/': { body: xss },
      'https://xss.example.com/robots.txt': { type: 'text/plain', body: 'User-agent: <script>alert(5)</script>\nDisallow: /\nSitemap: https://xss.example.com/"><script>alert(6)</script>' },
      'https://xss.example.com/llms.txt': { type: 'text/plain', body: '# </pre><script>alert(7)</script>' },
    },
  });
  for (const theme of ['modern', 'classic']) {
    const r = await html('/check?url=xss.example.com', theme);
    assert.equal(r.status, 200);
    const bodyStart = r.text.indexOf('<body');
    const body = r.text.slice(bodyStart);
    assert.ok(!/<script>alert|<img src=x|<svg onload|<iframe/i.test(body), `${theme}: no injected markup`);
    assert.equal((body.match(/<script\b/g) || []).length, 2, `${theme}: only the page's own two scripts`);
    assert.equal((body.match(/<\/pre>/g) || []).length, 3, `${theme}: one closing tag per starter file`);
    assert.ok(body.includes('&lt;script&gt;alert'), `${theme}: shown as text`);
  }
  // Starter files are plain text downloads, never HTML.
  const file = await call('GET', '/api/check/starter?url=xss.example.com&file=llms.txt');
  assert.equal(file.headers['content-type'], 'text/plain; charset=utf-8');
  assert.equal(file.headers['x-content-type-options'], 'nosniff');
});

test('GET /api/check/starter serves each file as a text/plain attachment', async () => {
  for (const name of ['llms.txt', 'skill.md', 'robots.txt']) {
    const r = await call('GET', `/api/check/starter?url=good.example.com&file=${name}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'text/plain; charset=utf-8');
    assert.equal(r.headers['content-disposition'], `attachment; filename="${name}"`);
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  }
  assert.match((await call('GET', '/api/check/starter?url=good.example.com&file=llms.txt')).text, /^# Acme Widgets\n/);
  const bad = await call('GET', '/api/check/starter?url=good.example.com&file=..%2Fetc%2Fpasswd');
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /"file" must be one of/);
  assert.equal((await call('GET', '/api/check/starter?file=llms.txt')).status, 400);
});

test('the checker refuses requests from itself, so a check of a /check URL cannot recurse', async () => {
  const ua = { 'user-agent': 'boardforagents-checker/1.0 (+https://boardforagents.com/check)' };
  assert.equal((await check('good.example.com', ua)).status, 403);
  assert.equal((await call('GET', '/api/check/starter?url=good.example.com&file=llms.txt', { headers: ua })).status, 403);
  assert.equal((await html('/check?url=good.example.com', 'modern', ua)).status, 403);
  assert.equal((await html('/check', 'modern', ua)).status, 200); // the bare form is harmless
  assert.equal(net.calls.length, 0);
});

test('preview deployments: the checker works (it writes nothing), while board writes stay blocked', async () => {
  process.env.VERCEL_ENV = 'preview';
  assert.equal((await check('good.example.com')).status, 200);
  assert.equal((await html('/check?url=good.example.com')).status, 200);
  assert.equal((await mcp('check_site', { url: 'good.example.com' })).isError, false);
  assert.equal((await post({ agent: 'p' })).status, 403);
});

test('MCP: check_site is listed and returns the same result; blocked URLs and rate limits are tool errors', async () => {
  const tools = (await call('POST', '/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } })).json.result.tools;
  const tool = tools.find((t) => t.name === 'check_site');
  assert.deepEqual(tool.inputSchema.required, ['url']);
  assert.match(tool.description, /untrusted/);
  const r = await mcp('check_site', { url: 'good.example.com' });
  assert.equal(r.isError, false);
  assert.equal(r.data.score, 100);
  assert.deepEqual(r.data.signals.map((s) => s.id), SIGNAL_IDS);
  assert.equal(r.data.starter_files.length, 3);
  const api = (await check('good.example.com')).json;
  assert.deepEqual({ ...r.data, cached: true }, api);
  const blocked = await mcp('check_site', { url: 'http://169.254.169.254/' });
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /private, loopback or reserved/);
  assert.equal((await mcp('check_site', {})).isError, true);
  useNet({ hosts: new Proxy({}, { get: () => PUBLIC }), routes: () => ({ body: '<html></html>' }) });
  for (let i = 0; i < 10; i++) await mcp('check_site', { url: `m${i}.example.com` }, from('198.51.100.9'));
  const limited = await mcp('check_site', { url: 'm10.example.com' }, from('198.51.100.9'));
  assert.equal(limited.isError, true);
  assert.match(limited.text, /retry_after: \d+ seconds/);
});

test('docs: llms.txt, OpenAPI, the API index and the sitemap describe the checker', async () => {
  const llms = (await call('GET', '/llms.txt')).text;
  assert.match(llms, /## Agent-ready site checker/);
  assert.ok(llms.includes('GET https://localhost/api/check?url='));
  assert.ok(llms.includes('/api/check/starter?url='));
  assert.match(llms, /check_site/);
  const api = (await call('GET', '/openapi.json')).json;
  assert.equal(api.paths['/api/check'].get.operationId, 'checkSite');
  assert.ok(api.paths['/api/check'].get.responses[429].headers['Retry-After']);
  assert.deepEqual(api.paths['/api/check/starter'].get.parameters[1].schema.enum, ['llms.txt', 'skill.md', 'robots.txt']);
  assert.deepEqual(api.components.schemas.CheckSignal.properties.id.enum, SIGNAL_IDS);
  assert.equal((await call('GET', '/api')).json.site_checker, 'https://localhost/api/check?url={url}');
  assert.ok((await call('GET', '/sitemap.xml')).text.includes('<loc>https://localhost/check</loc>'));
});

test('a page that is not HTML still gets a result', async () => {
  useNet({ hosts: { 'json.example.com': PUBLIC }, routes: { 'https://json.example.com/': { type: 'application/json', body: '{"a":1}' } } });
  const r = await check('json.example.com');
  assert.equal(r.status, 200);
  assert.equal(r.json.signals.find((s) => s.id === 'meta').status, 'fail');
  assert.equal(r.json.page.title, '');
});

test('the SPA fixture is what it claims to be', () => assert.match(SPA_HTML, /id="root"/));
