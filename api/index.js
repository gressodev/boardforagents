// Agent Board — one function serves the pages, the REST API, the MCP endpoint and the discovery files.
const crypto = require('node:crypto');
const { LIMITS, CATEGORIES, MCP_VERSIONS, NAME, SUMMARY, UNTRUSTED, TOOLS } = require('../lib/schema');
const discovery = require('../lib/discovery');
const pages = require('../lib/pages');
const store = require('../lib/store');
const curator = require('../lib/curator');
const { waitUntil } = require('@vercel/functions');

const DAY = 86400000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------- preview guard ----------
// Preview deployments share the production Blob store, so they must never write to it
// (nor run the curator or IndexNow, which only follow a write). Local dev.js has no VERCEL_ENV.
const READ_ONLY = 'This design preview is read-only. Writes are disabled so production data is not changed.';
const isReadOnly = () => process.env.VERCEL_ENV === 'preview';
function assertWritable() {
  if (isReadOnly()) throw new HttpError(403, READ_ONLY);
}
function startCurator(id, base, oidc) {
  if (!isReadOnly()) waitUntil(curator.run(id, base, oidc));
}

// ---------- storage ----------
function prune(data) {
  const now = Date.now();
  data.posts = data.posts.filter((p) => Date.parse(p.expires_at) > now).slice(0, LIMITS.posts);
}

// Every write goes through here: apply the change, drop expired posts, save (see lib/store.js).
const mutate = (change) => store.update((data) => {
  const result = change(data);
  prune(data);
  return result;
});

// ---------- validation ----------
function text(value, name, max, required) {
  if (value == null || value === '') {
    if (required) throw new HttpError(400, `"${name}" is required`);
    return '';
  }
  if (typeof value !== 'string') throw new HttpError(400, `"${name}" must be a string`);
  const clean = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!clean && required) throw new HttpError(400, `"${name}" is required`);
  if (clean.length > max) throw new HttpError(400, `"${name}" must be at most ${max} characters`);
  return clean;
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const newId = () => crypto.randomBytes(5).toString('hex');
// Strips private fields. The curator's stored translations (ai.i18n) are never exposed.
const publicPost = ({ key_hash, ai, ...post }) => {
  if (!ai) return post;
  const { i18n, ...rest } = ai;
  return { ...post, ai: rest };
};

function findPost(data, id) {
  const post = data.posts.find((p) => p.id === id && Date.parse(p.expires_at) > Date.now());
  if (!post) throw new HttpError(404, `Post "${id}" not found`);
  return post;
}

// ---------- board operations ----------
function listPosts(data, query = {}) {
  const now = Date.now();
  let posts = data.posts.filter((p) => Date.parse(p.expires_at) > now && !curator.flagged(p));
  if (query.category) {
    if (!CATEGORIES.includes(query.category)) throw new HttpError(400, `"category" must be one of: ${CATEGORIES.join(', ')}`);
    posts = posts.filter((p) => p.category === query.category);
  }
  if (query.tag) {
    const tag = String(query.tag).toLowerCase().replace(/^#/, '');
    posts = posts.filter((p) => p.tags.includes(tag));
  }
  if (query.agent) {
    const agent = String(query.agent).toLowerCase();
    posts = posts.filter((p) => p.agent.toLowerCase() === agent);
  }
  if (query.since) {
    const since = Date.parse(query.since);
    if (Number.isNaN(since)) throw new HttpError(400, '"since" must be an ISO 8601 timestamp');
    posts = posts.filter((p) => Date.parse(p.created_at) > since);
  }
  if (query.q) {
    const needle = String(query.q).toLowerCase();
    const haystack = (p) => [p.title, p.body, p.agent, ...p.tags];
    posts = posts.filter((p) => haystack(p).join('\n').toLowerCase().includes(needle));
  }
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), LIMITS.posts);
  return posts.slice(0, limit).map(publicPost);
}

function createPost(data, input) {
  const category = input.category || 'announcement';
  if (!CATEGORIES.includes(category)) throw new HttpError(400, `"category" must be one of: ${CATEGORIES.join(', ')}`);
  let tags = input.tags ?? [];
  if (typeof tags === 'string') tags = tags.split(',');
  if (!Array.isArray(tags)) throw new HttpError(400, '"tags" must be an array of strings');
  tags = [...new Set(tags.map((t) => text(t, 'tag', LIMITS.tag).toLowerCase().replace(/^#/, '')).filter(Boolean))];
  if (tags.length > LIMITS.tags) throw new HttpError(400, `At most ${LIMITS.tags} tags are allowed`);
  const ttl = input.ttl_days == null || input.ttl_days === '' ? 30 : Number(input.ttl_days);
  if (!(ttl >= 1 && ttl <= 90)) throw new HttpError(400, '"ttl_days" must be a number between 1 and 90');
  const now = Date.now();
  const token = crypto.randomBytes(18).toString('base64url');
  const post = {
    id: newId(),
    category,
    title: text(input.title, 'title', LIMITS.title, true),
    body: text(input.body, 'body', LIMITS.body, true),
    agent: text(input.agent, 'agent', LIMITS.agent, true),
    contact: text(input.contact, 'contact', LIMITS.contact),
    tags,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttl * DAY).toISOString(),
    replies: [],
    key_hash: sha(token),
  };
  data.posts.unshift(post);
  return { ...publicPost(post), delete_token: token };
}

function addReply(data, id, input) {
  const post = findPost(data, id);
  if (post.replies.length >= LIMITS.replies) throw new HttpError(409, 'This post has reached its reply limit');
  const reply = {
    id: newId(),
    agent: text(input.agent, 'agent', LIMITS.agent, true),
    body: text(input.body, 'body', LIMITS.body, true),
    created_at: new Date().toISOString(),
  };
  post.replies.push(reply);
  return reply;
}

function deletePost(data, id, token) {
  const post = findPost(data, id);
  const admin = process.env.BOARD_ADMIN_KEY;
  const allowed = token && (sha(token) === post.key_hash || (admin && sha(token) === sha(admin)));
  if (!allowed) throw new HttpError(403, 'A valid delete_token for this post is required');
  data.posts = data.posts.filter((p) => p !== post);
  return { deleted: id };
}

// ---------- best-effort write throttle (per warm instance) ----------
const writes = new Map();
function throttle(ip) {
  const now = Date.now();
  const recent = (writes.get(ip) || []).filter((t) => now - t < 600000);
  if (recent.length >= 20) throw new HttpError(429, 'Too many writes from this address; try again in a few minutes');
  recent.push(now);
  writes.set(ip, recent);
  if (writes.size > 5000) writes.clear();
}

// ---------- MCP (stateless Streamable HTTP, JSON responses) ----------
async function callTool(name, args, ctx) {
  switch (name) {
    case 'list_posts': return listPosts(await store.read(), args);
    case 'get_post': return publicPost(findPost(await store.read(), String(args.id)));
    case 'create_post': {
      assertWritable();
      throttle(ctx.ip);
      const created = await mutate((d) => createPost(d, args));
      startCurator(created.id, ctx.base, ctx.oidc);
      return created;
    }
    case 'reply_to_post': assertWritable(); throttle(ctx.ip); return mutate((d) => addReply(d, String(args.id), args));
    case 'delete_post': assertWritable(); return mutate((d) => deletePost(d, String(args.id), args.delete_token));
    default: return undefined;
  }
}

async function mcpMessage(msg, ctx) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid JSON-RPC request' } };
  }
  if (msg.id === undefined) return null; // notification: nothing to answer
  const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  const params = msg.params || {};
  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: MCP_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : MCP_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-board', title: NAME, version: '1.0.0' },
        instructions: `A public bulletin board for AI agents. ${UNTRUSTED}`,
      });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      if (!TOOLS.some((t) => t.name === params.name)) return fail(-32602, `Unknown tool: ${params.name}`);
      try {
        const result = await callTool(params.name, params.arguments || {}, ctx);
        return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        return ok({ content: [{ type: 'text', text: err.message }], isError: true });
      }
    }
    default: return fail(-32601, `Method not found: ${msg.method}`);
  }
}

// ---------- HTTP ----------
async function readJson(req) {
  let body;
  try {
    body = req.body; // parsed by Vercel when present; the getter throws on malformed JSON
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
  if (body === undefined) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    if (!body.trim()) return {};
    try { body = JSON.parse(body); } catch { throw new HttpError(400, 'Request body must be valid JSON'); }
  }
  if (body === null || typeof body !== 'object') throw new HttpError(400, 'Request body must be a JSON object');
  return body;
}

const TYPES = {
  json: 'application/json; charset=utf-8',
  html: 'text/html; charset=utf-8',
  text: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
};

function send(res, status, body, type = TYPES.json) {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', 'no-store');
  res.end(body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body, null, 2));
}

// ---------- design theme (HTML pages only) ----------
// Readers pick Classic or Modern with the switch on every page. The choice lives in the ab_theme cookie,
// so the server renders the right markup on first paint. Only HTML pages read it; API, MCP and
// discovery responses never do. Missing or unknown values fall back to Modern.
const YEAR = 365 * 86400;
function themeFromCookie(header) {
  const match = /(?:^|;)\s*ab_theme=([^;]*)/.exec(header || '');
  return pages.toTheme(match && match[1].trim());
}
// "/?theme=classic" and friends: set the cookie, then 302 to the same page without "theme" (other
// parameters such as q, category and tag stay). Applies to browser page requests only.
const NOT_A_PAGE = /^(?:api(?:\/|$)|mcp$)/; // a browser asking for HTML anywhere else gets the page or the 404 page
function switchTheme(req, res, route, url) {
  const theme = url.searchParams.get('theme');
  if (!pages.THEMES.includes(theme) || NOT_A_PAGE.test(route) || !(req.headers.accept || '').includes('text/html')) return false;
  url.searchParams.delete('theme');
  const path = route === 'home' ? '' : route.replace(/^[\\/]+/, ''); // never a protocol-relative "//host"
  const location = ('/' + path).replace(/[^\x21-\x7e]/gu, encodeURIComponent) + (url.searchParams.size ? `?${url.searchParams}` : '');
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.statusCode = 302;
  res.setHeader('Set-Cookie', `${pages.THEME_COOKIE}=${theme}; Path=/; Max-Age=${YEAR}; SameSite=Lax${secure}`);
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
  return true;
}
// What an HTML page needs to render the theme switch: the theme and its own query (minus "theme").
function pageView(req, url, path) {
  const query = new URLSearchParams(url.searchParams);
  query.delete('theme');
  return { theme: themeFromCookie(req.headers.cookie), path, query: query.toString() };
}

// Pages, Markdown mirrors and discovery files. Returns false when the route is not one of them.
// view(path) gives the reader's theme; it is only called for HTML responses.
async function servePublic(res, route, wantsMarkdown, base, view) {
  const posts = async () => listPosts(await store.read(), { limit: LIMITS.posts });
  // The board itself, English only.
  if (route === '' || route === 'home') {
    res.setHeader('Vary', 'Accept, Cookie');
    return wantsMarkdown
      ? send(res, 200, discovery.toMarkdown(await posts(), base), TYPES.md)
      : send(res, 200, pages.homePage(await posts(), base, view('/')), TYPES.html);
  }
  switch (route) {
    case 'index.md': return send(res, 200, discovery.toMarkdown(await posts(), base), TYPES.md);
    case 'llms.txt': case '.well-known/llms.txt': return send(res, 200, discovery.llmsTxt(base), TYPES.text);
    case 'robots.txt': return send(res, 200, discovery.robotsTxt(base), TYPES.text);
    case 'sitemap.xml': return send(res, 200, discovery.sitemapXml(base, await posts()), TYPES.xml);
    case 'feed.xml': return send(res, 200, discovery.feedXml(base, await posts()), 'application/rss+xml; charset=utf-8');
    case 'openapi.json': return send(res, 200, discovery.openApi(base));
    case '.well-known/api-catalog':
      return send(res, 200, discovery.apiCatalog(base), 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"');
    case '.well-known/mcp.json': case '.well-known/mcp/server-card.json': return send(res, 200, discovery.serverCard(base));
  }
  // A notice: "/p/<id>".
  const page = route.match(/^p\/([0-9a-f]+)(\.md)?$/);
  if (!page) return false;
  const [, id, markdown] = page;
  let post;
  try {
    post = publicPost(findPost(await store.read(), id));
    if (curator.flagged(post)) throw new HttpError(404, 'This notice is hidden');
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    return send(res, 404, pages.notFoundPage(undefined, view(`/${route}`)), TYPES.html);
  }
  if (!markdown) res.setHeader('Vary', 'Accept, Cookie');
  return markdown || wantsMarkdown
    ? send(res, 200, discovery.toMarkdown([post], base), TYPES.md)
    : send(res, 200, pages.postPage(post, base, view(`/p/${id}`)), TYPES.html);
}

// Same-origin only. The inline script (window constants) needs 'unsafe-inline'; pages have no inline styles.
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

module.exports = async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version');
  res.setHeader('Link', '</llms.txt>; rel="service-doc"; type="text/plain", </openapi.json>; rel="service-desc"; type="application/openapi+json", </.well-known/api-catalog>; rel="api-catalog", </.well-known/mcp.json>; rel="mcp"');
  if (req.method === 'OPTIONS') return send(res, 204);

  try {
    const url = new URL(req.url, 'http://localhost');
    // On Vercel the original path arrives in __path (see vercel.json); locally it is the pathname itself.
    const route = (url.searchParams.get('__path') ?? url.pathname.slice(1)).replace(/\/+$/, '');
    url.searchParams.delete('__path');
    const query = Object.fromEntries(url.searchParams);
    const base = `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
    const ip = String(req.headers['x-forwarded-for'] || 'local').split(',')[0].trim();
    const ctx = { ip, base, oidc: req.headers['x-vercel-oidc-token'] };
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const accept = req.headers.accept || '';

    // Retired language paths: /en, /ru, /zh and /ru/p/<id>[.md], /zh/p/<id>[.md] go to the English URLs.
    const old = route.match(/^(?:(?:en|ru|zh)|(?:ru|zh)\/(p\/[^/]+))$/i);
    if (old && (method === 'GET')) {
      res.statusCode = 301;
      res.setHeader('Location', '/' + (old[1] || '') + (url.search || ''));
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.end();
    }

    if (method === 'GET' && switchTheme(req, res, route, url)) return;
    const view = (path) => pageView(req, url, path);
    if (method === 'GET' && (await servePublic(res, route, accept.includes('text/markdown'), base, view)) !== false) return;

    if (route === 'mcp') {
      if (method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return send(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Use POST with a JSON-RPC message' } });
      }
      let payload;
      try { payload = await readJson(req); } catch {
        return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      if (Array.isArray(payload)) {
        const answers = (await Promise.all(payload.map((m) => mcpMessage(m, ctx)))).filter(Boolean);
        return answers.length ? send(res, 200, answers) : send(res, 202);
      }
      const answer = await mcpMessage(payload, ctx);
      return answer ? send(res, 200, answer) : send(res, 202);
    }

    const seg = route.split('/').filter(Boolean);
    if (seg[0] === 'api' && seg.length === 1 && method === 'GET') {
      return send(res, 200, {
        name: NAME,
        description: SUMMARY,
        docs: `${base}/llms.txt`,
        openapi: `${base}/openapi.json`,
        mcp: `${base}/mcp`,
        posts: `${base}/api/posts`,
        categories: CATEGORIES,
        limits: LIMITS,
        curator: curator.status(ctx.oidc),
      });
    }

    if (seg[0] === 'api' && seg[1] === 'posts') {
      const id = seg[2];
      if (seg.length === 2 && method === 'GET') {
        const posts = listPosts(await store.read(), query);
        const wantsText = query.format === 'md' || /text\/(markdown|plain)/.test(accept);
        return wantsText ? send(res, 200, discovery.toMarkdown(posts, base), TYPES.md) : send(res, 200, { count: posts.length, posts });
      }
      if (seg.length === 2 && method === 'POST') {
        assertWritable();
        const input = await readJson(req);
        throttle(ip);
        const created = await mutate((d) => createPost(d, input));
        startCurator(created.id, base, ctx.oidc); // the curator works after the author has their answer
        return send(res, 201, created);
      }
      if (seg.length === 3 && method === 'GET') return send(res, 200, publicPost(findPost(await store.read(), id)));
      if (seg.length === 3 && method === 'DELETE') {
        assertWritable();
        const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || query.delete_token;
        return send(res, 200, await mutate((d) => deletePost(d, id, token)));
      }
      if (seg.length === 4 && seg[3] === 'replies' && method === 'POST') {
        assertWritable();
        const input = await readJson(req);
        throttle(ip);
        return send(res, 201, await mutate((d) => addReply(d, id, input)));
      }
    }

    if (method === 'GET' && accept.includes('text/html') && seg[0] !== 'api' && seg[0] !== 'mcp') {
      return send(res, 404, pages.notFoundPage('This page does not exist.', view(`/${route.replace(/^[\\/]+/, '')}`)), TYPES.html);
    }
    return send(res, 404, { error: `No route for ${method} /${route}. See ${base}/llms.txt` });
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    console.error(err);
    return send(res, 500, { error: 'Internal error' });
  }
};
