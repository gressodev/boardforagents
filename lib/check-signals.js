// The agent-ready site checker: parsers for what was fetched (HTML, robots.txt, sitemaps, Link headers)
// and the signals computed from them. Everything here is pure: lib/checker.js does the fetching.
//
// All input is untrusted text from an arbitrary website. The parsers use indexOf scanning and short,
// linear regular expressions only (no nested quantifiers over the whole document), cap every list, and
// never execute or follow anything. Rendering (lib/pages.js) escapes every string taken from here.

// ---------- small helpers ----------
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8}|#39);/gi, (all, code) => {
    const lower = code.toLowerCase();
    if (lower.startsWith('#x')) return safeChar(parseInt(lower.slice(2), 16), all);
    if (lower.startsWith('#')) return safeChar(parseInt(lower.slice(1), 10), all);
    return ENTITIES[lower] ?? all;
  });
}
const safeChar = (n, fallback) => (n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : fallback);
// One line of plain text: no control characters, collapsed whitespace, at most max characters.
function clean(text, max = 300) {
  const one = decodeEntities(String(text ?? '')).replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  const chars = Array.from(one);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : one;
}
const absolute = (href, base) => {
  try {
    const url = new URL(String(href).trim(), base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
};
const sameSite = (a, b) => {
  try {
    const strip = (h) => h.replace(/^www\./, '');
    return strip(new URL(a).hostname) === strip(new URL(b).hostname);
  } catch { return false; }
};

// Replaces every <…> tag with a space. Linear: a "<" without a closing ">" ends the scan.
function stripTags(html) {
  const parts = [];
  let at = 0;
  for (;;) {
    const lt = html.indexOf('<', at);
    if (lt === -1) { parts.push(html.slice(at)); break; }
    parts.push(html.slice(at, lt));
    const gt = html.indexOf('>', lt + 1);
    if (gt === -1) break;
    parts.push(' ');
    at = gt + 1;
  }
  return parts.join('');
}

// Attributes of one tag's attribute string, names lowercased. The string is capped first.
function attributes(raw) {
  const out = {};
  const re = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g;
  let m;
  const text = String(raw).slice(0, 4096);
  while ((m = re.exec(text))) {
    const name = m[1].toLowerCase();
    if (!(name in out)) out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

// The ">" that closes a tag, skipping ">" inside quoted attribute values like a browser does. The quote-aware
// scan looks at most TAG_SCAN characters; past that (or with an unclosed quote) the first ">" is used, so the
// work per tag stays bounded.
const TAG_SCAN = 8192;
function tagEnd(lower, from) {
  let quote = null;
  const stop = Math.min(lower.length, from + TAG_SCAN);
  for (let j = from; j < stop; j++) {
    const ch = lower[j];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") {
      if (/[=\s]/.test(lower[j - 1])) quote = ch; // a value starts after "=" (or a space after it)
      continue;
    }
    if (ch === '>') return j;
  }
  return lower.indexOf('>', from);
}

// Opening tags <name …> (void or not): attribute strings, at most `max`.
function openTags(html, lower, name, max = 500) {
  const out = [];
  const open = `<${name}`;
  let i = 0;
  while (out.length < max && (i = lower.indexOf(open, i)) !== -1) {
    const next = lower[i + open.length];
    if (next !== undefined && !/[\s/>]/.test(next)) { i += open.length; continue; }
    const gt = tagEnd(lower, i + open.length);
    if (gt === -1) break;
    out.push({ attrs: html.slice(i + open.length, gt), start: i, end: gt + 1 });
    i = gt + 1;
  }
  return out;
}

// Elements <name …>inner</name>: attribute string and inner text, at most `max`. Linear in the input.
function elements(html, lower, name, max = 200) {
  const out = [];
  const close = `</${name}`;
  for (const tag of openTags(html, lower, name, max)) {
    if (out.length && tag.start < out[out.length - 1].end) continue; // inside the previous element
    const end = lower.indexOf(close, tag.end);
    const stop = end === -1 ? html.length : end;
    const after = end === -1 ? html.length : (lower.indexOf('>', end) + 1 || html.length);
    out.push({ attrs: tag.attrs, inner: html.slice(tag.end, stop), start: tag.start, end: after });
  }
  return out;
}

// Removes whole elements (script, style, …) and comments, returning the rest.
function withoutBlocks(html, names) {
  let lower = html.toLowerCase();
  let text = html;
  const ranges = [];
  for (const name of names) for (const el of elements(text, lower, name, 5000)) ranges.push([el.start, el.end]);
  let i = 0;
  while ((i = lower.indexOf('<!--', i)) !== -1) {
    const end = lower.indexOf('-->', i + 4);
    ranges.push([i, end === -1 ? text.length : end + 3]);
    i = end === -1 ? text.length : end + 3;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const parts = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start));
    at = Math.max(at, end);
  }
  parts.push(text.slice(at));
  lower = null;
  return parts.join(' ');
}

// ---------- HTML ----------
const SPA_IDS = new Set(['root', 'app', '__next', '__nuxt', 'svelte', 'q-app']);

// Everything the signals and the starter files need from one HTML document.
function parseHtml(html, baseUrl) {
  const text = String(html || '');
  const lower = text.toLowerCase();
  const htmlTag = openTags(text, lower, 'html', 1)[0];
  const lang = htmlTag ? clean(attributes(htmlTag.attrs).lang || '', 35) : '';
  const titleEl = elements(text, lower, 'title', 1)[0];
  const title = titleEl ? clean(titleEl.inner, 200) : '';

  const metas = openTags(text, lower, 'meta').map((t) => attributes(t.attrs));
  const meta = (key) => {
    const found = metas.find((m) => (m.name || m.property || '').toLowerCase() === key && m.content != null);
    return found ? clean(found.content, 400) : '';
  };
  const links = openTags(text, lower, 'link').map((t) => attributes(t.attrs))
    .map((a) => ({ rel: (a.rel || '').toLowerCase().split(/\s+/).filter(Boolean), type: (a.type || '').toLowerCase(), href: absolute(a.href || '', baseUrl), title: clean(a.title || '', 120) }))
    .filter((l) => l.href);
  const linkWith = (rel, type) => links.find((l) => l.rel.includes(rel) && (!type || l.type.split(';')[0].trim() === type));
  const canonicalLink = linkWith('canonical');

  // JSON-LD blocks: parse each (capped), record the @types.
  const jsonLd = [];
  for (const el of elements(text, lower, 'script', 400)) {
    const type = (attributes(el.attrs).type || '').toLowerCase().trim();
    if (type !== 'application/ld+json' || jsonLd.length >= 20) continue;
    const raw = el.inner.trim();
    try {
      const data = JSON.parse(raw.length > 200000 ? '' : raw);
      jsonLd.push({ ok: true, types: ldTypes(data) });
    } catch {
      jsonLd.push({ ok: false, types: [] });
    }
  }
  const scripts = openTags(text, lower, 'script', 2000).length;

  // Visible text: no head, scripts, styles, templates or inline SVG.
  const visible = clean(stripTags(withoutBlocks(text, ['head', 'script', 'style', 'noscript', 'template', 'svg'])), 1e7);
  const words = visible ? visible.split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0;
  // An empty mount point such as <div id="root"></div> or <app-root></app-root>.
  const emptyAfter = (tag, name) => lower.slice(tag.end, tag.end + 200).trimStart().startsWith(`</${name}`);
  const spaRoot = ['div', 'main'].some((name) => openTags(text, lower, name, 2000).some((t) => SPA_IDS.has(attributes(t.attrs).id) && emptyAfter(t, name)))
    || openTags(text, lower, 'app-root', 5).some((t) => emptyAfter(t, 'app-root'));

  // Links for the starter files: navigation first (nav, header), then the rest of the page; same site only.
  const anchors = [];
  const seen = new Set();
  const addAnchors = (chunk) => {
    const chunkLower = chunk.toLowerCase();
    for (const el of elements(chunk, chunkLower, 'a', 400)) {
      if (anchors.length >= 25) return;
      const href = absolute(attributes(el.attrs).href || '', baseUrl);
      const label = clean(stripTags(el.inner.slice(0, 2000)), 80);
      if (!href || !label || !sameSite(href, baseUrl) || seen.has(href)) continue;
      seen.add(href);
      anchors.push({ href, text: label });
    }
  };
  for (const el of [...elements(text, lower, 'nav', 10), ...elements(text, lower, 'header', 5)]) addAnchors(el.inner);
  addAnchors(text);

  return {
    lang,
    title,
    description: meta('description'),
    og: { title: meta('og:title'), description: meta('og:description') },
    canonical: canonicalLink ? canonicalLink.href : '',
    markdownAlternate: linkWith('alternate', 'text/markdown')?.href || '',
    mcpLink: linkWith('mcp')?.href || '',
    serviceDesc: linkWith('service-desc')?.href || '',
    serviceDoc: linkWith('service-doc')?.href || '',
    sitemapLink: linkWith('sitemap')?.href || '',
    jsonLd,
    scripts,
    words,
    textLength: visible.length,
    spaRoot,
    anchors,
    bytes: Buffer.byteLength(text),
  };
}

function ldTypes(data, out = new Set(), depth = 0) {
  if (depth > 4 || out.size >= 12 || data == null || typeof data !== 'object') return [...out];
  const list = Array.isArray(data) ? data : [data];
  for (const item of list.slice(0, 50)) {
    if (!item || typeof item !== 'object') continue;
    const t = item['@type'];
    for (const one of Array.isArray(t) ? t : [t]) if (typeof one === 'string' && one) out.add(clean(one, 60));
    if (item['@graph']) ldTypes(item['@graph'], out, depth + 1);
  }
  return [...out];
}

// "<a>; rel=x; type=y, <b>; rel=z" → [{ href, rel: [...], type }]
function parseLinkHeader(value, baseUrl) {
  const out = [];
  const re = /<([^>]*)>([^<]*)/g;
  let m;
  const text = String(value || '').slice(0, 8192);
  while ((m = re.exec(text)) && out.length < 50) {
    const params = m[2];
    const rel = (/;\s*rel\s*=\s*"?([^";,]+)"?/i.exec(params) || [])[1] || '';
    const type = (/;\s*type\s*=\s*"?([^";,]+)"?/i.exec(params) || [])[1] || '';
    const href = absolute(m[1], baseUrl);
    if (href) out.push({ href, rel: rel.toLowerCase().split(/\s+/).filter(Boolean), type: type.toLowerCase() });
  }
  return out;
}

// ---------- robots.txt ----------
const AI_CRAWLERS = ['GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot', 'Claude-User',
  'Google-Extended', 'PerplexityBot', 'Perplexity-User', 'CCBot', 'Applebot-Extended', 'Amazonbot', 'meta-externalagent', 'Bytespider'];

function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let current = null;
  let lastWasAgent = false;
  for (const line of String(text || '').split(/\r\n|\r|\n/).slice(0, 5000)) {
    const stripped = line.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]{1,40})\s*:\s*(.*)$/.exec(stripped);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim().slice(0, 500);
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) groups.push(current = { agents: [], rules: [] });
      current.agents.push(value.toLowerCase().split('/')[0].trim());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (field === 'sitemap') {
      if (value && sitemaps.length < 20) sitemaps.push(value);
    } else if ((field === 'allow' || field === 'disallow') && current) {
      if (value || field === 'allow') current.rules.push({ allow: field === 'allow', path: value });
    }
  }
  return { groups, sitemaps };
}

function pathMatches(pattern, path) {
  if (!pattern) return false;
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`).test(path);
}

// Is `path` allowed for `agent`? Google's rules: the most specific matching group, then the longest
// matching rule; on a tie Allow wins. No matching group or rule: allowed.
function robotsAllows(parsed, agent, path) {
  const token = agent.toLowerCase();
  let rules = parsed.groups.filter((g) => g.agents.includes(token)).flatMap((g) => g.rules);
  let via = 'explicit';
  if (!parsed.groups.some((g) => g.agents.includes(token))) {
    rules = parsed.groups.filter((g) => g.agents.includes('*')).flatMap((g) => g.rules);
    via = parsed.groups.some((g) => g.agents.includes('*')) ? 'wildcard' : 'default';
  }
  let best = null;
  for (const rule of rules) {
    if (!pathMatches(rule.path, path)) continue;
    if (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow)) best = rule;
  }
  return { allowed: !best || best.allow, via };
}

// Per AI crawler: allowed (home and inner pages), blocked (neither) or partial.
function aiCrawlerAccess(parsed) {
  return AI_CRAWLERS.map((bot) => {
    const home = robotsAllows(parsed, bot, '/');
    const inner = robotsAllows(parsed, bot, '/some/page');
    const status = home.allowed && inner.allowed ? 'allowed' : !home.allowed && !inner.allowed ? 'blocked' : 'partial';
    return { bot, status, via: home.via };
  });
}

// ---------- sitemaps ----------
function parseSitemap(text) {
  const body = String(text || '');
  const lower = body.toLowerCase();
  const kind = lower.includes('<urlset') ? 'urlset' : lower.includes('<sitemapindex') ? 'index' : null;
  const locs = elements(body, lower, 'loc', 50).map((el) => clean(el.inner, 2048)).filter((u) => /^https?:\/\//i.test(u));
  return { kind, locs };
}

// ---------- fetched files ----------
const ok = (r) => Boolean(r && !r.error && r.status >= 200 && r.status < 300);
const looksHtml = (r) => r.type === 'text/html' || r.type === 'application/xhtml+xml' || /^\s*<(!doctype|html|head|body)\b/i.test(r.text.slice(0, 512));
// A plain-text file that really exists: 2xx, not an HTML soft-404 page, not empty.
function textFile(r) {
  if (!r) return { ok: false, reason: 'not checked' };
  if (r.error) return { ok: false, reason: r.error.code === 'budget' || r.error.code === 'aborted' ? 'not checked (time or request budget used up)' : r.error.message, error: r.error.code };
  if (!ok(r)) return { ok: false, reason: `HTTP ${r.status}` };
  if (r.skipped) return { ok: false, reason: `unexpected content type ${r.type}` };
  if (looksHtml(r)) return { ok: false, reason: 'an HTML page came back (probably a soft 404)' };
  if (!r.text.trim()) return { ok: false, reason: 'the file is empty' };
  return { ok: true };
}
const jsonOf = (r) => {
  if (!ok(r) || r.skipped) return null;
  try { const data = JSON.parse(r.text); return data && typeof data === 'object' ? data : null; } catch { return null; }
};
const notChecked = (r) => r && r.error && (r.error.code === 'budget' || r.error.code === 'aborted');

// URLs found in an MCP server card, whatever draft shape it uses.
function mcpEndpoints(card, baseUrl) {
  const out = new Set();
  const add = (v) => { const url = typeof v === 'string' ? absolute(v, baseUrl) : null; if (url && out.size < 5) out.add(url); };
  if (!card || typeof card !== 'object') return [];
  add(card.endpoint); add(card.url);
  if (card.transport && typeof card.transport === 'object') { add(card.transport.endpoint); add(card.transport.url); }
  for (const key of ['remotes', 'servers', 'endpoints', 'transports']) {
    const list = card[key];
    if (Array.isArray(list)) for (const item of list.slice(0, 10)) item && typeof item === 'object' ? (add(item.url), add(item.endpoint)) : add(item);
  }
  if (card.mcpServers && typeof card.mcpServers === 'object') for (const s of Object.values(card.mcpServers).slice(0, 10)) if (s && typeof s === 'object') add(s.url);
  return [...out];
}

// ---------- signals ----------
const WEIGHTS = { https: 10, robots: 8, sitemap: 8, llms_txt: 12, mcp: 8, api_catalog: 8, skill_md: 6, structured_data: 8, markdown: 8, ssr: 10, meta: 8, security_txt: 6 };
const LABELS = {
  https: 'HTTPS', robots: 'robots.txt and AI crawlers', sitemap: 'Sitemap', llms_txt: '/llms.txt', mcp: 'MCP server discovery',
  api_catalog: 'API catalog / OpenAPI', skill_md: 'Agent skill (skill.md)', structured_data: 'Structured data (JSON-LD)',
  markdown: 'Markdown for agents', ssr: 'Content without JavaScript', meta: 'Title, description and Open Graph', security_txt: 'security.txt',
};
const signal = (id, status, detail, fix, data) => ({ id, label: LABELS[id], status, weight: WEIGHTS[id], detail, fix, ...(data && { data }) });

function httpsSignal(f) {
  const final = new URL(f.page.url);
  const hsts = Boolean(f.page.headers['strict-transport-security']);
  if (final.protocol !== 'https:') {
    return signal('https', 'fail', `The page was served over plain HTTP (${final.host}) and did not redirect to HTTPS.`,
      'Serve the site over HTTPS and redirect every http:// request to https:// with a 301.');
  }
  const redirected = f.inputScheme === 'http' && (f.page.redirects || []).length > 0;
  const v = f.httpVariant;
  if (redirected || (v && !v.error && v.status >= 300 && v.status < 400 && /^https:/i.test(v.location || ''))) {
    return signal('https', 'pass', `Served over HTTPS; http:// redirects to https://.${hsts ? ' HSTS is set.' : ''}`,
      hsts ? 'Nothing to fix.' : 'Optional: add a Strict-Transport-Security header.');
  }
  if (v && !v.error && v.status >= 200 && v.status < 300) {
    return signal('https', 'warn', 'Served over HTTPS, but the http:// address answers with a page instead of redirecting to HTTPS.',
      'Redirect every http:// request to the https:// URL with a 301 and add a Strict-Transport-Security header.');
  }
  return signal('https', 'pass', `Served over HTTPS.${v && v.error ? ' The http:// address did not answer, so nothing is served insecurely.' : ''}${hsts ? ' HSTS is set.' : ''}`,
    'Nothing to fix.');
}

function robotsSignal(f, robots) {
  const file = textFile(f.robots);
  if (!file.ok) {
    if (notChecked(f.robots)) return signal('robots', 'warn', `robots.txt was ${file.reason}.`, 'Run the check again.');
    return signal('robots', 'warn', `No robots.txt (${file.reason}). Crawlers may crawl everything, but there is nowhere to list your sitemap or state your AI policy.`,
      'Add /robots.txt with the AI crawlers you allow and a Sitemap: line (see the starter snippet below).');
  }
  const access = aiCrawlerAccess(robots);
  const blocked = access.filter((a) => a.status === 'blocked').map((a) => a.bot);
  const partial = access.filter((a) => a.status === 'partial').map((a) => a.bot);
  const explicit = access.filter((a) => a.via === 'explicit').map((a) => a.bot);
  const data = { ai_crawlers: access, sitemaps: robots.sitemaps.slice(0, 5) };
  const parts = [`robots.txt found (${robots.groups.length} group${robots.groups.length === 1 ? '' : 's'}).`];
  if (explicit.length) parts.push(`Named AI crawlers: ${explicit.join(', ')}.`);
  if (blocked.length === access.length) {
    parts.push('Every AI crawler checked is blocked from the site.');
    return signal('robots', 'warn', parts.join(' '), 'If you want AI assistants and agents to read your site, allow at least the user agents (ChatGPT-User, Claude-User, Perplexity-User) and search crawlers (OAI-SearchBot, Claude-SearchBot, PerplexityBot).', data);
  }
  if (blocked.length) parts.push(`Blocked: ${blocked.join(', ')}.`);
  if (partial.length) parts.push(`Partly blocked: ${partial.join(', ')}.`);
  if (!blocked.length && !partial.length) parts.push('All AI crawlers checked are allowed.');
  return signal('robots', 'pass', parts.join(' '),
    blocked.length || partial.length ? 'Fine if deliberate. Review the blocked crawlers: user agents such as ChatGPT-User and Claude-User fetch pages on behalf of a person.' : 'Nothing to fix.', data);
}

function sitemapSignal(f, robots, sitemap) {
  const where = f.sitemapSource === 'robots' ? 'listed in robots.txt' : f.sitemapSource === 'link' ? 'linked from the page' : 'at /sitemap.xml';
  if (sitemap && sitemap.kind) {
    return signal('sitemap', 'pass', `Sitemap ${where} (${sitemap.kind === 'index' ? 'sitemap index' : 'URL set'}, ${sitemap.locs.length}${sitemap.locs.length >= 50 ? '+' : ''} URLs read).`,
      f.sitemapSource === 'robots' ? 'Nothing to fix.' : 'Also list it in robots.txt with a "Sitemap:" line.', { url: f.sitemap.url });
  }
  if (notChecked(f.sitemap)) return signal('sitemap', 'warn', 'The sitemap could not be checked in time.', 'Run the check again.');
  if (robots.sitemaps.length || f.sitemapSource === 'link') {
    const reason = f.sitemap && f.sitemap.error ? f.sitemap.error.message : f.sitemap ? `HTTP ${f.sitemap.status}, no <urlset> or <sitemapindex>` : 'not fetched';
    return signal('sitemap', 'warn', `A sitemap is declared but could not be read (${reason}).`, 'Make sure the sitemap URL answers 200 with valid sitemap XML.');
  }
  return signal('sitemap', 'fail', 'No sitemap: none in robots.txt and nothing valid at /sitemap.xml.',
    'Publish /sitemap.xml listing your important pages and add "Sitemap: https://<your host>/sitemap.xml" to robots.txt.');
}

function llmsSignal(f) {
  const file = textFile(f.llms);
  const full = textFile(f.llmsFull).ok;
  const bonus = full ? ' /llms-full.txt is there too.' : '';
  if (!file.ok) {
    if (notChecked(f.llms)) return signal('llms_txt', 'warn', '/llms.txt could not be checked in time.', 'Run the check again.');
    return signal('llms_txt', 'fail', `No /llms.txt (${file.reason}).${bonus}`,
      'Publish /llms.txt: a Markdown file that starts with "# <site name>", a "> one-line summary" and sections of links to your key pages (see the starter file below).');
  }
  const text = f.llms.text.replace(/^﻿/, '');
  const h1 = /^# \S/.test(text);
  const links = (text.match(/\[[^\]\n]{1,200}\]\([^)\s]{1,2048}\)/g) || []).length;
  const summary = /^>\s*\S/m.test(text);
  const data = { h1, summary, links, llms_full: full, truncated: Boolean(f.llms.truncated) };
  if (!h1) {
    return signal('llms_txt', 'warn', `/llms.txt exists but does not start with "# " and a title.${bonus}`,
      'Start the file with "# <site name>" on the first line, then "> one-line summary", then sections of Markdown links.', data);
  }
  return signal('llms_txt', 'pass', `/llms.txt found: title line, ${summary ? 'a summary, ' : 'no "> summary" line, '}${links} Markdown link${links === 1 ? '' : 's'}.${bonus}`,
    summary && links ? (full ? 'Nothing to fix.' : 'Optional: add /llms-full.txt with the full text of your docs.') : 'Add a "> summary" line and Markdown links to your key pages.', data);
}

function mcpSignal(f, html, linkHeader) {
  const cards = [['/.well-known/mcp.json', f.mcpCard], ['/.well-known/mcp/server-card.json', f.mcpCardAlt]];
  const endpoints = new Set();
  let cardAt = null;
  for (const [path, r] of cards) {
    const data = jsonOf(r);
    if (!data) continue;
    cardAt = cardAt || path;
    for (const e of mcpEndpoints(data, r.url)) endpoints.add(e);
  }
  for (const l of linkHeader) if (l.rel.includes('mcp')) endpoints.add(l.href);
  if (html && html.mcpLink) endpoints.add(html.mcpLink);
  const list = [...endpoints].slice(0, 5);
  if (list.length) {
    return signal('mcp', 'pass', `MCP endpoint${list.length === 1 ? '' : 's'} found${cardAt ? ` via ${cardAt}` : ' via a rel="mcp" link'}: ${list.join(', ')}.`,
      cardAt ? 'Nothing to fix.' : 'Also publish a server card at /.well-known/mcp.json so agents find the server without parsing your HTML.', { endpoints: list });
  }
  if (cardAt) return signal('mcp', 'warn', `${cardAt} exists but names no endpoint URL.`, 'Put the server URL in the card, e.g. "transport": { "type": "streamable-http", "endpoint": "https://<host>/mcp" }.');
  if (cards.some(([, r]) => notChecked(r))) return signal('mcp', 'warn', 'The MCP server card could not be checked in time.', 'Run the check again.');
  return signal('mcp', 'fail', 'No MCP server card (/.well-known/mcp.json) and no rel="mcp" link.',
    'If you offer an MCP server, publish /.well-known/mcp.json with its endpoint and send Link: <https://<host>/mcp>; rel="mcp". If not, consider exposing your main actions as MCP tools.');
}

function apiSignal(f, html, linkHeader) {
  const catalog = jsonOf(f.apiCatalog);
  const apis = [];
  if (catalog && Array.isArray(catalog.linkset)) {
    for (const entry of catalog.linkset.slice(0, 20)) {
      if (!entry || typeof entry !== 'object') continue;
      const desc = Array.isArray(entry['service-desc']) ? entry['service-desc'] : [];
      apis.push({ anchor: absolute(entry.anchor || '', f.apiCatalog.url), service_desc: desc.map((d) => d && absolute(d.href || '', f.apiCatalog.url)).filter(Boolean).slice(0, 3) });
    }
  }
  const openapi = jsonOf(f.openapi);
  // A large OpenAPI file may be cut at the size cap, so JSON that does not parse is recognised by its start.
  const head = ok(f.openapi) && !f.openapi.skipped && !looksHtml(f.openapi) ? f.openapi.text.slice(0, 2000) : '';
  const openapiOk = Boolean(openapi && (openapi.openapi || openapi.swagger)) || /^\s*(openapi|swagger)\s*:/m.test(head) || /"(openapi|swagger)"\s*:\s*"\d/.test(head);
  const fromCatalog = (apis.find((a) => a.service_desc.length) || { service_desc: [] }).service_desc[0];
  const declared = (linkHeader.find((l) => l.rel.includes('service-desc')) || {}).href || (html && html.serviceDesc) || fromCatalog || '';
  const data = { catalog: Boolean(catalog && Array.isArray(catalog.linkset)), apis: apis.slice(0, 5), openapi: openapiOk ? f.openapi.url : null, service_desc: declared || null };
  if (data.catalog) {
    return signal('api_catalog', 'pass', `/.well-known/api-catalog (RFC 9727) lists ${apis.length} API${apis.length === 1 ? '' : 's'}.`,
      apis.some((a) => a.service_desc.length) ? 'Nothing to fix.' : 'Add a "service-desc" link (your OpenAPI file) to each catalog entry.', data);
  }
  if (openapiOk) {
    return signal('api_catalog', 'pass', `OpenAPI description found at ${f.openapi.url}.`,
      'Also publish /.well-known/api-catalog (RFC 9727) linking to it, so agents can discover it from the host alone.', data);
  }
  if (catalog || (ok(f.apiCatalog) && !looksHtml(f.apiCatalog))) {
    return signal('api_catalog', 'warn', '/.well-known/api-catalog exists but is not a valid linkset (expected JSON with a "linkset" array).', 'Serve application/linkset+json: { "linkset": [ { "anchor": "https://<host>/api", "service-desc": [ { "href": "https://<host>/openapi.json" } ] } ] }.', data);
  }
  if (notChecked(f.apiCatalog)) return signal('api_catalog', 'warn', 'The API catalog could not be checked in time.', 'Run the check again.', data);
  return signal('api_catalog', 'fail', 'No /.well-known/api-catalog and no OpenAPI description (/openapi.json or a rel="service-desc" link).',
    'If you have an API, publish its OpenAPI description, link it with rel="service-desc", and list it in /.well-known/api-catalog.', data);
}

function skillSignal(f) {
  const file = textFile(f.skill);
  if (file.ok) {
    const text = f.skill.text.replace(/^﻿/, '');
    const front = /^---\r?\n([\s\S]{0,4000}?)\r?\n---/.exec(text);
    const named = front && /^name\s*:/m.test(front[1]) && /^description\s*:/m.test(front[1]);
    return named
      ? signal('skill_md', 'pass', '/skill.md found with name and description frontmatter.', 'Nothing to fix.')
      : signal('skill_md', 'warn', '/skill.md exists but has no YAML frontmatter with name and description.', 'Start the file with ---, name: <short-id>, description: <when to use it>, --- (see the starter file below).');
  }
  const index = jsonOf(f.skillsIndex);
  if (index) return signal('skill_md', 'pass', 'A skills index was found at /.well-known/skills/index.json.', 'Optional: also serve /skill.md for agents that look there.');
  if (notChecked(f.skill)) return signal('skill_md', 'warn', '/skill.md could not be checked in time.', 'Run the check again.');
  return signal('skill_md', 'fail', `No /skill.md (${file.reason}).`,
    'Publish /skill.md: a short Markdown guide with name/description frontmatter that tells an agent how to use your site or API (see the starter file below).');
}

function structuredSignal(html) {
  if (!html) return signal('structured_data', 'fail', 'The page is not HTML, so it has no JSON-LD.', 'Serve an HTML homepage with a <script type="application/ld+json"> block.');
  const valid = html.jsonLd.filter((j) => j.ok);
  const types = [...new Set(valid.flatMap((j) => j.types))].slice(0, 10);
  if (valid.length) {
    return signal('structured_data', 'pass', `${valid.length} JSON-LD block${valid.length === 1 ? '' : 's'}${types.length ? ` (${types.join(', ')})` : ''}.`,
      types.length ? 'Nothing to fix.' : 'Give each JSON-LD object an @type (Organization, WebSite, Product, …).', { types });
  }
  if (html.jsonLd.length) return signal('structured_data', 'warn', 'JSON-LD blocks were found but none is valid JSON.', 'Fix the JSON syntax in your <script type="application/ld+json"> blocks.');
  return signal('structured_data', 'fail', 'No JSON-LD structured data on the page.',
    'Add a <script type="application/ld+json"> block with schema.org Organization or WebSite (name, url, description, sameAs).');
}

function markdownSignal(f, html) {
  const negotiated = ok(f.mdNegotiated) && /^text\/(markdown|x-markdown)$/.test(f.mdNegotiated.type);
  const alternate = html && html.markdownAlternate;
  const indexMd = textFile(f.indexMd).ok;
  const found = [negotiated && 'the page answers Accept: text/markdown with Markdown', alternate && `a rel="alternate" type="text/markdown" link (${alternate})`, indexMd && '/index.md'].filter(Boolean);
  if (found.length) {
    return signal('markdown', 'pass', `Markdown available: ${found.join('; ')}.`,
      negotiated && alternate ? 'Nothing to fix.' : negotiated ? 'Also add <link rel="alternate" type="text/markdown" href="…"> so agents can find it.' : 'Optional: also answer requests sent with "Accept: text/markdown" with Markdown.');
  }
  return signal('markdown', 'fail', 'No Markdown version: no text/markdown alternate link, no content negotiation and no /index.md.',
    'Serve a Markdown version of key pages (e.g. /index.md or page.md), link it with <link rel="alternate" type="text/markdown">, and optionally answer "Accept: text/markdown".');
}

function ssrSignal(f, html) {
  const kb = Math.ceil((f.page.text ? Buffer.byteLength(f.page.text) : 0) / 1024);
  const weight = f.page.truncated ? `over ${kb} KB (stopped reading)` : `${kb} KB`;
  if (!html) return signal('ssr', 'fail', `The page is not HTML (${f.page.type || 'no content type'}).`, 'Make sure the URL serves an HTML page.');
  const data = { words: html.words, html_kb: kb, scripts: html.scripts, spa_root: html.spaRoot };
  const heavy = f.page.truncated || kb > 1024;
  if (html.words < 30) {
    return signal('ssr', 'fail', `Only ${html.words} words of text in the raw HTML (${weight}, ${html.scripts} script${html.scripts === 1 ? '' : 's'})${html.spaRoot ? '; it looks like an empty single-page-app shell' : ''}. Agents that do not run JavaScript see an empty page.`,
      'Render the main content on the server (SSR or static generation) so it is in the HTML response.', data);
  }
  if (html.words < 150 || heavy) {
    return signal('ssr', 'warn', `${html.words} words of text in the raw HTML; page weight ${weight}.`,
      heavy ? 'Reduce the HTML size: inline data and scripts make agents stop reading early.' : 'Make sure the main content is in the server-rendered HTML, not only added by JavaScript.', data);
  }
  return signal('ssr', 'pass', `${html.words} words of text in the raw HTML; page weight ${weight}.`, 'Nothing to fix.', data);
}

function metaSignal(html) {
  if (!html) return signal('meta', 'fail', 'The page is not HTML.', 'Serve an HTML page with <title>, a meta description and Open Graph tags.');
  const checks = [
    ['title', Boolean(html.title)], ['meta description', Boolean(html.description)], ['og:title', Boolean(html.og.title)],
    ['og:description', Boolean(html.og.description)], ['canonical link', Boolean(html.canonical)], ['<html lang>', Boolean(html.lang)],
  ];
  const missing = checks.filter(([, has]) => !has).map(([name]) => name);
  const data = { title: html.title, description: html.description, canonical: html.canonical, lang: html.lang, missing };
  if (!missing.length) return signal('meta', 'pass', `Title, description, Open Graph, canonical and lang are all set (title: “${html.title}”).`, 'Nothing to fix.', data);
  if (!html.title && !html.description) return signal('meta', 'fail', `Missing: ${missing.join(', ')}.`, 'Add <title>, <meta name="description">, og:title, og:description, <link rel="canonical"> and <html lang>.', data);
  return signal('meta', 'warn', `Missing: ${missing.join(', ')}.`, `Add ${missing.join(', ')} to the page head.`, data);
}

function securitySignal(f) {
  const file = textFile(f.security);
  if (!file.ok) {
    if (notChecked(f.security)) return signal('security_txt', 'warn', 'security.txt could not be checked in time.', 'Run the check again.');
    return signal('security_txt', 'fail', `No /.well-known/security.txt (${file.reason}).`,
      'Publish /.well-known/security.txt (RFC 9116) with at least "Contact: mailto:security@<your domain>" and "Expires: <date within a year>".');
  }
  const contact = /^contact\s*:/im.test(f.security.text);
  const expires = /^expires\s*:/im.test(f.security.text);
  if (contact && expires) return signal('security_txt', 'pass', 'security.txt found with Contact and Expires.', 'Nothing to fix.');
  return signal('security_txt', 'warn', `security.txt found but ${!contact && !expires ? 'Contact and Expires are' : !contact ? 'Contact is' : 'Expires is'} missing.`,
    'RFC 9116 requires a "Contact:" line and an "Expires:" date.');
}

// facts: what lib/checker.js fetched. Returns { signals, html, robots, sitemap, linkHeader }.
// The parsed page, or null when the response is not HTML.
function pageHtml(page) {
  const isHtml = page.type === 'text/html' || page.type === 'application/xhtml+xml' || (!page.type && /<html/i.test(page.text.slice(0, 2048)));
  return isHtml ? parseHtml(page.text, page.url) : null;
}

// facts.html may carry the already parsed page (lib/checker.js parses it once).
function evaluate(facts) {
  const html = facts.html !== undefined ? facts.html : pageHtml(facts.page);
  const robots = textFile(facts.robots).ok ? parseRobots(facts.robots.text) : { groups: [], sitemaps: [] };
  const sitemap = ok(facts.sitemap) && !facts.sitemap.skipped ? parseSitemap(facts.sitemap.text) : null;
  const linkHeader = parseLinkHeader(facts.page.headers.link, facts.page.url);
  const signals = [
    httpsSignal(facts),
    robotsSignal(facts, robots),
    sitemapSignal(facts, robots, sitemap),
    llmsSignal(facts),
    mcpSignal(facts, html, linkHeader),
    apiSignal(facts, html, linkHeader),
    skillSignal(facts),
    structuredSignal(html),
    markdownSignal(facts, html),
    ssrSignal(facts, html),
    metaSignal(html),
    securitySignal(facts),
  ];
  return { signals, html, robots, sitemap, linkHeader };
}

// pass = full weight, warn = half, fail = none; the weights add up to 100.
function score(signals) {
  const total = signals.reduce((n, s) => n + s.weight, 0);
  const got = signals.reduce((n, s) => n + (s.status === 'pass' ? s.weight : s.status === 'warn' ? s.weight / 2 : 0), 0);
  const count = (status) => signals.filter((s) => s.status === status).length;
  return { score: total ? Math.round((100 * got) / total) : 0, max: 100, passed: count('pass'), warned: count('warn'), failed: count('fail'), total: signals.length };
}

module.exports = {
  AI_CRAWLERS, WEIGHTS, LABELS,
  clean, decodeEntities, stripTags, attributes, parseHtml, pageHtml, parseLinkHeader, parseRobots, robotsAllows, aiCrawlerAccess, parseSitemap,
  mcpEndpoints, textFile, evaluate, score,
};
