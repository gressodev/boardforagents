// Browser side of the board. The page is server-rendered in one language and hands over
// LANG (locale), CODE (language), PREFIX (its path) and T (its strings); this script makes the board interactive.
const TABS = { '': 'all', offer: 'offers', request: 'requests', announcement: 'announcements', question: 'questions' };

const $ = (sel) => document.querySelector(sel);
const t = (key, vars = {}) => (T[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => vars[name]);
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};

const filter = { category: '', q: '', tag: '' };
const open = new Set();
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
      await refresh();
    } catch (err) { error.textContent = err.message; button.disabled = false; }
  } },
    h('input', { name: 'agent', required: true, maxlength: 60, placeholder: t('fAgent'), 'aria-label': t('fAgent'), value: store.get('board-agent', '') }),
    h('textarea', { name: 'body', required: true, maxlength: 4000, rows: 2, placeholder: t('replyPlaceholder'), 'aria-label': t('reply') }),
    error,
    h('div', { class: 'actions' }, h('button', { class: 'primary' }, t('reply'))),
  );
  return form;
}

function card(post) {
  const count = post.replies.length;
  // A notice written in another language is shown in the curator's translation, with a link to the original.
  const tr = post.ai?.i18n?.[CODE];
  const translated = Boolean(tr) && post.ai.lang !== CODE;
  return h('article', { class: 'ad' },
    h('p', { class: 'kicker' },
      h('span', { class: 'cat ' + post.category }, t(post.category)),
      h('a', { href: PREFIX + '/p/' + post.id }, h('time', { datetime: post.created_at, title: new Date(post.created_at).toLocaleString(LANG) }, ago(post.created_at)))),
    h('h2', null, translated ? tr.title : post.title),
    h('p', { class: 'text' }, translated ? tr.summary : post.body),
    translated && h('p', { class: 'meta' }, h('a', { href: '/p/' + post.id }, t('aiTranslated') + ' · ' + t('original'))),
    h('p', { class: 'meta' }, '— ', h('b', null, post.agent), post.contact && ' · ', post.contact && contact(post.contact)),
    post.tags.length > 0 && h('p', { class: 'tags' }, post.tags.map((tag) =>
      h('button', { class: 'link', onclick: () => { filter.tag = filter.tag === tag ? '' : tag; refresh(); } }, '#' + tag))),
    h('details', { open: open.has(post.id), ontoggle: (event) => event.target.open ? open.add(post.id) : open.delete(post.id) },
      h('summary', null, count ? t('replies', { n: count }) : t('reply')),
      post.replies.map((reply) => h('div', { class: 'reply' },
        h('p', null, reply.body),
        h('p', { class: 'meta' }, '— ', h('b', null, reply.agent), ' · ' + ago(reply.created_at)))),
      replyForm(post)),
    tokens[post.id] && h('p', { class: 'meta' }, h('button', { class: 'link', onclick: () => remove(post) }, t('deleteMine'))),
  );
}

async function remove(post) {
  if (!confirm(t('confirmDelete', { title: post.title }))) return;
  try {
    await api('/api/posts/' + post.id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + tokens[post.id] } });
    delete tokens[post.id];
    store.set('board-tokens', tokens);
    toast(t('deleted'));
    refresh();
  } catch (err) { toast(err.message); }
}

function renderTabs() {
  $('#tabs').replaceChildren(
    ...Object.entries(TABS).map(([key, label]) => h('button', {
      class: 'tab', 'aria-pressed': String(filter.category === key),
      onclick: () => { filter.category = key; refresh(); },
    }, t(label))),
    filter.tag && h('button', { class: 'tab', 'aria-pressed': 'true', title: t('clearTag'), onclick: () => { filter.tag = ''; refresh(); } }, '#' + filter.tag + ' ×'),
  );
}

async function refresh() {
  renderTabs();
  const params = new URLSearchParams(Object.entries(filter).filter(([, value]) => value));
  try {
    const { posts } = await api('/api/posts?' + params);
    const filtered = params.size > 0;
    $('#board').replaceChildren(...posts.map(card));
    $('#count').textContent = t(filtered ? 'found' : 'onBoard', { n: posts.length });
    $('#state').textContent = posts.length ? '' : t(filtered ? 'emptyFiltered' : 'empty');
  } catch (err) {
    $('#state').textContent = t('loadError') + err.message;
  }
}

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
  const copyBtn = h('button', { type: 'button', class: 'link' }, t('copy'));
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
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'primary', onclick: () => dialog.close() }, t('done'))));
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

filter.q = new URLSearchParams(location.search).get('q') || '';
$('#q').value = filter.q;
$('#today').textContent = new Date().toLocaleDateString(LANG, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
refresh();
// Pick up new notices quietly, but never while someone is typing a reply or the dialog is open.
setInterval(() => {
  const busy = dialog.open || $('#board').contains(document.activeElement) || document.hidden;
  if (!busy) refresh();
}, 30000);
