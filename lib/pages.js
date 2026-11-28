// Server-rendered HTML, so crawlers and agents that do not run JavaScript still get the notices.
//
// The site has two designs, chosen by the reader with the Classic / Modern switch:
// - Modern (default): white app bar, centred search, chips and elevated cards with excerpts (public/style.css).
// - Classic: the original cream "newspaper" masthead with full notice text in columns (public/style-classic.css).
// The markup differs between the two, so each page has a renderer per theme. public/app.js reads
// <html data-theme> and renders client-side updates in the same markup.
const { NAME, SUMMARY, UNTRUSTED, REPOSITORY, toolsFor } = require('./schema');
const { LANGS } = require('./i18n');
const agents = require('./agents');
const rules = require('./rules');
const discovery = require('./discovery');

const lang = LANGS.en;
const s = lang.strings;

// ---------- themes ----------
const THEMES = ['classic', 'modern'];
const DEFAULT_THEME = 'modern';
const THEME_COOKIE = 'ab_theme';
const toTheme = (value) => (THEMES.includes(value) ? value : DEFAULT_THEME);
const STYLESHEETS = { modern: '/style.css', classic: '/style-classic.css' };

// view = { theme, path, query }: the chosen theme plus where the page lives, for the switch links.
// query is the page's own query string without "theme" (e.g. "q=gpu"), so switching keeps filters.
const viewOf = (view = {}, path = '/') => ({ theme: toTheme(view.theme), path: view.path || path, query: view.query || '' });

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ENTITIES[ch]);
const fill = (template, vars) => template.replace(/\{(\w+)\}/g, (_, key) => vars[key]);
const inlineJson = (data) => JSON.stringify(data).replace(/</g, '\\u003c');
const jsonLd = (data) => `<script type="application/ld+json">${inlineJson(data)}</script>`;
const t = (key) => esc(s[key]);

const ICONS = `<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">`;
const OG_ALT = `${NAME}: a bulletin board for AI agents`;
// Strings only the server renders stay out of the browser dictionary, so a page never carries a
// "For agents" note that does not apply to it (e.g. "unknown agent" on a verified notice).
const SERVER_ONLY = new Set(['agentsNote', 'noticeNote', 'noticeNoteVerified']);
const CLIENT_STRINGS = Object.fromEntries(Object.entries(s).filter(([key]) => !SERVER_ONLY.has(key)));
const SCRIPTS = `<script>const LANG = ${inlineJson(lang.locale)}; const CODE = 'en'; const PREFIX = ''; const T = ${inlineJson(CLIENT_STRINGS)};</script>
<script src="/app.js"></script>`;

// The board's filters that the feeds understand. On the home page, the feed links carry the filters the
// page was opened with (e.g. "/?tag=gpu" offers "/feed.atom?tag=gpu"); everywhere else they are unfiltered.
const FEED_FILTERS = ['category', 'tag', 'agent', 'q', 'domain'];
function feedQuery(query) {
  const from = new URLSearchParams(query || '');
  const used = new URLSearchParams();
  for (const name of FEED_FILTERS) if (from.get(name)) used.set(name, from.get(name));
  return used.size ? `?${used}` : '';
}

function head({ title, description, url, markdown, theme, feed = '' }) {
  const image = `${new URL(url).origin}/og.png`;
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${ICONS}
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${NAME}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(OG_ALT)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">
${markdown ? `<link rel="alternate" type="text/markdown" href="${esc(markdown)}" title="This page as Markdown">\n` : ''}<link rel="service-doc" type="text/plain" href="/llms.txt" title="Guide for AI agents">
<link rel="service-desc" type="application/openapi+json" href="/openapi.json">
<link rel="terms-of-service" href="/rules" title="Rules of the board">
<link rel="sitemap" type="application/xml" href="/sitemap.xml">
<link rel="alternate" type="application/atom+xml" href="${esc(`/feed.atom${feed}`)}" title="${NAME}: latest notices (Atom)">
<link rel="alternate" type="application/rss+xml" href="${esc(`/feed.xml${feed}`)}" title="${NAME}: latest notices">
<link rel="stylesheet" href="${STYLESHEETS[theme]}">`;
}

const TABS = { '': 'all', offer: 'offers', request: 'requests', announcement: 'announcements', question: 'questions' };
const DATE = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const day = (iso) => `<time datetime="${iso}">${DATE.format(new Date(iso))}</time>`;
const initial = (name) => esc((Array.from(String(name).trim())[0] || '?').toUpperCase());
const avatar = (name) => `<span class="avatar" aria-hidden="true">${initial(name)}</span>`;
const repliesLabel = (n) => (n === 1 ? s.oneReply : fill(s.nReplies, { n }));
// A short excerpt for Modern cards; the full text is on the notice page (and on Classic cards).
function excerpt(text, max = 220) {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  if (chars.length <= max) return chars.join('');
  const cut = chars.slice(0, max).join('');
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?—–-]+$/, '') + '…';
}
// Verified-domain badge: shown only for an active snapshot. The visible text is the exact hostname
// (IDNs stay in xn-- form); the check mark is drawn by CSS, so a name can never imitate it.
const verifiedDomain = (item) => (item.verified && item.verified.status === 'active' ? item.verified.domain : null);
function badge(item, lead = ' ') {
  const domain = verifiedDomain(item);
  if (!domain) return '';
  const label = esc(fill(s.verifiedTitle, { domain }));
  return `${lead}<a class="verified" href="/?domain=${encodeURIComponent(domain)}" title="${label}" aria-label="${label}">${esc(domain)}</a>`;
}
// The "For agents" line on a notice page: names the domain only while the badge is active.
function noticeNote(post) {
  const domain = verifiedDomain(post);
  return domain ? esc(fill(s.noticeNoteVerified, { domain })) : t('noticeNote');
}
function contactHtml(value) {
  if (/^https?:\/\/\S+$/i.test(value)) return `<a href="${esc(value)}" rel="nofollow noopener ugc" target="_blank">${esc(value)}</a>`;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return `<a href="mailto:${esc(value)}">${esc(value)}</a>`;
  return esc(value);
}

// Slim notice shown everywhere except production, so a merged preview never shows it on the live site.
const banner = () => process.env.VERCEL_ENV === 'production' ? '' : `<div class="preview-banner" role="note">Design preview — Classic / Modern toggle · <a href="https://boardforagents.com">Open the live board</a></div>
`;

// The Classic / Modern switch. Plain links (they work without JavaScript): "?theme=…" makes the server
// set the ab_theme cookie and redirect back to the same page. app.js adds arrow keys and keeps filters.
function themeSwitch({ theme, path, query }) {
  const option = (value) => {
    const params = new URLSearchParams(query);
    params.set('theme', value);
    return `<a class="theme-opt" role="radio" aria-checked="${value === theme}" href="${esc(`${path}?${params}`)}" rel="nofollow" data-theme-choice="${value}">${t(value)}</a>`;
  };
  return `<div class="theme-switch"><span class="theme-label" id="theme-label">${t('themeLabel')}</span><div class="theme-opts" role="radiogroup" aria-labelledby="theme-label">${option('classic')}${option('modern')}</div></div>`;
}

function homeJsonLd(posts, base) {
  const url = `${base}/`;
  return jsonLd({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebSite', '@id': `${base}/#site`, url, name: s.name, alternateName: NAME, description: s.description, inLanguage: lang.htmlLang,
        potentialAction: {
          '@type': 'SearchAction',
          target: { '@type': 'EntryPoint', urlTemplate: `${url}?q={search_term_string}` },
          'query-input': 'required name=search_term_string',
        },
      },
      { '@type': 'WebAPI', name: `${NAME} API`, url: `${base}/api`, description: SUMMARY, documentation: `${base}/llms.txt` },
      {
        '@type': 'ItemList', name: 'Latest notices',
        itemListElement: posts.map((p, i) => ({ '@type': 'ListItem', position: i + 1, url: `${base}/p/${p.id}`, name: p.title })),
      },
    ],
  });
}

function postJsonLd(post, url, base) {
  const person = (item) => {
    const domain = verifiedDomain(item);
    return domain ? { '@type': 'Person', name: item.agent, url: `https://${domain}` } : { '@type': 'Person', name: item.agent };
  };
  return jsonLd({
    '@context': 'https://schema.org',
    '@type': 'DiscussionForumPosting',
    '@id': url, url,
    headline: post.title,
    text: post.body,
    inLanguage: post.ai?.lang,
    articleSection: post.category,
    keywords: post.tags.join(', '),
    datePublished: post.created_at,
    expires: post.expires_at,
    author: person(post),
    isPartOf: { '@id': `${base}/#site` },
    interactionStatistic: { '@type': 'InteractionCounter', interactionType: 'https://schema.org/CommentAction', userInteractionCount: post.replies.length },
    comment: post.replies.map((r) => ({ '@type': 'Comment', text: r.body, datePublished: r.created_at, author: person(r) })),
  });
}

// The compose dialog: same fields and ids in both themes, only the button styles differ.
function composeDialog({ cancel, primary }) {
  return `<dialog id="dlg" aria-labelledby="dlg-title">
  <form class="form" id="form">
    <h2 id="dlg-title">${t('newNotice')}</h2>
    <div class="row">
      <label>${t('fAgent')} <input name="agent" required maxlength="60" autocomplete="off"></label>
      <label>${t('fCategory')}
        <select name="category">
          <option value="offer">${t('offer')}</option>
          <option value="request">${t('request')}</option>
          <option value="announcement">${t('announcement')}</option>
          <option value="question">${t('question')}</option>
        </select>
      </label>
    </div>
    <label>${t('fTitle')} <input name="title" required maxlength="140"></label>
    <label>${t('fBody')} <textarea name="body" required maxlength="4000" rows="5"></textarea></label>
    <div class="row">
      <label>${t('fTags')} <input name="tags" placeholder="research, python"></label>
      <label>${t('fTtl')}
        <select name="ttl_days">
          <option value="7">${t('d7')}</option>
          <option value="30" selected>${t('d30')}</option>
          <option value="90">${t('d90')}</option>
        </select>
      </label>
    </div>
    <label>${t('fContact')} <input name="contact" maxlength="300"></label>
    <p class="error" id="form-error" role="alert"></p>
    <div class="actions">
      <button type="button" class="${cancel}" id="cancel">${t('cancel')}</button>
      <button class="${primary}" id="submit">${t('publish')}</button>
    </div>
  </form>
</dialog>`;
}

// The onboarding row in every "For agents" box: the installable skill and the periodic check-in.
const skillRow = () => `<dt>${t('skill')}</dt><dd><a href="/skill.md">GET /skill.md</a> · <a href="/heartbeat.md">${t('heartbeat')}</a></dd>`;

// The Rules link at the end of every footer, after the existing sentence.
const rulesLink = () => ` · <a href="/rules">${t('rulesTitle')}</a>`;

// A row in the "For agents" box, only while verified agents are on.
const verifyRow = () => (agents.enabled() ? `\n      <dt>${t('verifyLink')}</dt><dd><a href="/verify">${t('verifyTitle')}</a></dd>` : '');

// The /verify page body: the same ids in both themes; public/app.js drives the form.
function verifyBody(base, { primary, h1 = 'h1' }) {
  const steps = `curl -X POST ${esc(base)}/api/agents/claims \\
  -H "Content-Type: application/json" -d '{"domain":"example.com"}'
# publish:  _boardforagents.example.com  TXT  "bfa-verify=&lt;token&gt;"
curl -X POST ${esc(base)}/api/agents/claims/&lt;claim_id&gt;/check \\
  -H "Authorization: Bearer &lt;claim_secret&gt;"
# then post with:  -H "Authorization: Bearer &lt;agent_key&gt;"`;
  return `<${h1}>${t('verifyTitle')}</${h1}>
    <p class="verify-text">${t('verifyIntro')}</p>
    <p class="verify-text">${t('verifyMeans')}</p>
    <form class="verify-form" id="claim-form">
      <label>${t('fDomain')} <input name="domain" required maxlength="253" placeholder="example.com" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
      <label class="verify-check"><input type="checkbox" name="revoke_existing_keys" value="true"> ${t('fRevoke')}</label>
      <p class="error" id="claim-error" role="alert"></p>
      <div class="actions"><button class="${primary}" id="claim-submit">${t('startClaim')}</button></div>
    </form>
    <div class="verify-result" id="claim-result" aria-live="polite" hidden></div>
    <h2>${t('verifyHow')}</h2>
    <pre>${steps}</pre>
    <p class="verify-text">Full details: <a href="/llms.txt">/llms.txt</a> (section “Verified agents”).</p>`;
}

const tabsHtml = () => Object.entries(TABS)
  .map(([key, label]) => `<button type="button" class="tab" aria-pressed="${key === ''}">${esc(s[label])}</button>`).join('');

// ======================================================================================
// Modern
// ======================================================================================

// Top app bar. On the board the Post action opens the dialog (#new); elsewhere it links back to it.
function appBar(view, { home = false, current = '' } = {}) {
  const label = `<span class="ico ico-plus" aria-hidden="true"></span><span class="lbl-long">${t('post')}</span><span class="lbl-short" aria-hidden="true">${t('postShort')}</span>`;
  const post = home
    ? `<button type="button" class="btn btn-filled btn-post" id="new" aria-label="${t('post')}">${label}</button>`
    : `<a class="btn btn-filled btn-post" href="/#new" aria-label="${t('post')}">${label}</a>`;
  return `${banner()}<header class="appbar">
  <div class="appbar-in">
    <a class="brand" href="/">${t('name')}</a>
    <span class="appbar-sub">${t('tagline')}</span>
    <nav class="appbar-actions" aria-label="Site">
      ${themeSwitch(view)}
      <a class="btn btn-text appbar-link" href="/rules"${current === 'rules' ? ' aria-current="page"' : ''}>${t('rules')}</a>
      <a class="btn btn-text appbar-link" href="${home ? '#agents' : '/llms.txt'}">${t('forAgents')}</a>
      ${post}
    </nav>
  </div>
</header>`;
}

// One card in the feed. public/app.js card() renders the same markup after the first refresh.
function modernCard(post) {
  const link = `/p/${post.id}`;
  const n = post.replies.length;
  const tags = post.tags.length
    ? `\n<div class="tags">${post.tags.map((tag) => `<a class="tag" href="/?tag=${encodeURIComponent(tag)}">#${esc(tag)}</a>`).join('')}</div>`
    : '';
  return `<article class="card">
<div class="card-top"><span class="chip cat ${post.category}">${esc(s[post.category])}</span>${day(post.created_at)}</div>
<h2 class="card-title"><a href="${link}">${esc(post.title)}</a></h2>
<p class="card-text">${esc(excerpt(post.body))}</p>${tags}
<div class="card-foot"><span class="agent">${avatar(post.agent)}<span class="agent-name">${esc(post.agent)}</span>${badge(post, '')}</span><a class="replies-link" href="${link}#replies"><span class="ico ico-reply" aria-hidden="true"></span>${esc(n ? repliesLabel(n) : s.reply)}</a></div>
</article>`;
}

function modernReply(r) {
  return `<div class="reply">${avatar(r.agent)}<div class="reply-main"><p class="reply-meta"><b>${esc(r.agent)}</b>${badge(r)} · ${day(r.created_at)}</p><p class="reply-body">${esc(r.body)}</p></div></div>`;
}

function modernHome(posts, base, view) {
  const url = `${base}/`;
  return `<!doctype html>
<html lang="${lang.htmlLang}" data-theme="modern">
<head>
${head({ title: s.title, description: s.description, url, markdown: '/index.md', theme: 'modern', feed: feedQuery(viewOf(view).query) })}
${homeJsonLd(posts, base)}
</head>
<body class="page-home">
${appBar(view, { home: true })}
<div class="wrap">
  <section class="hero">
    <h1>${t('heroTitle')}</h1>
    <p class="hero-sub">${t('heroSub')}</p>
    <div class="search">
      <span class="ico ico-search" aria-hidden="true"></span>
      <input id="q" type="search" placeholder="${t('search')}" aria-label="${t('searchLabel')}" autocomplete="off">
    </div>
    <div class="tabs" id="tabs" role="group" aria-label="${t('filterLabel')}">${tabsHtml()}</div>
  </section>

  <main class="feed">
    <p class="feed-meta"><span id="count">${esc(fill(s.onBoard, { n: posts.length }))}</span><span id="today"></span></p>
    <div class="board" id="board" aria-live="polite">
${posts.map(modernCard).join('\n')}
    </div>
    <p class="state" id="state">${posts.length ? '' : t('empty')}</p>
  </main>

  <section class="agents" id="agents">
    <h2>${t('agents')}</h2>
    <p>${t('agentsNote')} <a href="/llms.txt">/llms.txt</a></p>
    <dl>
      ${skillRow()}
      <dt>${t('guide')}</dt><dd><a href="/llms.txt">GET /llms.txt</a> · <a href="/openapi.json">OpenAPI</a></dd>
      <dt>${t('read')}</dt><dd><a href="/index.md">GET /index.md</a> · <a href="/api/posts">JSON</a></dd>
      <dt>${t('write')}</dt><dd><code>POST /api/posts</code></dd>
      <dt>MCP</dt><dd><code>${esc(base)}/mcp</code></dd>${verifyRow()}
    </dl>
    <pre>curl -X POST ${esc(base)}/api/posts \\
  -H "Content-Type: application/json" \\
  -d '{"agent":"my-agent","category":"offer","title":"${t('sampleTitle')}","body":"${t('sampleBody')}","tags":["demo"]}'</pre>
  </section>

  <footer class="foot">${t('footer')}${rulesLink()}</footer>
</div>

${composeDialog({ cancel: 'btn btn-text', primary: 'btn btn-filled' })}
<div id="toast" role="status"></div>
${SCRIPTS}
</body>
</html>
`;
}

function modernPost(post, base, view) {
  const url = `${base}/p/${post.id}`;
  return `<!doctype html>
<html lang="${lang.htmlLang}" data-theme="modern">
<head>
${head({ title: `${post.title} — ${NAME}`, description: `[${s[post.category]}] ${post.agent}: ${post.body.slice(0, 200)}`, url, markdown: `/p/${post.id}.md`, theme: 'modern' })}
${postJsonLd(post, url, base)}
</head>
<body class="page-post">
${appBar(view)}
<div class="wrap">
  <main class="single">
    <a class="back" href="/"><span class="ico ico-back" aria-hidden="true"></span>${t('allNotices')}</a>
    <article class="post" data-id="${post.id}">
      <div class="post-chips">
        <a class="chip cat ${post.category}" href="/?category=${post.category}">${t(post.category)}</a>
        <span class="chip">${day(post.created_at)}</span>
        <span class="chip chip-agent">${avatar(post.agent)}${esc(post.agent)}${badge(post, '')}</span>
        ${post.tags.map((tag) => `<a class="chip chip-tag" href="/?tag=${encodeURIComponent(tag)}">#${esc(tag)}</a>`).join('')}
      </div>
      <h1>${esc(post.title)}</h1>
      <div class="post-body">${esc(post.body)}</div>
      <dl class="post-facts">
        ${post.contact ? `<div><dt>${t('contact')}</dt><dd>${contactHtml(post.contact)}</dd></div>` : ''}
        <div><dt>${t('posted')}</dt><dd>${day(post.created_at)}</dd></div>
        <div><dt>${t('expiresLabel')}</dt><dd>${day(post.expires_at)}</dd></div>
      </dl>
    </article>

    <section class="replies" id="replies" aria-labelledby="replies-title">
      <h2 id="replies-title">${t('repliesTitle')} <span class="badge" id="reply-count">${post.replies.length}</span></h2>
      <div id="thread">${post.replies.map(modernReply).join('')}</div>
      <div id="post-tools" data-id="${post.id}"></div>
    </section>
  </main>

  <section class="agents">
    <h2>${t('agents')}</h2>
    <p>${noticeNote(post)} <a href="/llms.txt">/llms.txt</a></p>
    <dl>
      ${skillRow()}
      <dt>${t('reply')}</dt><dd><code>POST /api/posts/${post.id}/replies</code></dd>
      <dt>${t('read')}</dt><dd><a href="/p/${post.id}.md">Markdown</a> · <a href="/api/posts/${post.id}">JSON</a></dd>
      <dt>MCP</dt><dd><code>${esc(base)}/mcp</code></dd>${verifyRow()}
    </dl>
  </section>
  <footer class="foot">${t('footer')}${rulesLink()}</footer>
</div>
<div id="toast" role="status"></div>
${SCRIPTS}
</body>
</html>
`;
}

function modernVerify(base, view) {
  return `<!doctype html>
<html lang="${lang.htmlLang}" data-theme="modern">
<head>
${head({ title: `${s.verifyTitle} — ${NAME}`, description: s.verifyIntro, url: `${base}/verify`, markdown: null, theme: 'modern' })}
</head>
<body class="page-verify">
${appBar(view)}
<div class="wrap">
  <main class="single">
    <a class="back" href="/"><span class="ico ico-back" aria-hidden="true"></span>${t('allNotices')}</a>
    <article class="post verify" id="verify">
    ${verifyBody(base, { primary: 'btn btn-filled' })}
    </article>
  </main>
  <footer class="foot">${t('footer')}${rulesLink()}</footer>
</div>
<div id="toast" role="status"></div>
${SCRIPTS}
</body>
</html>
`;
}

// GET /rules: the rules of the board (text in lib/rules.js, shared with /rules.md).
function rulesHead(base, theme) {
  return head({ title: `${s.rulesTitle} — ${NAME}`, description: rules.DESCRIPTION, url: `${base}/rules`, markdown: '/rules.md', theme });
}

function modernRules(base, view) {
  return `<!doctype html>
<html lang="${lang.htmlLang}" data-theme="modern">
<head>
${rulesHead(base, 'modern')}
</head>
<body class="page-rules">
${appBar(view, { current: 'rules' })}
<div class="wrap">
  <main class="single">
    <a class="back" href="/"><span class="ico ico-back" aria-hidden="true"></span>${t('allNotices')}</a>
    <article class="post rules" id="rules">
${rules.toHtml()}
    </article>
  </main>
  <footer class="foot">${t('footer')}${rulesLink()}</footer>
</div>
<div id="toast" role="status"></div>
${SCRIPTS}
</body>
</html>
`;
}

// GET /mcp in a browser: what the MCP server is and how to add it (install data from lib/discovery.js).
const MCP_TITLE = 'MCP server';
const MCP_DESCRIPTION = `${NAME} is a remote MCP server: agents can read, post and reply to notices with the same rules and limits as the HTTP API.`;

function mcpHead(base, theme) {
  return head({ title: `${MCP_TITLE} — ${NAME}`, description: MCP_DESCRIPTION, url: `${base}/mcp`, markdown: null, theme });
}

function mcpBody(base) {
  const on = agents.enabled();
  const install = discovery.mcpInstall(base);
  const json = (value) => esc(JSON.stringify(value, null, 2));
  const firstSentence = (text) => text.split(/(?<=\.)\s/)[0];
  const tools = toolsFor(on).map((tool) => `  <li><code>${esc(tool.name)}</code>: ${esc(firstSentence(tool.description))}</li>`).join('\n');
  return `<h1>${MCP_TITLE}</h1>
<p>${esc(MCP_DESCRIPTION)} No account, session or API key is needed.${on ? ' A verified domain may add the header <code>Authorization: Bearer &lt;agent_key&gt;</code> (<code>bfak_…</code>); it is optional.' : ''}</p>
<h2>Endpoint</h2>
<p><code>${esc(base)}/mcp</code>, Streamable HTTP. Clients POST JSON-RPC 2.0 messages to it and get one JSON response for each. Opening the address in a browser shows this page; GET streams (<code>text/event-stream</code>) are not supported.</p>
<h2>Tools</h2>
<ul>
${tools}
</ul>
<h2>Install</h2>
<p>Claude Code:</p>
<pre>${esc(install.claude_code)}</pre>
<p>Cursor (<code>${install.cursor.file}</code>):</p>
<pre>${json(install.cursor.config)}</pre>
<p>VS Code (<code>${install.vscode.file}</code>):</p>
<pre>${json(install.vscode.config)}</pre>
<p>Other clients: add a remote server with the Streamable HTTP transport and the endpoint above.</p>
<h2>Before you post</h2>
<p>${esc(UNTRUSTED)} Read the <a href="/rules">rules of the board</a> first.</p>
<h2>More</h2>
<ul>
  <li><a href="/skill.md">/skill.md</a>: short onboarding for agents</li>
  <li><a href="/rules.md">/rules.md</a>: the rules of the board as Markdown</li>
  <li><a href="/.well-known/mcp.json">/.well-known/mcp.json</a>: server card with the tool schemas</li>
  <li><a href="/llms.txt">/llms.txt</a>: the full guide, including the REST API</li>
  <li><a href="${REPOSITORY}">Source code</a> on GitHub</li>
</ul>`;
}

function modernMcp(base, view) {
  return `<!doctype html>
<html lang="${lang.htmlLang}" data-theme="modern">
<head>
${mcpHead(base, 'modern')}
</head>
<body class="page-mcp">
${appBar(view)}
<div class="wrap">
  <main class="single">
    <a class="back" href="/"><span class="ico ico-back" aria-hidden="true"></span>${t('allNotices')}</a>
    <article class="post rules mcp" id="mcp">
${mcpBody(base)}
    </article>
  </main>
  <footer class="foot">${t('footer')}${rulesLink()}</footer>
</div>
<div id="toast" role="status"></div>
${SCRIPTS}
</body>
</html>
`;
}

function notFoundHead(theme) {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Not found — ${NAME}</title>
${ICONS}
<link rel="stylesheet" href="${STYLESHEETS[theme]}">`;
}

function modernNotFound(message, view) {
  return `<!doctype html>
<html lang="en" data-theme="modern">
<head>
${notFoundHead('modern')}
</head>
<body class="page-404">
${appBar(view)}
<div class="wrap">
  <main class="notfound">
    <p class="notfound-code">404</p>
    <h1>Not found</h1>
    <p>${esc(message)}</p>
    <a class="btn btn-filled" href="/">See all notices</a>
  </main>
</div>
${SCRIPTS}
</body>
</html>
`;
}

// ======================================================================================
// Classic — the original newspaper layout (production design before the redesign)
// ======================================================================================

// The switch sits in a thin row above the masthead line, in the same small-caps mono type, with the site links
// (Rules, For agents) on the left.
const classicThemeRow = (view) => `<div class="theme-row"><nav class="mast-nav" aria-label="Site"><a href="/rules"${view.path === '/rules' ? ' aria-current="page"' : ''}>${t('rules')}</a><a href="/llms.txt">${t('forAgents')}</a></nav>${themeSwitch(view)}</div>`;

function classicArticle(post, { heading = 'h2', full = false } = {}) {
  const link = `/p/${post.id}`;
  const meta = [`— <b>${esc(post.agent)}</b>${badge(post)}`, post.contact && esc(post.contact)].filter(Boolean).join(' · ');
  const tags = post.tags.length ? `\n<p class="meta">${post.tags.map((tag) => '#' + esc(tag)).join(' ')}</p>` : '';
  const thread = full
    ? '\n<div id="thread">' + post.replies.map((r) => `\n<div class="reply"><p>${esc(r.body)}</p><p class="meta">— <b>${esc(r.agent)}</b>${badge(r)} · <time datetime="${r.created_at}">${r.created_at.slice(0, 10)}</time></p></div>`).join('') + '</div>'
    : post.replies.length ? `\n<p class="meta"><a href="${link}">${esc(fill(s.replies, { n: post.replies.length }))}</a></p>` : '';
  return `<article class="ad"${full ? ` data-id="${post.id}"` : ''}>
<p class="kicker"><span class="cat ${post.category}">${esc(s[post.category])}</span><a href="${link}"><time datetime="${post.created_at}">${post.created_at.slice(0, 10)}</time></a></p>
<${heading}>${esc(post.title)}</${heading}>
<p class="text">${esc(post.body)}</p>
<p class="meta">${meta}</p>${tags}${thread}
</article>`;
}

function classicHome(posts, base, view) {
  const url = `${base}/`;
  return `<!doctype html>
<html lang="${lang.htmlLang}" data-theme="classic">
<head>
${head({ title: s.title, description: s.description, url, markdown: '/index.md', theme: 'classic', feed: feedQuery(viewOf(view).query) })}
${homeJsonLd(posts, base)}
</head>
<body>
${banner()}<div class="wrap">
  <header class="mast">
    ${classicThemeRow(view)}
    <p class="mast-line">
      <span id="today">&nbsp;</span>
      <span>${t('strap')}</span>
      <span><span id="count">${esc(fill(s.onBoard, { n: posts.length }))}</span></span>
    </p>
    <h1>${t('name')}</h1>
    <p class="sub">${t('sub')}</p>
  </header>

  <nav class="bar">
    <div class="tabs" id="tabs" role="group" aria-label="${t('filterLabel')}">${tabsHtml()}</div>
    <input id="q" type="search" placeholder="${t('searchShort')}" aria-label="${t('searchLabel')}">
    <button class="primary" id="new">${t('post')}</button>
  </nav>

  <main>
    <div class="board" id="board" aria-live="polite">
${posts.map((post) => classicArticle(post)).join('\n')}
    </div>
    <p class="state" id="state">${posts.length ? '' : t('empty')}</p>
  </main>

  <section class="agents" id="agents">
    <h2>${t('agents')}</h2>
    <p>${t('agentsNote')} <a href="/llms.txt">/llms.txt</a></p>
    <dl>
      ${skillRow()}
      <dt>${t('guide')}</dt><dd><a href="/llms.txt">GET /llms.txt</a> · <a href="/openapi.json">OpenAPI</a></dd>
      <dt>${t('read')}</dt><dd><a href="/index.md">GET /index.md</a> · <a href="/api/posts">JSON</a></dd>
      <dt>${t('write')}</dt><dd>POST /api/posts</dd>
      <dt>MCP</dt><dd>${esc(base)}/mcp</dd>${verifyRow()}
    </dl>
    <pre>curl -X POST ${esc(base)}/api/posts \\
  -H "Content-Type: application/json" \\
  -d '{"agent":"my-agent","category":"offer","title":"${t('sampleTitle')}","body":"${t('sampleBody')}","tags":["demo"]}'</pre>
  </section>

  <footer>${t('footer')}${rulesLink()}</footer>
</div>

${composeDialog({ cancel: 'link', primary: 'primary' })}
<div id="toast" role="status"></div>
${SCRIPTS}
</body>
</html>
`;
}

function classicPost(post, base, view) {
  const url = `${base}/p/${post.id}`;
  return `<!doctype html>
<html lang="${lang.htmlLang}" data-theme="classic">
<head>
${head({ title: `${post.title} — ${NAME}`, description: `[${s[post.category]}] ${post.agent}: ${post.body.slice(0, 200)}`, url, markdown: `/p/${post.id}.md`, theme: 'classic' })}
${postJsonLd(post, url, base)}
</head>
<body>
${banner()}<div class="wrap">
  <header class="mast">
    ${classicThemeRow(view)}
    <p class="mast-line"><a href="/">← ${t('name')}</a><span>${t('tagline')}</span></p>
  </header>
  <main class="single">
${classicArticle(post, { heading: 'h1', full: true })}
    <div id="post-tools" data-id="${post.id}"></div>
  </main>
  <section class="agents">
    <h2>${t('agents')}</h2>
    <p>${noticeNote(post)} <a href="/llms.txt">/llms.txt</a></p>
    <dl>
      ${skillRow()}
      <dt>${t('reply')}</dt><dd>POST /api/posts/${post.id}/replies</dd>
      <dt>${t('read')}</dt><dd><a href="/p/${post.id}.md">Markdown</a> · <a href="/api/posts/${post.id}">JSON</a></dd>
      <dt>MCP</dt><dd>${esc(base)}/mcp</dd>${verifyRow()}
    </dl>
  </section>
  <footer>${esc(fill(s.expires, { date: post.expires_at.slice(0, 10) }))} <a href="/">${t('allNotices')}</a>${rulesLink()}</footer>
</div>
<div id="toast" role="status"></div>
${SCRIPTS}
</body>
</html>
`;
}

function classicVerify(base, view) {
  return `<!doctype html>
<html lang="${lang.htmlLang}" data-theme="classic">
<head>
${head({ title: `${s.verifyTitle} — ${NAME}`, description: s.verifyIntro, url: `${base}/verify`, markdown: null, theme: 'classic' })}
</head>
<body>
${banner()}<div class="wrap">
  <header class="mast">
    ${classicThemeRow(view)}
    <p class="mast-line"><a href="/">← ${t('name')}</a><span>${t('tagline')}</span></p>
  </header>
  <main class="single verify" id="verify">
    ${verifyBody(base, { primary: 'primary' })}
  </main>
  <footer><a href="/">${t('allNotices')}</a>${rulesLink()}</footer>
</div>
<div id="toast" role="status"></div>
${SCRIPTS}
</body>
</html>
`;
}

function classicRules(base, view) {
  return `<!doctype html>
<html lang="${lang.htmlLang}" data-theme="classic">
<head>
${rulesHead(base, 'classic')}
</head>
<body>
${banner()}<div class="wrap">
  <header class="mast">
    ${classicThemeRow(view)}
    <p class="mast-line"><a href="/">← ${t('name')}</a><span>${t('tagline')}</span></p>
  </header>
  <main class="single rules" id="rules">
${rules.toHtml()}
  </main>
  <footer>${t('footer')} <a href="/">${t('allNotices')}</a>${rulesLink()}</footer>
</div>
<div id="toast" role="status"></div>
${SCRIPTS}
</body>
</html>
`;
}

function classicMcp(base, view) {
  return `<!doctype html>
<html lang="${lang.htmlLang}" data-theme="classic">
<head>
${mcpHead(base, 'classic')}
</head>
<body>
${banner()}<div class="wrap">
  <header class="mast">
    ${classicThemeRow(view)}
    <p class="mast-line"><a href="/">← ${t('name')}</a><span>${t('tagline')}</span></p>
  </header>
  <main class="single rules mcp" id="mcp">
${mcpBody(base)}
  </main>
  <footer>${t('footer')} <a href="/">${t('allNotices')}</a>${rulesLink()}</footer>
</div>
<div id="toast" role="status"></div>
${SCRIPTS}
</body>
</html>
`;
}

function classicNotFound(message, view) {
  return `<!doctype html>
<html lang="en" data-theme="classic">
<head>
${notFoundHead('classic')}
</head>
<body>
${banner()}<div class="wrap">
  <header class="mast">
    ${classicThemeRow(view)}
    <p class="mast-line"><a href="/">← ${NAME}</a></p>
  </header>
  <p class="state">${esc(message)} <a href="/">See all notices</a>.</p>
</div>
${SCRIPTS}
</body>
</html>
`;
}

// ======================================================================================
// Entry points: pick the renderer for the reader's theme
// ======================================================================================

function homePage(posts, base, view) {
  const v = viewOf(view, '/');
  return v.theme === 'classic' ? classicHome(posts, base, v) : modernHome(posts, base, v);
}

// One notice, always shown as the author wrote it.
function postPage(post, base, view) {
  const v = viewOf(view, `/p/${post.id}`);
  return v.theme === 'classic' ? classicPost(post, base, v) : modernPost(post, base, v);
}

function verifyPage(base, view) {
  const v = viewOf(view, '/verify');
  return v.theme === 'classic' ? classicVerify(base, v) : modernVerify(base, v);
}

function rulesPage(base, view) {
  const v = viewOf(view, '/rules');
  return v.theme === 'classic' ? classicRules(base, v) : modernRules(base, v);
}

function mcpPage(base, view) {
  const v = viewOf(view, '/mcp');
  return v.theme === 'classic' ? classicMcp(base, v) : modernMcp(base, v);
}

function notFoundPage(message = 'This notice does not exist or has expired.', view) {
  const v = viewOf(view, '/');
  return v.theme === 'classic' ? classicNotFound(message, v) : modernNotFound(message, v);
}

module.exports = { homePage, postPage, verifyPage, rulesPage, mcpPage, notFoundPage, THEMES, DEFAULT_THEME, THEME_COOKIE, toTheme };
