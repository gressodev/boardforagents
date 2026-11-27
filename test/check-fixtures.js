// A fake internet for the site checker: an injected resolver (host -> addresses) and an injected transport
// (URL -> canned response). Nothing here opens a socket. Every call is recorded for assertions.
const { Readable } = require('node:stream');

function fakeNet({ hosts = {}, routes = {} } = {}) {
  const calls = [];
  const lookups = [];
  const resolve = async (host) => {
    lookups.push(host);
    const entry = hosts[host];
    if (entry === undefined) throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
    return (Array.isArray(entry) ? entry : [entry]).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  const transport = ({ url, address, headers, signal }) => {
    calls.push({ url, address, headers });
    let spec = typeof routes === 'function' ? routes(url) : routes[url];
    if (typeof spec === 'function') spec = spec({ url, headers });
    if (spec && spec.accept && headers.accept && headers.accept.startsWith('text/markdown')) spec = spec.accept;
    if (!spec) spec = { status: 404, type: 'text/plain', body: 'not found' };
    if (spec.hang) {
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    }
    const head = { 'content-type': spec.type ?? 'text/html; charset=utf-8', ...(spec.location && { location: spec.location }), ...spec.headers };
    const body = spec.stream ? spec.stream() : Readable.from(spec.body == null ? [] : [Buffer.from(spec.body)]);
    return Promise.resolve({ status: spec.status ?? 200, headers: head, body });
  };
  return { resolve, transport, calls, lookups };
}

// A well-prepared site: every signal passes.
const GOOD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Acme Widgets — tools for agents</title>
<meta name="description" content="Acme sells widgets and exposes an API for AI agents.">
<meta property="og:title" content="Acme Widgets">
<meta property="og:description" content="Widgets and an agent API.">
<link rel="canonical" href="https://good.example.com/">
<link rel="alternate" type="text/markdown" href="/index.md">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Acme"}</script>
</head>
<body>
<header><nav><a href="/">Home</a> <a href="/docs">Docs</a> <a href="/pricing">Pricing</a> <a href="https://elsewhere.example.org/">External</a></nav></header>
<main><h1>Acme Widgets</h1>
<p>${'Acme builds reliable widgets for people and for software agents alike. '.repeat(20)}</p>
</main>
</body>
</html>`;

const GOOD_ROBOTS = `User-agent: *
Allow: /

User-agent: GPTBot
User-agent: ClaudeBot
Allow: /

Sitemap: https://good.example.com/sitemap.xml
`;

function goodSite(host = 'good.example.com') {
  const o = `https://${host}`;
  return {
    [`${o}/`]: { body: GOOD_HTML.replaceAll('good.example.com', host), headers: { 'strict-transport-security': 'max-age=31536000', link: `<${o}/mcp>; rel="mcp"` } },
    [`http://${host}/`]: { status: 301, location: `${o}/`, body: '' },
    [`${o}/robots.txt`]: { type: 'text/plain', body: GOOD_ROBOTS.replaceAll('good.example.com', host) },
    [`${o}/sitemap.xml`]: { type: 'application/xml', body: `<?xml version="1.0"?><urlset><url><loc>${o}/</loc></url><url><loc>${o}/docs</loc></url></urlset>` },
    [`${o}/llms.txt`]: { type: 'text/plain', body: `# Acme\n\n> Widgets for agents.\n\n## Docs\n- [Docs](${o}/docs): everything\n` },
    [`${o}/llms-full.txt`]: { type: 'text/plain', body: '# Acme full\n' },
    [`${o}/.well-known/mcp.json`]: { type: 'application/json', body: JSON.stringify({ transport: { type: 'streamable-http', endpoint: `${o}/mcp` } }) },
    [`${o}/.well-known/api-catalog`]: { type: 'application/linkset+json', body: JSON.stringify({ linkset: [{ anchor: `${o}/api`, 'service-desc': [{ href: `${o}/openapi.json` }] }] }) },
    [`${o}/skill.md`]: { type: 'text/markdown', body: '---\nname: acme\ndescription: Use Acme widgets\n---\n\n# Acme\n' },
    [`${o}/.well-known/security.txt`]: { type: 'text/plain', body: 'Contact: mailto:security@acme.example\nExpires: 2027-12-31T00:00:00Z\n' },
  };
}

// A bare SPA: almost every signal fails; unknown paths answer with the same HTML shell (soft 404).
const SPA_HTML = '<!doctype html><html><head><script src="/app.js"></script></head><body><div id="root"></div></body></html>';
function spaSite(host = 'spa.example.com') {
  const shell = { body: SPA_HTML };
  return (url) => (url.startsWith(`http://${host}`) ? { body: SPA_HTML } : shell);
}

// A fake Vercel Runtime Cache for the checker's shared layer: get / set / delete like RuntimeCache, values
// stored as JSON (as Vercel does), ttl in seconds against the given clock. Several checker instances can share
// one. fail: 'throw' | 'reject' | 'hang' makes every operation fail that way. writes records every set.
function fakeSharedCache({ now = () => Date.now(), fail = null } = {}) {
  const entries = new Map();
  const writes = [];
  const broken = () => {
    if (fail === 'throw') throw new Error('runtime cache exploded');
    if (fail === 'reject') return Promise.reject(new Error('runtime cache unavailable'));
    if (fail === 'hang') return new Promise(() => {});
    return null;
  };
  return {
    entries,
    writes,
    get(key) {
      const failed = broken();
      if (failed) return failed;
      const entry = entries.get(key);
      if (!entry) return Promise.resolve(null);
      if (entry.expires !== null && now() >= entry.expires) { entries.delete(key); return Promise.resolve(null); }
      return Promise.resolve(JSON.parse(entry.json));
    },
    set(key, value, options = {}) {
      const failed = broken();
      if (failed) return failed;
      const json = JSON.stringify(value ?? null);
      writes.push({ key, json, options });
      entries.set(key, { json, expires: options.ttl ? now() + options.ttl * 1000 : null });
      return Promise.resolve();
    },
    delete(key) { entries.delete(key); return Promise.resolve(); },
    expireTag() { return Promise.resolve(); },
  };
}

module.exports = { fakeNet, fakeSharedCache, goodSite, spaSite, GOOD_HTML, GOOD_ROBOTS, SPA_HTML };
