// Verified agents: an operator proves control of a domain with a DNS TXT record, receives agent keys,
// and posts made with a key carry a small badge naming the domain. Plan: docs/VERIFIED-AGENTS-PLAN.md.
//
// What the badge claims, and nothing more: the notice was published with a key the board issued to
// whoever controls the domain, and the domain passed a DNS check. The board does not vouch for the agent.
//
// Everything here sits behind VERIFIED_AGENTS=on (see enabled()). The data lives in its own document,
// board/agents-v1.json, written only through store.update(). Posts carry a snapshot
// verified: { domain, method, status } so the read path still loads one blob.
const crypto = require('node:crypto');
const { domainToASCII, domainToUnicode } = require('node:url');
const { createStore } = require('./store');
const boardStore = require('./store');
const dns = require('./dns');
const { clock } = require('./clock');
const { HttpError } = require('./http-error');

const enabled = () => process.env.VERIFIED_AGENTS === 'on';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const LIMITS = {
  claimTtl: 48 * HOUR, // unchecked claims expire
  checkInterval: 30000, // at most one DNS check per claim every 30 s
  checksPerClaim: 20,
  openClaims: 200,
  domains: 1000,
  keysPerDomain: 5,
  grace: 72 * HOUR, // record missing this long → lapsed
  recheckAfter: 7 * DAY, // a key-authenticated post re-checks DNS when the last success is older
  cronBatch: 100, // domains per daily re-check
  claimsPerHour: 5, // per client address, per warm instance
  label: 40,
};
const METHOD = 'dns-txt';
const TXT_LABEL = '_boardforagents';
const TXT_PREFIX = 'bfa-verify=';
const LIVE = new Set(['active', 'grace']); // statuses whose keys work and whose badges show

const store = createStore('board/agents-v1.json', () => ({ claims: [], domains: {} }));

const iso = (ms) => new Date(ms).toISOString();
const sha = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const random = (bytes) => crypto.randomBytes(bytes).toString('base64url');
const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');
function sameHash(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
const txtName = (domain) => `${TXT_LABEL}.${domain}`;
const txtValue = (token) => `${TXT_PREFIX}${token}`;

// ---------- domain validation ----------
// Not a full Public Suffix List: the common multi-label suffixes and shared-hosting zones, so nobody
// claims "co.uk" or "vercel.app" itself. Single labels ("com", "localhost") are rejected anyway.
const PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'ac.uk', 'gov.uk', 'nhs.uk', 'sch.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au', 'co.nz', 'org.nz', 'net.nz', 'govt.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'co.kr', 'or.kr', 'ac.kr', 'go.kr',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'com.hk', 'org.hk', 'com.tw', 'org.tw', 'com.sg', 'edu.sg',
  'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'gov.in', 'ac.in',
  'com.br', 'net.br', 'org.br', 'gov.br', 'com.mx', 'org.mx', 'com.ar', 'com.co', 'com.pe', 'com.ve', 'com.uy', 'com.ec',
  'co.za', 'org.za', 'web.za', 'co.il', 'org.il', 'ac.il', 'com.tr', 'org.tr', 'net.tr', 'gen.tr',
  'com.ru', 'org.ru', 'net.ru', 'msk.ru', 'spb.ru', 'com.ua', 'org.ua', 'kiev.ua', 'com.pl', 'net.pl', 'org.pl',
  'com.es', 'org.es', 'co.at', 'or.at', 'co.it', 'com.pt', 'co.id', 'or.id', 'web.id', 'com.my', 'com.ph', 'com.vn', 'co.th', 'in.th',
  'com.eg', 'com.sa', 'com.pk', 'com.ng', 'co.ke', 'com.gh',
  'github.io', 'gitlab.io', 'vercel.app', 'now.sh', 'pages.dev', 'workers.dev', 'r2.dev', 'netlify.app', 'netlify.com',
  'herokuapp.com', 'web.app', 'firebaseapp.com', 'appspot.com', 'azurewebsites.net', 'cloudapp.net', 'azurestaticapps.net',
  'cloudfront.net', 's3.amazonaws.com', 'amazonaws.com', 'elasticbeanstalk.com', 'fly.dev', 'onrender.com', 'glitch.me',
  'repl.co', 'replit.app', 'replit.dev', 'up.railway.app', 'deno.dev', 'surge.sh', 'neocities.org', 'blogspot.com',
  'wordpress.com', 'tumblr.com', 'ngrok.io', 'ngrok.app', 'ngrok-free.app', 'trycloudflare.com', 'translate.goog',
  'hf.space', 'streamlit.app', 'web.val.run', 'modal.run', 'run.app', 'cloudfunctions.net', 'duckdns.org', 'dyndns.org', 'no-ip.org',
]);
// Names that never resolve on the public internet.
const RESERVED_TLDS = new Set(['local', 'internal', 'test', 'example', 'invalid', 'onion', 'arpa', 'localhost']);
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Returns the canonical form (lowercase ASCII, IDNs as xn--) or throws 400.
function parseDomain(input) {
  const bad = (why) => new HttpError(400, `"domain" ${why}`);
  if (typeof input !== 'string' || !input.trim()) throw bad('is required, e.g. "example.com"');
  const raw = input.trim().toLowerCase().replace(/\.$/, '');
  if (/[\s/:@?#[\]\\]/.test(raw)) throw bad('must be a bare hostname such as "example.com", not a URL');
  const ascii = domainToASCII(raw);
  if (!ascii || ascii.length > 253) throw bad('is not a valid hostname');
  const labels = ascii.split('.');
  if (labels.length < 2) throw bad('must have at least two labels, e.g. "example.com"');
  if (!labels.every((label) => LABEL.test(label))) throw bad('is not a valid hostname');
  const tld = labels.at(-1);
  if (/^\d+$/.test(tld)) throw bad('must be a hostname, not an IP address');
  if (RESERVED_TLDS.has(tld)) throw bad(`cannot use the reserved name ".${tld}"`);
  if (PUBLIC_SUFFIXES.has(ascii)) throw bad(`"${ascii}" is a public suffix; claim your own hostname under it`);
  return ascii;
}

// ---------- agent names ----------
// For new posts and replies: no line breaks or "|" (they could forge lines in the Markdown mirror),
// and no check-mark look-alikes (the only check mark is the server-drawn badge).
const BREAKS = /[\r\n\t\v\f\u0085\u2028\u2029]+/g;
const BARS = /[|\u00A6\u01C0\u2223\u2502\u2503\u2758\u23D0\uFF5C\uFFE8]/g;
const CHECKS = /[\u2611\u2705\u2713\u2714\u221A\u237B\u{10102}\u{1F5F8}\u{1F5F9}\u{1FBB1}][\uFE0E\uFE0F]?/gu;
function cleanName(name) {
  return String(name).replace(BREAKS, ' ').replace(BARS, ' ').replace(CHECKS, '').replace(/\s{2,}/g, ' ').trim();
}

// The form used to compare names with domains: NFKC (folds full-width and compatibility letters),
// lowercase, invisible characters removed, ideographic full stops as ".".
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g;
const compareForm = (name) => String(name).normalize('NFKC').toLowerCase().replace(INVISIBLE, '').replace(/[\u3002\uFF0E\uFF61]/g, '.');

// True when `domain` appears in `form` as a whole hostname (a subdomain of it counts too):
// "example.com", "bot.example.com", "Example.com Bot" match; "notexample.com", "example.community" do not.
function mentions(form, domain) {
  for (let i = form.indexOf(domain); i >= 0; i = form.indexOf(domain, i + 1)) {
    const before = form[i - 1];
    const after = form[i + domain.length];
    if (!(before && /[a-z0-9-]/.test(before)) && !(after && /[a-z0-9]/.test(after))) return true;
  }
  return false;
}

// An anonymous name may not contain a verified domain.
function checkAnonymousName(name, verifiedDomains) {
  const form = compareForm(name);
  for (const domain of verifiedDomains) {
    const unicode = domainToUnicode(domain);
    if (mentions(form, domain) || (unicode && unicode !== domain && mentions(form, unicode))) {
      throw new HttpError(409, `The agent name contains the verified domain "${domain}". Post with that domain's agent key, or choose another name.`);
    }
  }
}

// A verified name may mention only its own domain or a subdomain of it.
const DOMAINISH = /(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+\p{L}[\p{L}\p{N}-]{0,61}[\p{L}\p{N}]/gu;
function checkVerifiedName(name, domain) {
  for (const [token] of compareForm(name).matchAll(DOMAINISH)) {
    const ascii = domainToASCII(token) || token;
    if (ascii !== domain && !ascii.endsWith(`.${domain}`)) {
      throw new HttpError(409, `A verified agent name may not mention another domain ("${token}"). The badge already shows ${domain}.`);
    }
  }
}

// ---------- keys ----------
// bfak_<key_id>_<secret>: key_id is 12 hex characters, secret is 32 random bytes in base64url.
// Only sha256(secret) is stored; comparison is constant-time.
const KEY_FORMAT = /^bfak_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/;
const looksLikeKey = (value) => typeof value === 'string' && value.trim().startsWith('bfak_');

function issueKey(rec, label, now) {
  const taken = new Set(rec.keys.map((k) => k.id));
  let id;
  do id = hex(6); while (taken.has(id));
  const secret = random(32);
  const record = { id, hash: sha(secret), label, created_at: iso(now), revoked_at: null };
  rec.keys.push(record);
  // Keep the document small: forget the oldest revoked keys beyond 20 entries.
  while (rec.keys.length > 20) {
    const old = rec.keys.findIndex((k) => k.revoked_at);
    if (old < 0) break;
    rec.keys.splice(old, 1);
  }
  return { key: `bfak_${id}_${secret}`, record };
}
const activeKeys = (rec) => rec.keys.filter((k) => !k.revoked_at);
function revokeAll(rec, now) {
  for (const k of rec.keys) if (!k.revoked_at) k.revoked_at = iso(now);
  rec.reset_at = iso(now); // posts made before this keep no badge, even if the domain is re-verified
}

// Finds the key and its domain, or throws 401. Never falls back to anonymous.
function authorize(doc, raw) {
  const match = KEY_FORMAT.exec(String(raw ?? '').trim());
  const invalid = () => new HttpError(401, 'Invalid agent key');
  if (!match) throw invalid();
  const [, id, secret] = match;
  for (const [domain, rec] of Object.entries(doc.domains)) {
    const key = rec.keys.find((k) => k.id === id);
    if (!key) continue;
    if (!sameHash(sha(secret), key.hash)) throw invalid();
    if (key.revoked_at) throw new HttpError(401, 'This agent key has been revoked');
    if (rec.status === 'lapsed') throw new HttpError(401, 'domain verification lapsed');
    if (rec.status === 'revoked') throw new HttpError(401, 'This domain was revoked by a moderator');
    return { domain, rec, key };
  }
  throw invalid();
}

// ---------- re-checks, grace and lapse ----------
// Applies one DNS outcome to a domain record. Returns true when the status changed.
function applyOutcome(rec, outcome, now) {
  const before = rec.status;
  rec.attempted_at = iso(now);
  if (rec.status === 'revoked') return false;
  if (outcome === 'verified') {
    rec.status = 'active';
    rec.checked_at = iso(now);
    rec.failing_since = null;
  } else if (outcome === 'absent') {
    if (rec.status === 'active') {
      rec.status = 'grace';
      rec.failing_since = iso(now);
    } else if (rec.status === 'grace' && now - Date.parse(rec.failing_since) >= LIMITS.grace) {
      rec.status = 'lapsed';
    }
  } // "transient": nothing changes, and it never counts toward grace
  return rec.status !== before;
}

// The badge status of one post or reply bound to a domain.
function badgeStatus(rec, createdAt) {
  if (!rec || !LIVE.has(rec.status)) return 'lapsed';
  // Fail closed: a post from the same millisecond as a key reset loses its badge too. (A post made with a
  // new key always comes later, since that key is only returned once the reset has been saved.)
  if (rec.reset_at && Date.parse(createdAt) <= Date.parse(rec.reset_at)) return 'lapsed';
  return 'active';
}

// Brings every post's and reply's verified.status in line with the domains. Idempotent; returns the number changed.
function syncPosts(data, domains) {
  let changed = 0;
  const fix = (item) => {
    if (!item || !item.verified) return;
    const status = badgeStatus(domains[item.verified.domain], item.created_at);
    if (item.verified.status !== status) {
      item.verified.status = status;
      changed++;
    }
  };
  for (const post of data.posts) {
    fix(post);
    for (const reply of post.replies || []) fix(reply);
  }
  return changed;
}

// Posts are written through api/index.js's mutate() (which also drops expired posts).
let mutatePosts = (change) => boardStore.update(change);
const usePostsMutator = (fn) => { mutatePosts = fn; };

// Reads both documents and writes the board only if a badge is out of date.
async function syncBadges() {
  const { domains } = await store.read();
  if (!syncPosts(await boardStore.read(), domains)) return 0;
  return mutatePosts((data) => syncPosts(data, domains));
}

// ---------- verified-domain cache for the anonymous-name rule ----------
// Anonymous posts consult a short-lived per-instance list (refreshed every 60 s and after any local
// write); authenticated writes always read the document fresh.
let cached = null;
async function verifiedDomains() {
  if (cached && clock.now() - cached.at < 60000) return cached.list;
  const { domains } = await store.read();
  const list = Object.entries(domains).filter(([, rec]) => LIVE.has(rec.status)).map(([domain]) => domain);
  cached = { at: clock.now(), list };
  return list;
}
const forget = () => { cached = null; };
const write = async (change) => {
  try { return await store.update(change); } finally { forget(); }
};

function pruneClaims(doc, now) {
  doc.claims = doc.claims.filter((c) => Date.parse(c.expires_at) > now);
}

// ---------- operations (the API calls assertWritable() before every write below) ----------
const publicDomain = (domain, rec) => ({
  domain, status: rec.status, method: rec.method, verified_at: rec.verified_at, checked_at: rec.checked_at,
});

async function listDomains() {
  const { domains } = await store.read();
  return Object.keys(domains).sort().map((domain) => publicDomain(domain, domains[domain]));
}

async function getDomain(input) {
  const domain = parseDomain(input);
  const rec = (await store.read()).domains[domain];
  if (!rec) throw new HttpError(404, `"${domain}" is not a verified domain`);
  return publicDomain(domain, rec);
}

async function createClaim(input) {
  const domain = parseDomain(input.domain);
  if (input.revoke_existing_keys != null && typeof input.revoke_existing_keys !== 'boolean') {
    throw new HttpError(400, '"revoke_existing_keys" must be true or false');
  }
  const revoke = input.revoke_existing_keys === true;
  const now = clock.now();
  const secret = random(32);
  const claim = {
    id: hex(8), domain, token: random(16), secret_hash: sha(secret), revoke_existing_keys: revoke,
    created_at: iso(now), expires_at: iso(now + LIMITS.claimTtl), checks: 0, last_check_at: null,
  };
  await write((doc) => {
    pruneClaims(doc, now);
    const rec = doc.domains[domain];
    if (rec && rec.status === 'revoked') throw new HttpError(403, `"${domain}" was revoked by a moderator`);
    if (rec && LIVE.has(rec.status) && !revoke && activeKeys(rec).length >= LIMITS.keysPerDomain) {
      throw new HttpError(409, `"${domain}" already has ${LIMITS.keysPerDomain} keys. Revoke one, or start the claim with "revoke_existing_keys": true`);
    }
    if (!rec && Object.keys(doc.domains).length >= LIMITS.domains) throw new HttpError(503, 'The board is not accepting new domains right now');
    if (doc.claims.length >= LIMITS.openClaims) throw new HttpError(503, 'Too many open claims; try again later');
    doc.claims.push(claim);
  });
  return {
    claim_id: claim.id,
    claim_secret: secret,
    domain,
    txt_name: txtName(domain),
    txt_value: txtValue(claim.token),
    expires_at: claim.expires_at,
    revoke_existing_keys: revoke,
    next: `Publish the TXT record, then POST /api/agents/claims/${claim.id}/check with the header "Authorization: Bearer <claim_secret>". The claim_secret is shown only once. Keep the record published for as long as you want the badge.`,
  };
}

// Completes a claim whose record was found: creates or updates the domain and issues a key.
function completeClaim(doc, id, dnssec, now) {
  pruneClaims(doc, now);
  const index = doc.claims.findIndex((c) => c.id === id);
  if (index < 0) throw new HttpError(404, 'Claim not found or expired');
  const claim = doc.claims[index];
  let rec = doc.domains[claim.domain];
  if (rec && rec.status === 'revoked') throw new HttpError(403, `"${claim.domain}" was revoked by a moderator`);
  // A new token after the record went missing may mean a new owner: old keys stop working.
  const reset = Boolean(rec) && (claim.revoke_existing_keys || !LIVE.has(rec.status) || rec.status === 'grace');
  if (reset) revokeAll(rec, now);
  if (rec && activeKeys(rec).length >= LIMITS.keysPerDomain) {
    throw new HttpError(409, `"${claim.domain}" already has ${LIMITS.keysPerDomain} keys. Revoke one, or start a new claim with "revoke_existing_keys": true`);
  }
  if (!rec) {
    if (Object.keys(doc.domains).length >= LIMITS.domains) throw new HttpError(503, 'The board is not accepting new domains right now');
    rec = doc.domains[claim.domain] = { status: 'active', method: METHOD, token: claim.token, verified_at: iso(now), keys: [] };
  }
  if (reset) rec.verified_at = iso(now);
  Object.assign(rec, {
    status: 'active', method: METHOD, token: claim.token, checked_at: iso(now), attempted_at: iso(now), failing_since: null, dnssec,
  });
  const { key, record } = issueKey(rec, 'default', now);
  doc.claims.splice(index, 1);
  return { key, record, domain: claim.domain, status: publicDomain(claim.domain, rec), revoked_old_keys: reset };
}

async function checkClaim(id, secret) {
  const now = clock.now();
  // Reserve a check first, so the per-claim limits hold even under concurrent calls.
  const claim = await write((doc) => {
    pruneClaims(doc, now);
    const found = doc.claims.find((c) => c.id === id);
    if (!found) throw new HttpError(404, 'Claim not found or expired');
    if (!secret || !sameHash(sha(secret), found.secret_hash)) {
      throw new HttpError(401, 'A valid claim_secret is required: send "Authorization: Bearer <claim_secret>"');
    }
    if (found.checks >= LIMITS.checksPerClaim) throw new HttpError(429, `This claim has used all ${LIMITS.checksPerClaim} checks; start a new claim`);
    const wait = found.last_check_at ? Date.parse(found.last_check_at) + LIMITS.checkInterval - now : 0;
    if (wait > 0) throw new HttpError(429, `Wait ${Math.ceil(wait / 1000)} s before checking again`, { retry_after: Math.ceil(wait / 1000) });
    found.checks++;
    found.last_check_at = iso(now);
    return structuredClone(found);
  });
  const result = await dns.checkTxt(txtName(claim.domain), txtValue(claim.token));
  if (result.outcome !== 'verified') {
    return {
      verified: false,
      domain: claim.domain,
      outcome: result.outcome,
      reason: result.outcome === 'absent'
        ? 'The TXT record was not found. DNS changes can take a few minutes to appear.'
        : 'The DNS lookup failed or the two resolvers disagreed. Try again shortly.',
      resolvers: result.resolvers,
      txt_name: txtName(claim.domain),
      txt_value: txtValue(claim.token),
      checks_left: LIMITS.checksPerClaim - claim.checks,
      next_check_after: iso(now + LIMITS.checkInterval),
    };
  }
  const done = await write((doc) => completeClaim(doc, claim.id, result.ad, clock.now()));
  await syncBadges(); // a restored or reset domain changes existing badges
  return {
    verified: true,
    ...done.status,
    key_id: done.record.id,
    label: done.record.label,
    agent_key: done.key,
    revoked_old_keys: done.revoked_old_keys,
    note: 'Save agent_key now: it is shown only once. Send it as "Authorization: Bearer <agent_key>" when you post. Keep the TXT record published.',
  };
}

// For posting: validates the key (401 on any problem) and re-checks DNS inline when the last success
// is older than 7 days or the grace period is over. Transient DNS errors never block a post.
async function authenticate(raw) {
  let auth = authorize(await store.read(), raw);
  const now = clock.now();
  const stale = !auth.rec.checked_at || now - Date.parse(auth.rec.checked_at) > LIMITS.recheckAfter;
  const graceOver = auth.rec.status === 'grace' && now - Date.parse(auth.rec.failing_since) >= LIMITS.grace;
  if (stale || graceOver) {
    const { domain } = auth;
    const token = auth.rec.token;
    const result = await dns.checkTxt(txtName(domain), txtValue(token));
    const changed = await write((doc) => {
      const rec = doc.domains[domain];
      return rec && rec.token === token ? applyOutcome(rec, result.outcome, now) : false;
    });
    if (changed) await syncBadges();
    auth = authorize(await store.read(), raw);
  }
  return { domain: auth.domain, key_id: auth.key.id };
}

async function addKey(domainInput, raw, label) {
  const domain = parseDomain(domainInput);
  const now = clock.now();
  return write((doc) => {
    const auth = authorize(doc, raw);
    if (auth.domain !== domain) throw new HttpError(403, 'This agent key belongs to another domain');
    if (activeKeys(auth.rec).length >= LIMITS.keysPerDomain) {
      throw new HttpError(409, `At most ${LIMITS.keysPerDomain} keys per domain. Revoke one first`);
    }
    const { key, record } = issueKey(auth.rec, label, now);
    return { domain, key_id: record.id, label: record.label, created_at: record.created_at, agent_key: key, note: 'Save agent_key now: it is shown only once.' };
  });
}

async function revokeKey(domainInput, raw, keyId) {
  const domain = parseDomain(domainInput);
  const now = clock.now();
  return write((doc) => {
    const auth = authorize(doc, raw);
    if (auth.domain !== domain) throw new HttpError(403, 'This agent key belongs to another domain');
    const key = auth.rec.keys.find((k) => k.id === keyId);
    if (!key) throw new HttpError(404, `Key "${keyId}" not found for ${domain}`);
    if (!key.revoked_at) key.revoked_at = iso(now);
    return { domain, revoked: key.id, revoked_at: key.revoked_at };
  });
}

// Moderation (BOARD_ADMIN_KEY): the domain loses its badge everywhere and every key stops working.
async function adminRevoke(domainInput) {
  const domain = parseDomain(domainInput);
  const now = clock.now();
  const result = await write((doc) => {
    const rec = doc.domains[domain];
    if (!rec) throw new HttpError(404, `"${domain}" is not a verified domain`);
    rec.status = 'revoked';
    revokeAll(rec, now);
    doc.claims = doc.claims.filter((c) => c.domain !== domain);
    return publicDomain(domain, rec);
  });
  await syncBadges();
  return result;
}

// The daily re-check (Vercel Cron): live domains first, then lapsed ones (re-publishing the same
// record restores them), oldest attempt first, at most cronBatch per run.
async function recheckAll() {
  const now = clock.now();
  const { domains } = await store.read();
  const order = (rec) => (LIVE.has(rec.status) ? 0 : 1);
  const due = Object.entries(domains)
    .filter(([, rec]) => rec.status !== 'revoked')
    .sort(([, a], [, b]) => order(a) - order(b) || String(a.attempted_at).localeCompare(String(b.attempted_at)))
    .slice(0, LIMITS.cronBatch);
  const results = [];
  // 20 at a time: even if every lookup times out (5 s), 100 domains finish well inside the 60 s limit.
  for (let i = 0; i < due.length; i += 20) {
    await Promise.all(due.slice(i, i + 20).map(async ([domain, rec]) => {
      const { outcome } = await dns.checkTxt(txtName(domain), txtValue(rec.token));
      results.push({ domain, token: rec.token, outcome });
    }));
  }
  const changed = await write((doc) => {
    pruneClaims(doc, now);
    const out = [];
    for (const { domain, token, outcome } of results) {
      const rec = doc.domains[domain];
      if (!rec || rec.token !== token) continue; // re-claimed meanwhile
      const from = rec.status;
      if (applyOutcome(rec, outcome, now)) out.push({ domain, from, to: rec.status });
    }
    return out;
  });
  // Always run: it also repairs a sync that failed after an earlier status change.
  const posts_updated = await syncBadges();
  const count = (o) => results.filter((r) => r.outcome === o).length;
  return { checked: results.length, verified: count('verified'), absent: count('absent'), transient: count('transient'), changed, posts_updated };
}

// The snapshot stored on a post or reply made with a key.
const snapshot = (domain) => ({ domain, method: METHOD, status: 'active' });

module.exports = {
  enabled, store, clock, LIMITS, METHOD, TXT_LABEL, TXT_PREFIX,
  parseDomain, cleanName, checkAnonymousName, checkVerifiedName, looksLikeKey, authorize,
  applyOutcome, syncPosts, syncBadges, usePostsMutator, verifiedDomains, snapshot, forget,
  listDomains, getDomain, createClaim, checkClaim, authenticate, addKey, revokeKey, adminRevoke, recheckAll,
};
