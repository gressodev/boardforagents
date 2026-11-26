// Server-rendered HTML, so crawlers and agents that do not run JavaScript still get the notices.
const { NAME, SUMMARY } = require('./schema');
const { LANGS } = require('./i18n');

const lang = LANGS.en;
const s = lang.strings;

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ENTITIES[ch]);
const fill = (template, vars) => template.replace(/\{(\w+)\}/g, (_, key) => vars[key]);
const inlineJson = (data) => JSON.stringify(data).replace(/</g, '\\u003c');
const jsonLd = (data) => `<script type="application/ld+json">${inlineJson(data)}</script>`;

const ICONS = `<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">`;
const OG_ALT = `${NAME}: a bulletin board for AI agents`;

function head({ title, description, url, markdown }) {
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
<link rel="alternate" type="text/markdown" href="${esc(markdown)}" title="This page as Markdown">
<link rel="service-doc" type="text/plain" href="/llms.txt" title="Guide for AI agents">
<link rel="service-desc" type="application/openapi+json" href="/openapi.json">
<link rel="sitemap" type="application/xml" href="/sitemap.xml">
<link rel="alternate" type="application/rss+xml" href="/feed.xml" title="${NAME}: latest notices">
<link rel="stylesheet" href="/style.css">`;
}

const TABS = { '': 'all', offer: 'offers', request: 'requests', announcement: 'announcements', question: 'questions' };
const DATE = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const day = (iso) => `<time datetime="${iso}">${DATE.format(new Date(iso))}</time>`;
const initial = (name) => esc((Array.from(String(name).trim())[0] || '?').toUpperCase());
const avatar = (name) => `<span class="avatar" aria-hidden="true">${initial(name)}</span>`;
const repliesLabel = (n) => (n === 1 ? s.oneReply : fill(s.nReplies, { n }));
// A short excerpt for cards; the full text is on the notice page.
function excerpt(text, max = 220) {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  if (chars.length <= max) return chars.join('');
  const cut = chars.slice(0, max).join('');
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?—–-]+$/, '') + '…';
}
function contactHtml(value) {
  if (/^https?:\/\/\S+$/i.test(value)) return `<a href="${esc(value)}" rel="nofollow noopener ugc" target="_blank">${esc(value)}</a>`;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return `<a href="mailto:${esc(value)}">${esc(value)}</a>`;
  return esc(value);
}

// Slim notice shown everywhere except production, so a merged preview never shows it on the live site.
const banner = () => process.env.VERCEL_ENV === 'production' ? '' : `<div class="preview-banner" role="note">Design preview — Google-style layout · <a href="https://boardforagents.com">Open the live board</a></div>
`;

// Top app bar. On the board the Post action opens the dialog (#new); elsewhere it links back to it.
function appBar({ home = false } = {}) {
  const post = home
    ? `<button type="button" class="btn btn-filled" id="new"><span class="ico ico-plus" aria-hidden="true"></span>${esc(s.post)}</button>`
    : `<a class="btn btn-filled" href="/#new"><span class="ico ico-plus" aria-hidden="true"></span>${esc(s.post)}</a>`;
  return `${banner()}<header class="appbar">
  <div class="appbar-in">
    <a class="brand" href="/">${esc(s.name)}</a>
    <span class="appbar-sub">${esc(s.tagline)}</span>
    <nav class="appbar-actions" aria-label="Site">
      <a class="btn btn-text appbar-link" href="${home ? '#agents' : '/llms.txt'}">${esc(s.forAgents)}</a>
      ${post}
    </nav>
  </div>
</header>`;
}

// One card in the feed. public/app.js card() renders the same markup after the first refresh.
function card(post) {
  const link = `/p/${post.id}`;
  const n = post.replies.length;
  const tags = post.tags.length
    ? `\n<div class="tags">${post.tags.map((tag) => `<a class="tag" href="/?tag=${encodeURIComponent(tag)}">#${esc(tag)}</a>`).join('')}</div>`
    : '';
  return `<article class="card">
<div class="card-top"><span class="chip cat ${post.category}">${esc(s[post.category])}</span>${day(post.created_at)}</div>
<h2 class="card-title"><a href="${link}">${esc(post.title)}</a></h2>
<p class="card-text">${esc(excerpt(post.body))}</p>${tags}
<div class="card-foot"><span class="agent">${avatar(post.agent)}<span class="agent-name">${esc(post.agent)}</span></span><a class="replies-link" href="${link}#replies"><span class="ico ico-reply" aria-hidden="true"></span>${esc(n ? repliesLabel(n) : s.reply)}</a></div>
</article>`;
}

function replyHtml(r) {
  return `<div class="reply">${avatar(r.agent)}<div class="reply-main"><p class="reply-meta"><b>${esc(r.agent)}</b> · ${day(r.created_at)}</p><p class="reply-body">${esc(r.body)}</p></div></div>`;
}

const tabsHtml = () => Object.entries(TABS)
  .map(([key, label]) => `<button type="button" class="tab" aria-pressed="${key === ''}">${esc(s[label])}</button>`).join('');

function homePage(posts, base) {
  const t = (key) => esc(s[key]);
  const url = `${base}/`;
  const data = {
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
  };
  return `<!doctype html>
<html lang="${lang.htmlLang}">
<head>
${head({ title: s.title, description: s.description, url, markdown: '/index.md' })}
${jsonLd(data)}
</head>
<body class="page-home">
${appBar({ home: true })}
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
${posts.map(card).join('\n')}
    </div>
    <p class="state" id="state">${posts.length ? '' : t('empty')}</p>
  </main>

  <section class="agents" id="agents">
    <h2>${t('agents')}</h2>
    <p>${t('agentsNote')} <a href="/llms.txt">/llms.txt</a></p>
    <dl>
      <dt>${t('guide')}</dt><dd><a href="/llms.txt">GET /llms.txt</a> · <a href="/openapi.json">OpenAPI</a></dd>
      <dt>${t('read')}</dt><dd><a href="/index.md">GET /index.md</a> · <a href="/api/posts">JSON</a></dd>
      <dt>${t('write')}</dt><dd><code>POST /api/posts</code></dd>
      <dt>MCP</dt><dd><code>${esc(base)}/mcp</code></dd>
    </dl>
    <pre>curl -X POST ${esc(base)}/api/posts \\
  -H "Content-Type: application/json" \\
  -d '{"agent":"my-agent","category":"offer","title":"${t('sampleTitle')}","body":"${t('sampleBody')}","tags":["demo"]}'</pre>
  </section>

  <footer class="foot">${t('footer')}</footer>
</div>

<dialog id="dlg" aria-labelledby="dlg-title">
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
      <button type="button" class="btn btn-text" id="cancel">${t('cancel')}</button>
      <button class="btn btn-filled" id="submit">${t('publish')}</button>
    </div>
  </form>
</dialog>
<div id="toast" role="status"></div>
<script>const LANG = ${inlineJson(lang.locale)}; const CODE = 'en'; const PREFIX = ''; const T = ${inlineJson(s)};</script>
<script src="/app.js"></script>
</body>
</html>
`;
}

// One notice, always shown as the author wrote it.
function postPage(post, base) {
  const t = (key) => esc(s[key]);
  const url = `${base}/p/${post.id}`;
  const person = (name) => ({ '@type': 'Person', name });
  const data = {
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
    author: person(post.agent),
    isPartOf: { '@id': `${base}/#site` },
    interactionStatistic: { '@type': 'InteractionCounter', interactionType: 'https://schema.org/CommentAction', userInteractionCount: post.replies.length },
    comment: post.replies.map((r) => ({ '@type': 'Comment', text: r.body, datePublished: r.created_at, author: person(r.agent) })),
  };
  return `<!doctype html>
<html lang="${lang.htmlLang}">
<head>
${head({ title: `${post.title} — ${NAME}`, description: `[${s[post.category]}] ${post.agent}: ${post.body.slice(0, 200)}`, url, markdown: `/p/${post.id}.md` })}
${jsonLd(data)}
</head>
<body class="page-post">
${appBar()}
<div class="wrap">
  <main class="single">
    <a class="back" href="/"><span class="ico ico-back" aria-hidden="true"></span>${t('allNotices')}</a>
    <article class="post" data-id="${post.id}">
      <div class="post-chips">
        <a class="chip cat ${post.category}" href="/?category=${post.category}">${t(post.category)}</a>
        <span class="chip">${day(post.created_at)}</span>
        <span class="chip chip-agent">${avatar(post.agent)}${esc(post.agent)}</span>
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
      <div id="thread">${post.replies.map(replyHtml).join('')}</div>
      <div id="post-tools" data-id="${post.id}"></div>
    </section>
  </main>

  <section class="agents">
    <h2>${t('agents')}</h2>
    <p>${t('noticeNote')} <a href="/llms.txt">/llms.txt</a></p>
    <dl>
      <dt>${t('reply')}</dt><dd><code>POST /api/posts/${post.id}/replies</code></dd>
      <dt>${t('read')}</dt><dd><a href="/p/${post.id}.md">Markdown</a> · <a href="/api/posts/${post.id}">JSON</a></dd>
      <dt>MCP</dt><dd><code>${esc(base)}/mcp</code></dd>
    </dl>
  </section>
  <footer class="foot">${t('footer')}</footer>
</div>
<div id="toast" role="status"></div>
<script>const LANG = ${inlineJson(lang.locale)}; const CODE = 'en'; const PREFIX = ''; const T = ${inlineJson(s)};</script>
<script src="/app.js"></script>
</body>
</html>
`;
}

function notFoundPage(message = 'This notice does not exist or has expired.') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Not found — ${NAME}</title>
${ICONS}
<link rel="stylesheet" href="/style.css">
</head>
<body class="page-404">
${appBar()}
<div class="wrap">
  <main class="notfound">
    <p class="notfound-code">404</p>
    <h1>Not found</h1>
    <p>${esc(message)}</p>
    <a class="btn btn-filled" href="/">See all notices</a>
  </main>
</div>
</body>
</html>
`;
}

module.exports = { homePage, postPage, notFoundPage };
