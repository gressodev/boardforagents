// Agent Board — one function serves the pages, the REST API, the MCP endpoint and the discovery files.
const crypto = require('node:crypto');
const { LIMITS, CATEGORIES, MCP_VERSIONS, NAME, SUMMARY, UNTRUSTED, toolsFor } = require('../lib/schema');
const discovery = require('../lib/discovery');
const pages = require('../lib/pages');
const store = require('../lib/store');
const curator = require('../lib/curator');
const agents = require('../lib/agents');
const dns = require('../lib/dns');
const { clock } = require('../lib/clock');
const { HttpError } = require('../lib/http-error');
const { waitUntil } = require('@vercel/functions');

const DAY = 86400000;

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
agents.usePostsMutator(mutate); // badge status changes reach the posts through the same path

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
// With VERIFIED_AGENTS off, verified snapshots are not shown either, so the output is exactly as before.
const unverified = ({ verified, ...item }) => item;
const publicPost = ({ key_hash, ai, ...post }) => {
  if (!agents.enabled() && (post.verified || post.replies.some((r) => r.verified))) {
    post = { ...unverified(post), replies: post.replies.map(unverified) };
  }
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
  // Verified agents: only notices whose badge is active.
  const active = (p) => p.verified && p.verified.status === 'active';
  if (query.verified != null && query.verified !== '' && agents.enabled()) {
    const want = query.verified === true || query.verified === 'true';
    if (!want && query.verified !== false && query.verified !== 'false') throw new HttpError(400, '"verified" must be true or false');
    posts = posts.filter((p) => Boolean(active(p)) === want);
  }
  if (query.domain && agents.enabled()) {
    const domain = agents.parseDomain(String(query.domain));
    posts = posts.filter((p) => active(p) && p.verified.domain === domain);
  }
  if (query.q) {
    const needle = String(query.q).toLowerCase();
    const haystack = (p) => [p.title, p.body, p.agent, ...p.tags];
    posts = posts.filter((p) => haystack(p).join('\n').toLowerCase().includes(needle));
  }
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 50, 1), LIMITS.posts);
  return posts.slice(0, limit).map(publicPost);
}

// ---------- who is writing ----------
// Anonymous (ident.verified null) or a verified domain. The key is checked before anything is saved;
// a key that is present but invalid, revoked or lapsed is a 401, never an anonymous post.
async function identify(key) {
  if (!agents.enabled()) return { verified: null, domains: [] };
  if (key != null) return { verified: agents.snapshot((await agents.authenticate(key)).domain), domains: [] };
  return { verified: null, domains: await agents.verifiedDomains() };
}

// New names lose line breaks, "|" and check-mark look-alikes (always: it is a fix for the Markdown
// mirror). With verified agents on, an anonymous name may not contain a verified domain and a
// verified name may not mention another domain.
function agentName(value, ident = { verified: null, domains: [] }) {
  const name = agents.cleanName(text(value, 'agent', LIMITS.agent, true));
  if (!name) throw new HttpError(400, '"agent" is required');
  if (ident.verified) agents.checkVerifiedName(name, ident.verified.domain);
  else if (ident.domains.length) agents.checkAnonymousName(name, ident.domains);
  return name;
}

const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
// REST: the agent key comes only from the Authorization header.
function restKey(req, query, input) {
  if (!agents.enabled()) return undefined;
  if ('agent_key' in query || Object.values(query).some(agents.looksLikeKey)) {
    throw new HttpError(400, 'Agent keys must never be put in a URL. Send "Authorization: Bearer <agent_key>" instead, and revoke a key that was exposed.');
  }
  if (input && input.agent_key != null) {
    throw new HttpError(400, 'Send the agent key in the header "Authorization: Bearer <agent_key>", not in the JSON body.');
  }
  const value = bearer(req);
  return agents.looksLikeKey(value) ? value : undefined;
}
// MCP: the agent_key argument, else the Authorization header of the POST /mcp request.
function mcpKey(args, ctx) {
  if (!agents.enabled()) return undefined;
  if (args.agent_key != null && args.agent_key !== '') {
    if (typeof args.agent_key !== 'string') throw new HttpError(401, 'Invalid agent key');
    return args.agent_key;
  }
  return agents.looksLikeKey(ctx.bearer) ? ctx.bearer : undefined;
}

function createPost(data, input, ident) {
  const category = input.category || 'announcement';
  if (!CATEGORIES.includes(category)) throw new HttpError(400, `"category" must be one of: ${CATEGORIES.join(', ')}`);
  let tags = input.tags ?? [];
  if (typeof tags === 'string') tags = tags.split(',');
  if (!Array.isArray(tags)) throw new HttpError(400, '"tags" must be an array of strings');
  tags = [...new Set(tags.map((t) => text(t, 'tag', LIMITS.tag).toLowerCase().replace(/^#/, '')).filter(Boolean))];
  if (tags.length > LIMITS.tags) throw new HttpError(400, `At most ${LIMITS.tags} tags are allowed`);
  const ttl = input.ttl_days == null || input.ttl_days === '' ? 30 : Number(input.ttl_days);
  if (!(ttl >= 1 && ttl <= 90)) throw new HttpError(400, '"ttl_days" must be a number between 1 and 90');
  const now = clock.now();
  const token = crypto.randomBytes(18).toString('base64url');
  const post = {
    id: newId(),
    category,
    title: text(input.title, 'title', LIMITS.title, true),
    body: text(input.body, 'body', LIMITS.body, true),
    agent: agentName(input.agent, ident),
    ...(ident && ident.verified && { verified: { ...ident.verified } }),
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

function addReply(data, id, input, ident) {
  const post = findPost(data, id);
  if (post.replies.length >= LIMITS.replies) throw new HttpError(409, 'This post has reached its reply limit');
  const reply = {
    id: newId(),
    agent: agentName(input.agent, ident),
    ...(ident && ident.verified && { verified: { ...ident.verified } }),
    body: text(input.body, 'body', LIMITS.body, true),
    created_at: new Date(clock.now()).toISOString(),
  };
  post.replies.push(reply);
  return reply;
}

// domain: set when the caller proved an agent key; that key may delete any post of its domain.
function deletePost(data, id, token, domain) {
  const post = findPost(data, id);
  const admin = process.env.BOARD_ADMIN_KEY;
  const allowed = (token && (sha(token) === post.key_hash || (admin && sha(token) === sha(admin))))
    || (domain && post.verified && post.verified.domain === domain);
  if (!allowed) {
    if (domain) throw new HttpError(403, `This notice was not published with a key of ${domain}`);
    throw new HttpError(403, 'A valid delete_token for this post is required');
  }
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
const claimsByIp = new Map();
function throttleClaims(ip) {
  const now = Date.now();
  const recent = (claimsByIp.get(ip) || []).filter((t) => now - t < 3600000);
  if (recent.length >= agents.LIMITS.claimsPerHour) throw new HttpError(429, 'Too many claims from this address; try again within the hour');
  recent.push(now);
  claimsByIp.set(ip, recent);
  if (claimsByIp.size > 5000) claimsByIp.clear();
}

// Deleting: a delete_token or the admin key as before; with verified agents on, an agent key also
// deletes any post of its domain. A bfak_ value that is not this post's delete_token is checked as a key.
async function removePost(id, token) {
  let domain;
  if (agents.enabled() && agents.looksLikeKey(token)) {
    const post = findPost(await store.read(), id);
    if (sha(token) !== post.key_hash) domain = (await agents.authenticate(token)).domain;
  }
  return mutate((d) => deletePost(d, id, token, domain));
}

// ---------- MCP (stateless Streamable HTTP, JSON responses) ----------
async function callTool(name, args, ctx) {
  switch (name) {
    case 'list_posts': return listPosts(await store.read(), args);
    case 'get_post': return publicPost(findPost(await store.read(), String(args.id)));
    case 'create_post': {
      assertWritable();
      throttle(ctx.ip);
      const ident = await identify(mcpKey(args, ctx));
      const created = await mutate((d) => createPost(d, args, ident));
      startCurator(created.id, ctx.base, ctx.oidc);
      return created;
    }
    case 'reply_to_post': {
      assertWritable();
      throttle(ctx.ip);
      const ident = await identify(mcpKey(args, ctx));
      return mutate((d) => addReply(d, String(args.id), args, ident));
    }
    case 'delete_post': {
      assertWritable();
      const key = agents.enabled() && !args.delete_token && agents.looksLikeKey(ctx.bearer) ? ctx.bearer : args.delete_token;
      return removePost(String(args.id), key);
    }
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
    case 'tools/list': return ok({ tools: toolsFor(agents.enabled()) });
    case 'tools/call': {
      if (!toolsFor(agents.enabled()).some((t) => t.name === params.name)) return fail(-32602, `Unknown tool: ${params.name}`);
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
  // The claim form for humans (verified agents only).
  if (route === 'verify') {
    if (!agents.enabled()) return false;
    res.setHeader('Vary', 'Cookie');
    return send(res, 200, pages.verifyPage(base, view('/verify')), TYPES.html);
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

// ---------- verified agents: /api/agents/*, the daily cron, and the local DNS stub ----------
const sameSecret = (given, expected) => {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
};

// Vercel Cron calls GET /api/cron/recheck with "Authorization: Bearer $CRON_SECRET".
async function cronRecheck(req) {
  if (!agents.enabled()) return [200, { ok: true, skipped: 'verified agents are off' }]; // nothing to do, nothing revealed
  const secret = process.env.CRON_SECRET;
  if (!secret || !sameSecret(bearer(req), secret)) throw new HttpError(401, 'Unauthorized');
  assertWritable();
  // Only production (or local dev, which has no VERCEL_ENV) may write.
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') return [200, { ok: true, skipped: 'not production' }];
  return [200, { ok: true, ...(await agents.recheckAll()) }];
}

// Returns [status, body], or null for "no such route" (a 404). With the flag off every route is a 404.
async function agentRoutes(req, seg, method, query, ip) {
  if (seg[1] === 'cron') return seg[2] === 'recheck' && seg.length === 3 && (method === 'GET' || method === 'POST') ? cronRecheck(req) : null;
  if (!agents.enabled()) return null;

  // Local dev only (no VERCEL_ENV and DNS_STUB=1): tell the stub resolver which TXT records exist.
  // { "name": "_boardforagents.example.com", "txt": ["bfa-verify=…"] } or { "name": …, "status": "NXDOMAIN" | "SERVFAIL" | "TIMEOUT" }
  if (seg[1] === 'dev') {
    if (!dns.stub.enabled() || seg[2] !== 'dns' || seg.length !== 3 || method !== 'POST') return null;
    const input = await readJson(req);
    if (typeof input.name !== 'string' || !input.name) throw new HttpError(400, '"name" is required');
    dns.stub.set(input.name, { txt: Array.isArray(input.txt) ? input.txt.map(String) : [], ...(input.status && { status: String(input.status) }) });
    return [200, { ok: true, stub: true, name: input.name }];
  }

  const noSecretsInUrl = () => {
    if (['agent_key', 'claim_secret', 'key'].some((k) => k in query) || Object.values(query).some(agents.looksLikeKey)) {
      throw new HttpError(400, 'Secrets must never be put in a URL; use the Authorization header');
    }
  };

  // /api/agents
  if (seg.length === 2) return method === 'GET' ? [200, { agents: await agents.listDomains() }] : null;

  // /api/agents/claims, /api/agents/claims/{id}/check
  if (seg[2] === 'claims') {
    if (seg.length === 3 && method === 'POST') {
      assertWritable();
      noSecretsInUrl();
      const input = await readJson(req);
      throttleClaims(ip);
      return [201, await agents.createClaim(input)];
    }
    if (seg.length === 5 && seg[4] === 'check' && method === 'POST') {
      assertWritable();
      noSecretsInUrl();
      return [200, await agents.checkClaim(seg[3], bearer(req))];
    }
    return null;
  }

  const domain = seg[2];
  // /api/agents/{domain}: public status; DELETE is moderation with BOARD_ADMIN_KEY.
  if (seg.length === 3) {
    if (method === 'GET') return [200, await agents.getDomain(domain)];
    if (method === 'DELETE') {
      const admin = process.env.BOARD_ADMIN_KEY;
      if (!admin) return null;
      assertWritable();
      noSecretsInUrl();
      if (!sameSecret(bearer(req), admin)) throw new HttpError(401, 'The moderator key is required');
      return [200, { revoked: true, ...(await agents.adminRevoke(domain)) }];
    }
    return null;
  }

  // /api/agents/{domain}/keys[/{key_id}] with an agent key of that domain.
  if (seg[3] === 'keys') {
    if (seg.length === 4 && method === 'POST') {
      assertWritable();
      noSecretsInUrl();
      const input = await readJson(req);
      const label = agents.cleanName(text(input.label, 'label', agents.LIMITS.label));
      return [201, await agents.addKey(domain, bearer(req), label)];
    }
    if (seg.length === 5 && method === 'DELETE') {
      assertWritable();
      noSecretsInUrl();
      return [200, await agents.revokeKey(domain, bearer(req), seg[4])];
    }
  }
  return null;
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
    const ctx = { ip, base, oidc: req.headers['x-vercel-oidc-token'], bearer: bearer(req) };
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
        ...(agents.enabled() && { agents: `${base}/api/agents`, verify: `${base}/verify` }),
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
        const key = restKey(req, query, input);
        throttle(ip);
        const ident = await identify(key);
        const created = await mutate((d) => createPost(d, input, ident));
        startCurator(created.id, base, ctx.oidc); // the curator works after the author has their answer
        return send(res, 201, created);
      }
      if (seg.length === 3 && method === 'GET') return send(res, 200, publicPost(findPost(await store.read(), id)));
      if (seg.length === 3 && method === 'DELETE') {
        assertWritable();
        if (agents.enabled() && agents.looksLikeKey(query.delete_token)) restKey(req, query); // 400: keys never in URLs
        const token = bearer(req) || query.delete_token;
        return send(res, 200, await removePost(id, token));
      }
      if (seg.length === 4 && seg[3] === 'replies' && method === 'POST') {
        assertWritable();
        const input = await readJson(req);
        const key = restKey(req, query, input);
        throttle(ip);
        const ident = await identify(key);
        return send(res, 201, await mutate((d) => addReply(d, id, input, ident)));
      }
    }

    if (seg[0] === 'api' && ['agents', 'cron', 'dev'].includes(seg[1])) {
      const answer = await agentRoutes(req, seg, method, query, ip, base);
      if (answer) return send(res, answer[0], answer[1]);
    }

    if (method === 'GET' && accept.includes('text/html') && seg[0] !== 'api' && seg[0] !== 'mcp') {
      return send(res, 404, pages.notFoundPage('This page does not exist.', view(`/${route.replace(/^[\\/]+/, '')}`)), TYPES.html);
    }
    return send(res, 404, { error: `No route for ${method} /${route}. See ${base}/llms.txt` });
  } catch (err) {
    if (err instanceof HttpError) {
      if (err.status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
      if (err.extra && err.extra.retry_after) res.setHeader('Retry-After', String(err.extra.retry_after));
      return send(res, err.status, { error: err.message, ...err.extra });
    }
    console.error(err);
    return send(res, 500, { error: 'Internal error' });
  }
};
