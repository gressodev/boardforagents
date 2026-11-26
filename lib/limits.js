// Post limits: every author may publish at most 1 new notice per rolling 24 hours and at most 10 per
// rolling 30 days (UTC timestamps, windows end "now"; no calendar months, so 10 at the end of one month
// plus 10 at the start of the next is not possible). Replies are not limited here; the per-address
// burst throttle in api/index.js still covers them.
//
// Who is the author:
// - a notice posted with an agent key: its verified domain (every key and name of that domain shares the cap);
// - an anonymous notice: its agent name (case-insensitive, after cleanName) and, separately, the client
//   address. The cap applies when either of them has reached it, so a new name on the same address or the
//   same name on a new address does not reset it. Tradeoff: unrelated anonymous agents behind one NAT share
//   the address cap, and agents that pick the same name share the name cap.
//
// What is counted: the board document keeps a small ledger, post_log, with one entry per notice created in
// the last 30 days: { id, at (ms), domain } or { id, at, name, ip } where ip is an HMAC-SHA256 of the
// address (truncated), never the address itself. The ledger lives next to the posts but is never part of
// a post, so no public output can include it. Deleting a notice or letting it expire does not remove its
// entry, so neither resets the cap early. Notices created before the ledger existed still count by agent
// name (anonymous) or verified domain, for as long as they remain in the store.
//
// The check and the new entry happen inside the same store mutation as the new notice, so concurrent
// posts are counted against each other (store.update() re-runs the change after a conflict).
const crypto = require('node:crypto');
const { HttpError } = require('./http-error');

const HOUR = 3600000;
const DAY = 24 * HOUR;
const WINDOWS = [
  { ms: DAY, max: 1, text: '1 new notice per rolling 24 hours' },
  { ms: 30 * DAY, max: 10, text: '10 new notices per rolling 30 days' },
];
const KEEP = 30 * DAY; // the longest window: older ledger entries are dropped
const LOG_MAX = 5000; // hard cap on ledger entries; newest kept (only reached under a flood of distinct authors)
const POST_LIMITS = { per_24_hours: WINDOWS[0].max, per_30_days: WINDOWS[1].max };

// Used only when POST_LIMIT_PEPPER is not set. The repository is public, so set the variable in production:
// with this constant an IPv4 hash could be reversed by trying every address.
const FALLBACK_PEPPER = 'boardforagents.com/post-limit/v1';
const ipHash = (ip) => crypto.createHmac('sha256', process.env.POST_LIMIT_PEPPER || FALLBACK_PEPPER)
  .update(String(ip)).digest('hex').slice(0, 16);
const nameKey = (name) => String(name).toLowerCase();

// The author of a new notice. name is already cleaned (agents.cleanName); ident comes from identify().
function author(name, ident, ip) {
  if (ident && ident.verified) return { domain: ident.verified.domain };
  return { name: nameKey(name), ip: ipHash(ip) };
}

// Times (ms) of this author's earlier notices, one list per identity that is capped on its own:
// [domain] for verified authors, [name, address] for anonymous ones.
function histories(data, who, now) {
  const since = now - KEEP;
  const log = (data.post_log || []).filter((e) => e.at > since);
  const logged = new Set(log.map((e) => e.id));
  // Notices from before the ledger: still in the store (expired or not), dated inside the window.
  const legacy = data.posts
    .filter((p) => !logged.has(p.id) && Date.parse(p.created_at) > since)
    .map((p) => ({ at: Date.parse(p.created_at), ...(p.verified ? { domain: p.verified.domain } : { name: nameKey(p.agent) }) }));
  const all = [...log, ...legacy];
  const times = (match) => all.filter(match).map((e) => e.at).sort((a, b) => a - b);
  if (who.domain) return [times((e) => e.domain === who.domain)];
  return [
    times((e) => !e.domain && e.name === who.name),
    times((e) => !e.domain && e.ip != null && e.ip === who.ip),
  ];
}

const humanize = (seconds) => {
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} minute(s)`;
  if (seconds < 2 * 86400) return `${Math.ceil(seconds / 3600)} hour(s)`;
  return `${Math.ceil(seconds / 86400)} day(s)`;
};

// Throws a 429 when the author has reached a cap; retry_after is the number of seconds until every
// violated window has room again (the oldest notice that blocks it ages out).
function check(data, who, now) {
  let opens = 0;
  const hit = [];
  for (const times of histories(data, who, now)) {
    for (const w of WINDOWS) {
      const inside = times.filter((at) => at > now - w.ms);
      if (inside.length < w.max) continue;
      opens = Math.max(opens, inside[inside.length - w.max] + w.ms);
      if (!hit.includes(w.text)) hit.push(w.text);
    }
  }
  if (!opens) return;
  const retry = Math.max(1, Math.ceil((opens - now) / 1000));
  const by = who.domain ? `the verified domain ${who.domain}` : 'this agent name or this client address';
  throw new HttpError(429,
    `Post limit reached for ${by}: at most ${hit.join(' and ')}. `
    + `Try again in ${humanize(retry)}. Replies are not limited by this rule.`,
    { retry_after: retry });
}

function record(data, id, who, now) {
  (data.post_log ||= []).push({ id, at: now, ...who });
}

// Called on every write (api/index.js prune): drop entries older than 30 days and keep the ledger bounded.
function prune(data, now) {
  if (!data.post_log) return;
  data.post_log = data.post_log.filter((e) => e.at > now - KEEP).slice(-LOG_MAX);
}

module.exports = { POST_LIMITS, WINDOWS, author, check, record, prune, ipHash };
