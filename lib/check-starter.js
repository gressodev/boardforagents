// Starter files for the agent-ready site checker: llms.txt, skill.md and a robots.txt snippet, tailored
// from what was fetched (title, description, navigation links, sitemaps, API and MCP endpoints).
//
// The output is plain text served as text/plain (and escaped when shown in HTML). Every value taken from
// the checked site goes through one-line cleaning, Markdown link escaping or URL normalization, so a page
// cannot add lines, frontmatter keys or robots rules of its own.
const { clean, AI_CRAWLERS } = require('./check-signals');

const FILES = ['llms.txt', 'skill.md', 'robots.txt'];

// Link text inside [...]: no brackets or backslashes that could end it early.
const linkText = (text) => clean(text, 80).replace(/[\\[\]]/g, (ch) => `\\${ch}`) || 'Link';
// A URL inside (...) or on its own line: absolute http(s), no whitespace, parentheses or angle brackets.
function safeUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.href.replace(/[()<>\s"'`]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
  } catch { return null; }
}
const mdLink = (text, url, note) => {
  const href = safeUrl(url);
  return href ? `- [${linkText(text)}](${href})${note ? `: ${clean(note, 160)}` : ''}` : null;
};
const plain = (text, max) => clean(text, max).replace(/^[#>\-*+`]+\s*/, ''); // no leading Markdown syntax

// A readable label for a URL path ("/docs/getting-started" -> "Docs: getting started").
function labelFromUrl(href) {
  try {
    const parts = new URL(href).pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p).replace(/\.\w+$/, '').replace(/[-_]+/g, ' '));
    if (!parts.length) return 'Home';
    const [first, ...rest] = parts;
    return clean(`${first.charAt(0).toUpperCase()}${first.slice(1)}${rest.length ? `: ${rest.join(' / ')}` : ''}`, 80);
  } catch { return 'Page'; }
}

// What the generators need, gathered once by lib/checker.js.
function context({ finalUrl, html, sitemapUrls = [], sitemapLocs = [], mcpEndpoints = [], apis = {} }) {
  const url = new URL(finalUrl);
  const origin = url.origin;
  const host = url.hostname;
  const title = plain((html && (html.og.title || html.title)) || host, 120) || host;
  const description = plain((html && (html.description || html.og.description)) || '', 300);
  let pages = (html ? html.anchors : []).filter((a) => safeUrl(a.href)).slice(0, 12).map((a) => ({ text: a.text, href: a.href }));
  if (pages.length < 3) {
    const have = new Set(pages.map((p) => p.href));
    for (const loc of sitemapLocs) {
      if (pages.length >= 12) break;
      if (!have.has(loc) && safeUrl(loc) && !/\.xml(\.gz)?$/i.test(loc)) { pages.push({ text: labelFromUrl(loc), href: loc }); have.add(loc); }
    }
  }
  if (!pages.length) pages = [{ text: 'Home', href: `${origin}/` }];
  return {
    origin, host, title, description, pages,
    sitemaps: [...new Set(sitemapUrls.map(safeUrl).filter(Boolean))].slice(0, 5),
    mcp: [...new Set(mcpEndpoints.map(safeUrl).filter(Boolean))].slice(0, 3),
    openapi: apis.openapi ? safeUrl(apis.openapi) : apis.service_desc ? safeUrl(apis.service_desc) : null,
    catalog: apis.catalog ? `${origin}/.well-known/api-catalog` : null,
  };
}

function llmsTxt(c) {
  const lines = [`# ${c.title}`, '', `> ${c.description || `${c.title} (${c.host}).`}`, ''];
  lines.push(`Website: ${c.origin}/`, '');
  lines.push('## Main pages', ...c.pages.map((p) => mdLink(p.text, p.href)).filter(Boolean), '');
  const api = [
    c.openapi && mdLink('OpenAPI description', c.openapi, 'machine-readable API schema'),
    c.catalog && mdLink('API catalog', c.catalog, 'RFC 9727 linkset of this site’s APIs'),
    ...c.mcp.map((e) => mdLink('MCP server', e, 'Model Context Protocol endpoint (Streamable HTTP)')),
  ].filter(Boolean);
  if (api.length) lines.push('## API', ...api, '');
  lines.push('## Optional');
  lines.push(mdLink('Agent skill', `${c.origin}/skill.md`, 'short guide for AI agents'));
  for (const s of c.sitemaps) lines.push(mdLink('Sitemap', s, 'every public page'));
  if (!c.sitemaps.length) lines.push(mdLink('Sitemap', `${c.origin}/sitemap.xml`, 'every public page'));
  return `${lines.join('\n')}\n`;
}

function skillMd(c) {
  const slug = c.host.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 64) || 'site';
  // JSON strings are valid YAML double-quoted scalars, so the description cannot break the frontmatter.
  const description = JSON.stringify(clean(`Use ${c.host}${c.description ? `: ${c.description}` : ` (${c.title})`}`, 300));
  const lines = [
    '---', `name: ${slug}`, `description: ${description}`, `homepage: ${c.origin}/`, '---', '',
    `# ${c.title}`, '',
    c.description || `How an AI agent can use ${c.host}.`, '',
    `Base URL: ${c.origin}`, '',
    '## Start here', '',
    ...c.pages.slice(0, 8).map((p) => mdLink(p.text, p.href)).filter(Boolean),
    mdLink('Full index for agents (llms.txt)', `${c.origin}/llms.txt`), '',
  ];
  if (c.openapi || c.mcp.length) {
    lines.push('## API', '');
    if (c.openapi) lines.push(`- OpenAPI: ${c.openapi}`);
    for (const e of c.mcp) lines.push(`- MCP endpoint (Streamable HTTP): ${e}`);
    lines.push('');
  }
  lines.push('## Guidelines', '',
    '- Identify your agent with a descriptive User-Agent and respect robots.txt.',
    '- Prefer the Markdown and API versions of pages over scraping HTML.',
    '- Keep request rates low and cache what you read.',
    '- Do not submit personal data or secrets.');
  return `${lines.join('\n')}\n`;
}

function robotsTxt(c) {
  const lines = [
    `# Suggested robots.txt additions for ${c.host}. Review before publishing:`,
    '# merge with your existing rules; a more specific group replaces "User-agent: *" for that crawler.',
    `# Guide for agents: ${c.origin}/llms.txt`, '',
    ...AI_CRAWLERS.map((bot) => `User-agent: ${bot}`),
    'Allow: /', '',
  ];
  for (const s of c.sitemaps) lines.push(`Sitemap: ${s}`);
  if (!c.sitemaps.length) lines.push(`# Create this file first: no sitemap was found.`, `Sitemap: ${c.origin}/sitemap.xml`);
  return `${lines.join('\n')}\n`;
}

function generate(input) {
  const c = context(input);
  return { 'llms.txt': llmsTxt(c), 'skill.md': skillMd(c), 'robots.txt': robotsTxt(c) };
}

module.exports = { FILES, generate, safeUrl, linkText };
