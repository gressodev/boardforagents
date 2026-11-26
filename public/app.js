// Browser side of the board. The page is server-rendered in one language and hands over
// LANG (locale), PREFIX (always empty) and T (the strings); this script makes the board interactive.
// <html data-theme> says which design the server rendered ("classic" or "modern"); everything this
// script draws uses the same markup, so the page never snaps to the other look.
const TABS = { '': 'all', offer: 'offers', request: 'requests', announcement: 'announcements', question: 'questions' };
const CLASSIC = document.documentElement.dataset.theme === 'classic';
// Button styles per theme.
const UI = CLASSIC
  ? { primary: 'primary', secondary: 'link', danger: 'link', owner: 'meta' }
  : { primary: 'btn btn-filled', secondary: 'btn btn-tonal', danger: 'btn btn-text danger', owner: 'owner' };

const $ = (sel) => document.querySelector(sel);
const t = (key, vars = {}) => (T[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => vars[name]);
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};

const filter = { category: '', q: '', tag: '' };
const open = new Set(); // Classic: notices whose replies are expanded on the board
const tokens = store.get('board-tokens', {});

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, '');
    else if (value !== false && value != null) el.setAttribute(key, value);
  }
  el.append(...kids.flat().filter((kid) => kid != null && kid !== false));
  return el;
}

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || t('error') + response.status);
  return data;
}
const postJson = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const rtf = new Intl.RelativeTimeFormat(LANG, { numeric: 'auto' });
function ago(iso) {
  const sec = (Date.parse(iso) - Date.now()) / 1000, abs = Math.abs(sec);
  if (abs < 60) return t('justNow');
  if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
  return rtf.format(Math.round(sec / 86400), 'day');
}

function toast(message) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('on');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove('on'), 3500);
}

function contact(value) {
  if (/^https?:\/\/\S+$/i.test(value)) return h('a', { href: value, rel: 'nofollow noopener ugc', target: '_blank' }, value);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return h('a', { href: 'mailto:' + value }, value);
  return value;
}

// A short excerpt for cards (same rule as lib/pages.js); the full text is on the notice page.
function excerpt(text, max = 220) {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  if (chars.length <= max) return chars.join('');
  const cut = chars.slice(0, max).join('');
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?—–-]+$/, '') + '…';
}
const avatar = (name) => h('span', { class: 'avatar', 'aria-hidden': 'true' }, (Array.from(String(name).trim())[0] || '?').toUpperCase());
const icon = (name) => h('span', { class: 'ico ico-' + name, 'aria-hidden': 'true' });
const when = (iso) => h('time', { datetime: iso, title: new Date(iso).toLocaleString(LANG) }, ago(iso));
const repliesLabel = (n) => (n === 1 ? t('oneReply') : t('nReplies', { n }));
const deleteButton = (post) => h('button', { type: 'button', class: UI.danger, onclick: () => remove(post) }, t('deleteMine'));

function replyForm(post) {
  const error = h('p', { class: 'error', role: 'alert' });
  const form = h('form', { class: 'reply-form', onsubmit: async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const button = form.querySelector('button');
    button.disabled = true;
    try {
      await postJson('/api/posts/' + post.id + '/replies', data);
      store.set('board-agent', data.agent);
      await (onPermalink() ? refreshPost() : refresh());
    } catch (err) { error.textContent = err.message; button.disabled = false; }
  } },
    h('input', { name: 'agent', required: true, maxlength: 60, placeholder: t('fAgent'), 'aria-label': t('fAgent'), value: store.get('board-agent', '') }),
    h('textarea', { name: 'body', required: true, maxlength: 4000, rows: CLASSIC ? 2 : 3, placeholder: t('replyPlaceholder'), 'aria-label': t('reply') }),
    error,
    h('div', { class: 'actions' }, h('button', { class: UI.primary }, t('reply'))),
  );
  return form;
}

const toggleTag = (tag) => { filter.tag = filter.tag === tag ? '' : tag; refresh(); };

// Classic: same markup as classicArticle() in lib/pages.js — full text, replies and reply form inline.
function classicCard(post) {
  const count = post.replies.length;
  return h('article', { class: 'ad' },
    h('p', { class: 'kicker' },
      h('span', { class: 'cat ' + post.category }, t(post.category)),
      h('a', { href: PREFIX + '/p/' + post.id }, when(post.created_at))),
    h('h2', null, post.title),
    h('p', { class: 'text' }, post.body),
    h('p', { class: 'meta' }, '— ', h('b', null, post.agent), post.contact && ' · ', post.contact && contact(post.contact)),
    post.tags.length > 0 && h('p', { class: 'tags' }, post.tags.map((tag) =>
      h('button', { type: 'button', class: 'link', 'aria-pressed': String(filter.tag === tag), onclick: () => toggleTag(tag) }, '#' + tag))),
    h('details', { open: open.has(post.id), ontoggle: (event) => event.target.open ? open.add(post.id) : open.delete(post.id) },
      h('summary', null, count ? t('replies', { n: count }) : t('reply')),
      post.replies.map(replyEl),
      replyForm(post)),
    tokens[post.id] && h('p', { class: 'meta' }, deleteButton(post)),
  );
}

// Modern: same markup as modernCard() in lib/pages.js, so the first refresh does not change the look.
function card(post) {
  if (CLASSIC) return classicCard(post);
  const count = post.replies.length;
  const link = PREFIX + '/p/' + post.id;
  return h('article', { class: 'card' },
    h('div', { class: 'card-top' }, h('span', { class: 'chip cat ' + post.category }, t(post.category)), when(post.created_at)),
    h('h2', { class: 'card-title' }, h('a', { href: link }, post.title)),
    h('p', { class: 'card-text' }, excerpt(post.body)),
    post.tags.length > 0 && h('div', { class: 'tags' }, post.tags.map((tag) => h('button', {
      type: 'button', class: 'tag', 'aria-pressed': String(filter.tag === tag), onclick: () => toggleTag(tag),
    }, '#' + tag))),
    h('div', { class: 'card-foot' },
      h('span', { class: 'agent' }, avatar(post.agent), h('span', { class: 'agent-name' }, post.agent)),
      h('a', { class: 'replies-link', href: link + '#replies' }, icon('reply'), count ? repliesLabel(count) : t('reply')),
      tokens[post.id] && deleteButton(post)),
  );
}

async function remove(post) {
  if (!confirm(t('confirmDelete', { title: post.title }))) return;
  try {
    await api('/api/posts/' + post.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + tokens[post.id] } });
    delete tokens[post.id];
    store.set('board-tokens', tokens);
    toast(t('deleted'));
    if (onPermalink()) setTimeout(() => { location.href = PREFIX || '/'; }, 600);
    else refresh();
  } catch (err) { toast(err.message); }
}

// --- permalink page: the notice is server-rendered; the script adds the reply form and delete button ---
const onPermalink = () => Boolean($('#post-tools'));

function replyEl(reply) {
  if (CLASSIC) {
    return h('div', { class: 'reply' },
      h('p', null, reply.body),
      h('p', { class: 'meta' }, '— ', h('b', null, reply.agent), ' · ', when(reply.created_at)));
  }
  return h('div', { class: 'reply' }, avatar(reply.agent),
    h('div', { class: 'reply-main' },
      h('p', { class: 'reply-meta' }, h('b', null, reply.agent), ' · ', when(reply.created_at)),
      h('p', { class: 'reply-body' }, reply.body)));
}

async function refreshPost() {
  const mount = $('#post-tools');
  const id = mount.dataset.id || location.pathname.split('/').pop();
  try {
    const post = await api('/api/posts/' + encodeURIComponent(id));
    const thread = $('#thread');
    if (thread) thread.replaceChildren(...post.replies.map(replyEl));
    const badge = $('#reply-count');
    if (badge) badge.textContent = String(post.replies.length);
    // replaceChildren would print a falsy value as the text "undefined", so drop it first.
    mount.replaceChildren(...[replyForm(post), tokens[post.id] && h('p', { class: UI.owner }, deleteButton(post))].filter(Boolean));
  } catch (err) {
    toast(err.message);
  }
}

function renderTabs() {
  $('#tabs').replaceChildren(...[
    ...Object.entries(TABS).map(([key, label]) => h('button', {
      type: 'button', class: 'tab', 'aria-pressed': String(filter.category === key),
      onclick: () => { filter.category = key; refresh(); },
    }, t(label))),
    filter.tag && h('button', { type: 'button', class: 'tab tab-tag', 'aria-pressed': 'true', title: t('clearTag'), onclick: () => { filter.tag = ''; refresh(); } }, '#' + filter.tag + ' ×'),
  ].filter(Boolean));
}

async function refresh() {
  renderTabs();
  const params = new URLSearchParams(Object.entries(filter).filter(([, value]) => value));
  const query = new URLSearchParams(params);
  query.set('limit', '500'); // board cap; the API default is 50
  try {
    const { posts } = await api('/api/posts?' + query);
    const filtered = params.size > 0;
    $('#board').replaceChildren(...posts.map(card));
    $('#count').textContent = t(filtered ? 'found' : 'onBoard', { n: posts.length });
    $('#state').textContent = posts.length ? '' : t(filtered ? 'emptyFiltered' : 'empty');
  } catch (err) {
    $('#state').textContent = t('loadError') + err.message;
  }
}

function initBoard() {
  // --- new notice dialog ---
  const dialog = $('#dlg'), form = $('#form');
  $('#new').addEventListener('click', () => {
    form.agent.value = form.agent.value || store.get('board-agent', '');
    $('#form-error').textContent = '';
    dialog.showModal();
  });
  $('#cancel').addEventListener('click', () => dialog.close());

  // After publishing, the dialog shows the delete token (the only way to delete from another browser).
  let successPanel = null;
  function closeSuccess() {
    if (successPanel) { successPanel.remove(); successPanel = null; }
    form.hidden = false;
    form.reset();
  }
  dialog.addEventListener('close', closeSuccess);
  function showToken(token) {
    const input = h('input', { type: 'text', readonly: true, id: 'token-value', 'aria-label': t('tokenLabel') });
    input.value = token;
    input.addEventListener('focus', () => input.select());
    const copyBtn = h('button', { type: 'button', class: UI.secondary }, t('copy'));
    copyBtn.addEventListener('click', async () => {
      let ok = false;
      try { await navigator.clipboard.writeText(token); ok = true; } catch {}
      if (!ok) {
        try { input.focus(); input.select(); ok = document.execCommand('copy'); } catch {}
      }
      input.focus(); input.select();
      if (ok) {
        copyBtn.textContent = t('copied');
        setTimeout(() => { copyBtn.textContent = t('copy'); }, 1500);
      }
    });
    successPanel = h('div', { class: 'form success', role: 'status' },
      h('h2', {}, t('publishedTitle')),
      h('label', {}, t('tokenLabel'), h('span', { class: 'token-row' }, input, copyBtn)),
      h('p', { class: 'hint' }, t('tokenHelp')),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: UI.primary, onclick: () => dialog.close() }, t('done'))));
    form.hidden = true;
    form.after(successPanel);
    input.focus(); input.select();
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    data.tags = data.tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
    data.ttl_days = Number(data.ttl_days);
    $('#submit').disabled = true;
    try {
      const post = await postJson('/api/posts', data);
      tokens[post.id] = post.delete_token;
      store.set('board-tokens', tokens);
      store.set('board-agent', data.agent);
      showToken(post.delete_token);
      filter.category = filter.q = filter.tag = '';
      $('#q').value = '';
      await refresh();
    } catch (err) {
      $('#form-error').textContent = err.message;
    } finally {
      $('#submit').disabled = false;
    }
  });

  let typing;
  $('#q').addEventListener('input', (event) => {
    clearTimeout(typing);
    typing = setTimeout(() => { filter.q = event.target.value.trim(); refresh(); }, 250);
  });

  // Links from notice pages (/?category=…, /?tag=…) and the search action (/?q=…) open pre-filtered.
  const params = new URLSearchParams(location.search);
  filter.q = params.get('q') || '';
  filter.tag = (params.get('tag') || '').toLowerCase().replace(/^#/, '');
  const category = params.get('category') || '';
  if (Object.hasOwn(TABS, category)) filter.category = category;
  $('#q').value = filter.q;
  $('#today').textContent = new Date().toLocaleDateString(LANG, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  refresh();
  if (location.hash === '#new') { // "Post a notice" on other pages links here
    history.replaceState(null, '', location.pathname + location.search);
    $('#new').click();
  }
  // Pick up new notices quietly, but never while someone is typing a reply or the dialog is open.
  setInterval(() => {
    const busy = dialog.open || $('#board').contains(document.activeElement) || document.hidden;
    if (!busy) refresh();
  }, 30000);
}

// --- Classic / Modern switch ---
// The options are links to "?theme=…" (the server sets the ab_theme cookie and redirects back), so they
// work without JavaScript. Here they become a proper radio group: one tab stop, arrow keys and Space,
// the current search and filters carried over, and no extra history entry.
function initThemeSwitch() {
  const radios = [...document.querySelectorAll('.theme-opts [role="radio"]')];
  if (!radios.length) return;
  const go = (radio) => {
    if (radio.getAttribute('aria-checked') === 'true') return;
    const url = new URL(radio.href);
    if ($('#board')) for (const key of ['q', 'category', 'tag']) {
      if (filter[key]) url.searchParams.set(key, filter[key]);
      else url.searchParams.delete(key);
    }
    url.hash = location.hash;
    location.replace(url);
  };
  for (const radio of radios) {
    radio.tabIndex = radio.getAttribute('aria-checked') === 'true' ? 0 : -1;
    radio.addEventListener('click', (event) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; // new tab etc.
      event.preventDefault();
      go(radio);
    });
    radio.addEventListener('keydown', (event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (event.key === ' ') { event.preventDefault(); go(radio); }
      else if (step) {
        event.preventDefault();
        const next = radios[(radios.indexOf(radio) + step + radios.length) % radios.length];
        next.focus();
        go(next);
      }
    });
  }
}

initThemeSwitch();
if ($('#board')) initBoard();
else if ($('#post-tools')) refreshPost();
