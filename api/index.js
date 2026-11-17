'use strict';
// The whole server: one function, routed by path. Every route except sign-up, sign-in, config, the Shortcut log and the
// timed notes needs a signed-in session, and every query is limited to that person's own rows.
const crypto = require('crypto');
// jose is published only as an ES module, so it is loaded with import() the first time it is needed.
let joseLib = null;
const jose = async () => joseLib || (joseLib = await import('jose'));
let webpushLib = null;
const webpushMod = async () => {
  if (!webpushLib) {
    const m = await import('web-push');
    webpushLib = m.default || m;
  }
  return webpushLib;
};
const { q } = require('../lib/db');
const compute = require('../lib/compute');
const { numbers, inZone } = compute;
const notes = require('../lib/notes');
const vault = require('../lib/vault');
const vision = require('../lib/vision');
const bills = require('../lib/bills');
const billtext = require('../lib/billtext');
const payperiod = require('../public/payperiod.js');
const customcats = require('../lib/customcats');
const storeai = require('../lib/storeai');
const learn = require('../lib/learn');
const merchants = require('../public/merchants.js');
const itemkinds = require('../lib/itemkinds');

const env = (k) => process.env[k] || '';
const SITE = () => env('SITE_URL') || 'https://my-spending-two.vercel.app';
const enc = new TextEncoder();
const sessionKey = () => enc.encode(env('SESSION_SECRET'));
const PUSH_HOSTS = [/\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];
const MAX_BODY = 16 * 1024;
const DAY = 86400000;

// ---- small helpers -------------------------------------------------------------------------------------------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

// Compares a secret someone sent with the real one without the time taken giving anything away.
const secretIs = (given, real) => {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(String(real || '')).digest();
  return !!real && crypto.timingSafeEqual(a, b);
};

const send = (res, status, obj) => {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
};

const readBody = async (req, limit) => {
  if (req.body !== undefined && req.body !== null && typeof req.body !== 'string' && !Buffer.isBuffer(req.body)) return req.body;
  let text = '';
  if (typeof req.body === 'string') text = req.body;
  else if (Buffer.isBuffer(req.body)) text = req.body.toString('utf8');
  else {
    text = await new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > (limit || MAX_BODY)) { reject(new HttpError(413, 'Too much data')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
  if (text.length > (limit || MAX_BODY)) fail(413, 'Too much data');
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch (e) { return { text }; }
};

const bearer = (req) => {
  const h = String(req.headers.authorization || '');
  return h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
};

const iso = (v) => new Date(v).toISOString();
const issueOf = (r) => ({ number: Number(r.id), title: r.title, body: r.body, state: r.state, created_at: iso(r.created_at), kind: r.kind || '', draft: r.b_draft ? true : undefined, bill: r.b_n ? { n: Number(r.b_n), need: Number(r.b_need) || 0, fun: Number(r.b_fun) || 0, unk: Number(r.b_unk) || 0 } : undefined });
// Purchase text is stored scrambled (lib/vault.js), so every row read from the database is opened for its owner here.
const issuesOf = (userId, rows) => rows.map((r) => issueOf(vault.openRow(userId, r)));
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---- sessions -------------------------------------------------------------------------------------------------
const makeSession = async (user) => new (await jose()).SignJWT({ v: user.session_version })
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject(user.id)
  .setIssuedAt()
  .setExpirationTime('365d')
  .sign(sessionKey());

const signedIn = async (req) => {
  const token = bearer(req);
  if (!token) fail(401, 'Please sign in');
  let payload;
  try {
    ({ payload } = await (await jose()).jwtVerify(token, sessionKey(), { algorithms: ['HS256'] }));
  } catch (e) {
    fail(401, 'Please sign in again');
  }
  const rows = await q('select * from users where id = $1', [payload.sub]);
  const user = rows[0];
  if (!user || user.session_version !== payload.v) fail(401, 'Please sign in again');
  if (user.disabled) fail(401, 'Your access was removed by the owner');
  // Remember roughly when the app was last opened (at most once every 10 minutes). Only the time, never what was done.
  await q("update users set last_seen = now() where id = $1 and (last_seen is null or last_seen < now() - interval '10 minutes')", [user.id]);
  return user;
};

// ---- owner and invites ------------------------------------------------------------------------------------------
// The owner is the account whose email is in OWNER_EMAIL. Only the owner can invite people and manage access.
const ownerEmail = () => env('OWNER_EMAIL').trim().toLowerCase();
const isOwner = (u) => !!ownerEmail() && String(u.email).toLowerCase() === ownerEmail();
const ownerOnly = async (req) => {
  const u = await signedIn(req);
  if (!isOwner(u)) fail(403, 'Only the owner can do this');
  return u;
};
const ipKey = (req) => sha(String((req.headers && req.headers['x-forwarded-for']) || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim()).slice(0, 16);
const TRY_LIMIT = 10;
const TRY_WINDOW = 15 * 60000;
const tooManyTries = async (req) => {
  const rows = await q('select count(*)::int as n from signup_attempts where ip = $1 and at > $2', [ipKey(req), new Date(Date.now() - TRY_WINDOW).toISOString()]);
  return rows[0].n >= TRY_LIMIT;
};
const noteFailedTry = async (req) => {
  await q('insert into signup_attempts (ip) values ($1)', [ipKey(req)]);
  await q('delete from signup_attempts where at < $1', [new Date(Date.now() - DAY).toISOString()]);
};
const signupsOpen = async () => {
  const rows = await q("select value from app_settings where key = 'signups_open'");
  return !rows[0] || rows[0].value !== 'false';
};
const makeInvite = async (note, days) => {
  const code = 'inv_' + crypto.randomBytes(18).toString('base64url');
  const d = Math.min(90, Math.max(1, Math.round(Number(days)) || 7));
  const rows = await q('insert into invites (code_hash, note, expires_at) values ($1, $2, $3) returning id, expires_at', [sha(code), clean(note, 60), new Date(Date.now() + d * DAY).toISOString()]);
  return { id: Number(rows[0].id), code, expires_at: iso(rows[0].expires_at) };
};

// A reset code is made by the owner (or with the admin secret), works once, and lasts 24 hours. Only its hash is stored.
const makeReset = async (userId) => {
  const code = 'rst_' + crypto.randomBytes(18).toString('base64url');
  const expires = new Date(Date.now() + DAY).toISOString();
  await q('update users set reset_hash = $2, reset_expires = $3 where id = $1', [userId, sha(code), expires]);
  return { code, expires_at: expires };
};

// ---- email and password -----------------------------------------------------------------------------------------
// Passwords are kept only as salted scrypt hashes. After 5 wrong tries an account is locked for 15 minutes.
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const scrypt = (password, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(password, salt, 64, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
});
const hashPassword = async (password) => {
  const salt = crypto.randomBytes(16);
  return 's1$' + salt.toString('base64') + '$' + (await scrypt(password, salt)).toString('base64');
};
const checkPassword = async (password, stored) => {
  const [tag, salt, hash] = String(stored).split('$');
  if (tag !== 's1' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'base64');
  const got = await scrypt(password, Buffer.from(salt, 'base64'));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
};
const DUMMY_HASH = 's1$AAAAAAAAAAAAAAAAAAAAAA==$' + Buffer.alloc(64).toString('base64');
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.][^\s@]{0,250}\.[^\s@.]{2,}$/;
const MAX_TRIES = 5;
const LOCK_MS = 15 * 60000;

// ---- the saving game (Penny) ------------------------------------------------------------------------------------
// Every day you stay under your daily limit, what is left becomes coins you feed to Penny. The coins fill a goal you
// name, and earn XP: 10 per day collected plus 1 per dollar, and 1 more per dollar if you move the money to savings
// for real. Days can be collected for the last week, and today from 8 PM. If more is spent on a collected day later,
// that day counts for less (never more).
const COLLECT_BACK = 7;
const COLLECT_HOUR = 20;
const levelXp = (lv) => 50 * lv * (lv - 1);
const levelOf = (xp) => { let lv = 1; while (levelXp(lv + 1) <= xp) lv++; return lv; };
const outfitOf = (lv) => (lv >= 6 ? 'gold' : ['', '', 'hat', 'shades', 'bow', 'crown'][lv] || '');
const r2 = (v) => Math.round(v * 100) / 100;
const pastDays = (tz, n) => inZone(tz, () => {
  const p = (x) => (x < 10 ? '0' : '') + x;
  const out = [];
  for (let i = 1; i <= n; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push(d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()));
  }
  return out;
});

const gameState = async (u) => {
  const g = (await q('select * from game where user_id = $1', [u.id]))[0] || { goal_name: '', goal_emoji: '', goal_amount: 0, xp: 0 };
  const n = await numbersFor(u);
  const spentOn = {};
  n.spend.forEach((r) => { spentOn[r.day] = (spentOn[r.day] || 0) + r.amount; });
  const first = Object.keys(spentOn).sort()[0] || null;
  const limit = limitOf(u);
  const recent = pastDays(u.tz, COLLECT_BACK + 1);
  const done = await q('select day, saved, limit_at, real from game_days where user_id = $1', [u.id]);
  const doneSet = new Set(done.map((d) => d.day));
  const worth = (d) => {
    const saved = Number(d.saved);
    if (d.day !== n.today && !recent.includes(d.day)) return saved;
    return r2(Math.max(0, Math.min(saved, Number(d.limit_at) - (spentOn[d.day] || 0))));
  };
  const saved = r2(done.reduce((sum, d) => sum + worth(d), 0));
  const realSaved = r2(done.filter((d) => d.real).reduce((sum, d) => sum + worth(d), 0));
  const candidates = (n.hour >= COLLECT_HOUR ? [n.today] : []).concat(recent.slice(0, COLLECT_BACK));
  const collectible = limit > 0 && first
    ? candidates.filter((day) => day >= first && !doneSet.has(day))
      .map((day) => ({ day, amount: r2(Math.min(limit, limit - (spentOn[day] || 0))) }))
      .filter((c) => c.amount > 0)
    : [];
  const xp = Number(g.xp) || 0;
  const level = levelOf(xp);
  return {
    goal: { name: g.goal_name, emoji: g.goal_emoji, amount: Number(g.goal_amount) || 0, saved },
    xp, level, levelXp: levelXp(level), nextXp: levelXp(level + 1), outfit: outfitOf(level),
    limit, daysCollected: done.length, realSaved, collectible, started: g.created_at ? iso(g.created_at) : null,
    coins: r2(collectible.reduce((sum, c) => sum + c.amount, 0))
  };
};
const addXp = async (u, gain) => {
  const rows = await q(`insert into game (user_id, xp) values ($1, $2)
                        on conflict (user_id) do update set xp = game.xp + excluded.xp returning xp`, [u.id, gain]);
  return Number(rows[0].xp);
};

// ---- the Shortcut's setup code ----------------------------------------------------------------------------------
// Kept hashed for checking, and encrypted so the app can show it again for setting up another automation.
const codeKey = () => crypto.createHash('sha256').update('setup-code:' + env('SESSION_SECRET')).digest();
const seal = (text) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', codeKey(), iv);
  const out = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), out]).toString('base64');
};
const unseal = (b64) => {
  const b = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', codeKey(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
};
const newCode = async (user) => {
  const code = 'sp_' + crypto.randomBytes(24).toString('base64url');
  await q('update users set key_hash = $2, key_enc = $3 where id = $1', [user.id, sha(code), seal(code)]);
  return code;
};

// ---- turning a Shortcut's fields into a purchase ----------------------------------------------------------------
const clean = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max || 160);
const pick = (o, ...names) => {
  const keys = Object.keys(o || {});
  for (const n of names) {
    const k = keys.find((x) => x.toLowerCase() === n);
    if (k !== undefined && clean(o[k]) !== '') return o[k];
  }
  return '';
};

const fromShortcut = (input) => {
  const o = input && typeof input === 'object' ? input : {};
  const date = clean(pick(o, 'date', 'when', 'time'), 40) || new Date().toISOString();
  const wTitle = pick(o, 'title', 'notificationtitle');
  const wSub = pick(o, 'subtitle', 'notificationsubtitle');
  const wBody = pick(o, 'body', 'notificationbody', 'text', 'message');
  // A Wallet alert is one that says so, or one with alert text and no amount of its own. It may also carry a cleaned-up
  // merchant name and a category (made by the phone's own model), which are kept next to the raw alert text.
  const isWallet = /wallet|notification/i.test(String(pick(o, 'source', 'type'))) || (!pick(o, 'amount') && (wTitle || wSub || wBody));
  if (isWallet) {
    if (!(wTitle || wSub || wBody)) fail(400, 'The Wallet alert had no text');
    const cleanName = clean(pick(o, 'merchant'), 80);
    const cat = clean(pick(o, 'category'), 60);
    return {
      title: 'Spending - wallet alert',
      body: ['Source: wallet-notification', 'Date: ' + date].concat(cleanName ? ['Merchant: ' + cleanName] : [], cat ? ['Category: ' + cat] : [], ['Title: ' + clean(wTitle), 'Subtitle: ' + clean(wSub), 'Body: ' + clean(wBody, 300)]).join('\n')
    };
  }
  const merchant = clean(pick(o, 'merchant', 'store', 'name'));
  const amount = clean(pick(o, 'amount', 'total', 'price'), 40);
  if (!amount) fail(400, 'No amount was sent');
  const card = clean(pick(o, 'card', 'pass', 'paymentcard'));
  const category = clean(pick(o, 'category'), 60);
  const shownAmount = /\$/.test(amount) ? amount : '$' + amount;
  return {
    title: 'Spending - ' + shownAmount + ' - ' + date.slice(0, 10) + (category ? ' - ' + category : ''),
    body: ['Date: ' + date, 'Merchant: ' + merchant, 'Amount: ' + shownAmount, 'Card: ' + card, 'Category: ' + category].join('\n')
  };
};

// ---- push -------------------------------------------------------------------------------------------------------
const pushReady = async () => {
  if (!env('VAPID_PUBLIC_KEY') || !env('VAPID_PRIVATE_KEY')) return false;
  try {
    (await webpushMod()).setVapidDetails(SITE(), env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'));
    return true;
  } catch (e) {
    console.error('push keys are not usable:', e.message);
    return false;
  }
};
let pushSender = async (sub, payload) => (await webpushMod()).sendNotification(sub, payload, { TTL: 6 * 3600, urgency: 'high' });

const pushTo = async (userId, message, only) => {
  if (!(await pushReady())) return 0;
  const devices = only ? [only] : await q('select * from devices where user_id = $1', [userId]);
  let sent = 0;
  for (const d of devices) {
    try {
      await pushSender({ endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } }, JSON.stringify({ ...message, url: SITE() + '/' }));
      sent++;
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) await q('delete from devices where endpoint = $1', [d.endpoint]);
    }
  }
  return sent;
};

// ---- numbers for one person ------------------------------------------------------------------------------------
const recentIssues = async (userId, days) => {
  const rows = await q("select p.id, p.title, p.body, p.state, p.kind, p.created_at, b.n as b_n, b.need as b_need, b.fun as b_fun, b.unk as b_unk, exists(select 1 from bill_drafts d where d.purchase_id = p.id) as b_draft from purchases p left join (select purchase_id, count(*)::int as n, sum(alloc) filter (where kind = 'need') as need, sum(alloc) filter (where kind = 'fun') as fun, sum(alloc) filter (where kind = 'unk') as unk from bill_items where user_id = $1 group by purchase_id) b on b.purchase_id = p.id where p.user_id = $1 and p.state = 'open' and p.created_at > $2 order by p.created_at desc limit 3000", [userId, new Date(Date.now() - (days || 29) * DAY).toISOString()]);
  return issuesOf(userId, rows);
};
const numbersFor = async (user) => { const issues = await recentIssues(user.id); const custom = await loadCustom(user); return compute.withCustom(custom, () => numbers(issues, user.tz, Date.now())); };
const limitOf = (user) => Number(user.daily_limit) || 0;

// After a new purchase: push an alert if needed and return a short line for the Shortcut to show.
const afterPurchase = async (user, purchaseId) => {
  const n = await numbersFor(user);
  const msg = notes.alertFor(n, purchaseId, limitOf(user));
  const message = notes.quickLine(n, limitOf(user));
  if (msg) {
    try { await pushTo(user.id, msg); } catch (e) { console.error('alert push failed:', e && e.message); }
  }
  return { message, alert: msg ? msg.title : null };
};

// The person a Shortcut belongs to, from the setup code it sends instead of a sign-in.
const userFromCode = async (req, b) => {
  const given = bearer(req) || String(req.headers['x-setup-code'] || '') || String((b && (b.code || b.setupCode)) || '');
  if (!/^sp_[A-Za-z0-9_-]{20,}$/.test(given)) fail(401, 'This Shortcut needs your setup code from the app');
  const rows = await q('select * from users where key_hash = $1', [sha(given)]);
  const u = rows[0];
  if (!u) fail(401, 'That setup code is not valid any more. Copy the new one from the app.');
  if (u.disabled) fail(401, 'This account no longer has access.');
  req._who = String(u.id).slice(0, 8);
  return u;
};

// What this person decided about a product the last times they saved a bill with it, so the next scan starts there.
const itemMemory = async (userId) => {
  const rows = await q("select name, kind from bill_items where user_id = $1 and kind in ('need', 'fun') order by id desc limit 400", [userId]);
  const tally = {};
  rows.forEach((r) => {
    try {
      const k = bills.itemKey(vault.open(userId, 'item', r.name));
      if (!k) return;
      const t = tally[k] || (tally[k] = { need: 0, fun: 0 });
      t[r.kind] += 1;
    } catch (e) { /* an unreadable row is just skipped */ }
  });
  const out = {};
  Object.keys(tally).forEach((k) => { if (tally[k].need !== tally[k].fun) out[k] = tally[k].need > tally[k].fun ? 'need' : 'fun'; });
  return out;
};

// ---- pay plan storage and numbers ------------------------------------------------------------------------------
const todayOf = (u) => compute.inZone(u.tz, () => {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
});
const loadPlan = async (u) => {
  const r = (await q('select data from pay_plans where user_id = $1', [u.id]))[0];
  // Fixed bills are not part of Free to spend any more (it was confusing): whatever an older plan stored is ignored.
  return r ? { ...JSON.parse(vault.open(u.id, 'pay', r.data)), bills: [] } : null;    // a value that cannot be opened is an error, never "no plan"
};
const savePlan = (u, plan) => q(`insert into pay_plans (user_id, data) values ($1, $2)
  on conflict (user_id) do update set data = excluded.data, updated_at = now()`, [u.id, vault.seal(u.id, 'pay', JSON.stringify(plan))]);
// ---- a person's own categories ---------------------------------------------------------------------------------
// AI categories are for the people the owner has switched them on for (the owner always has them), and only while a Gemini key is set.
const aiAllowed = (u) => isOwner(u) || u.ai_access === true;    // the owner's per-person choice: store lookups AND bill photos
const aiOn = (u) => storeai.configured() && aiAllowed(u);
const billAiOn = (u) => vision.configured() && aiAllowed(u);
const loadGuesses = async (userId) => {
  const r = (await q('select data from user_ai where user_id = $1', [userId]))[0];
  return r ? JSON.parse(vault.open(userId, 'ai', r.data)) : {};
};
const loadCustom = async (u) => {
  const r = (await q('select data from user_cats where user_id = $1', [u.id]))[0];
  const base = r ? JSON.parse(vault.open(u.id, 'cats', r.data)) : { cats: [], rules: {} };
  base.learn = base.learn || { stores: {}, cats: {}, marks: 0 };       // what the person's marks have taught the app
  if (aiOn(u)) base.ai = await loadGuesses(u.id);
  return base;
};
// What the person's own marks (necessary / unnecessary) teach the app: counted again from all their marks each time one
// changes (a few hundred rows at most), so there is nothing to drift. Marks made before a "forget" are ignored.
const readCustomRow = async (u) => {
  const r = (await q('select data from user_cats where user_id = $1', [u.id]))[0];
  return r ? JSON.parse(vault.open(u.id, 'cats', r.data)) : { cats: [], rules: {} };
};
const writeCustomRow = (u, data) => q(`insert into user_cats (user_id, data) values ($1, $2)
  on conflict (user_id) do update set data = excluded.data, updated_at = now()`, [u.id, vault.seal(u.id, 'cats', JSON.stringify(data))]);
const rebuildLearn = async (u, resetNow) => {
  const data = await readCustomRow(u);
  const resetAt = resetNow ? new Date().toISOString() : (data.learn && data.learn.resetAt) || null;
  let model = { stores: {}, cats: {}, marks: 0 };
  if (!resetNow) {
    const marked = await q(`select p.id, p.title, p.body, p.state, p.kind, p.created_at from purchases p
      where p.user_id = $1 and p.state = 'open' and p.kind in ('need', 'fun')` + (resetAt ? ' and p.kind_at > $2' : '') + ' order by p.id desc limit 2000',
    resetAt ? [u.id, resetAt] : [u.id]);
    if (marked.length) {
      const issues = issuesOf(u.id, marked);
      const rows = compute.withCustom({ cats: data.cats || [], rules: data.rules || {} }, () => compute.summary(issues, [], u.tz, Date.now(), true, false)).rows || [];
      model = learn.build(rows.map((r) => ({ key: merchants.keyOf(r.merchant), category: r.category, mark: r.kind })));
    }
  }
  data.learn = { ...model, resetAt };
  await writeCustomRow(u, data);
  return data.learn;
};

const payState = async (u, plan) => {
  const today = todayOf(u);
  const back = Math.min(400, Math.max(3, payperiod.daysBetween(plan.start, today) + 3));
  const issues = await recentIssues(u.id, back);
  const custom = await loadCustom(u);
  const rows = (compute.withCustom(custom, () => compute.summary(issues, [], u.tz, Date.now(), true, false)).rows || []).map((r) => ({ day: r.day, amount: r.amount, category: r.category }));
  return { state: payperiod.stateOf(plan, rows, today), rows, today };
};

const addPurchase = async (user, title, body, createdAt) => {
  const today = await q("select count(*)::int as n from purchases where user_id = $1 and created_at > $2", [user.id, new Date(Date.now() - DAY).toISOString()]);
  if (today[0] && today[0].n >= 300) fail(429, 'Too many purchases today');
  const t = clean(title, 200);
  const b = String(body).slice(0, 2000);
  const rows = await q('insert into purchases (user_id, title, body, created_at) values ($1, $2, $3, $4) returning id, state, created_at', [user.id, vault.seal(user.id, 'title', t), vault.seal(user.id, 'body', b), createdAt]);
  return { ...rows[0], title: t, body: b };
};

const validDate = (v) => {
  const t = Date.parse(v);
  if (isNaN(t)) return new Date().toISOString();
  return new Date(Math.min(Math.max(t, Date.now() - 30 * DAY), Date.now() + 3600000)).toISOString();
};

// ---- routes -----------------------------------------------------------------------------------------------------
const routes = {
  'GET config': async () => ({ vapidPublicKey: env('VAPID_PUBLIC_KEY'), billScan: vision.configured() }),

  'POST auth/signup': async (req) => {
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '');
    const code = String(b.invite || '').trim();
    if (!(await signupsOpen())) fail(403, 'New accounts are closed right now.');
    if (await tooManyTries(req)) fail(429, 'Too many tries. Wait 15 minutes and try again.');
    // Mistakes in the email or password are reported before the invite is touched, so a typo never uses it up.
    if (!EMAIL_RE.test(email) || email.length > 254) fail(400, 'Enter a valid email address');
    if (password.length < 10) fail(400, 'Use a password of at least 10 characters');
    if (password.length > 200) fail(400, 'That password is too long');
    const badInvite = async (msg) => { await noteFailedTry(req); fail(403, msg); };
    if (!/^inv_[A-Za-z0-9_-]{16,64}$/.test(code)) await badInvite('Enter the invite code you were given.');
    if ((await q('select 1 from users where lower(email) = $1', [email])).length) fail(409, 'There is already an account with that email. Sign in instead.');
    // Claiming is one atomic step, so a code works for exactly one person even if two try at once.
    const claim = await q('update invites set used_at = now() where code_hash = $1 and used_at is null and revoked_at is null and expires_at > now() returning id', [sha(code)]);
    if (!claim[0]) await badInvite('That invite code is not valid. It may be already used, expired or cancelled.');
    let rows;
    try {
      rows = await q('insert into users (email, name, pw_hash) values ($1, $2, $3) returning *', [email, String(b.name || '').slice(0, 200), await hashPassword(password)]);
    } catch (e) {
      await q('update invites set used_at = null where id = $1', [claim[0].id]);
      if (e && e.code === '23505') fail(409, 'There is already an account with that email. Sign in instead.');
      throw e;
    }
    const user = rows[0];
    await q('update invites set used_by = $2 where id = $1', [claim[0].id, user.id]);
    return { session: await makeSession(user), email: user.email, name: user.name, isNew: true };
  },

  'POST auth/login': async (req) => {
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase();
    const password = String(b.password || '').slice(0, 200);
    const user = email ? (await q('select * from users where lower(email) = $1', [email]))[0] : null;
    if (user && user.locked_until && new Date(user.locked_until).getTime() > Date.now()) fail(429, 'Too many wrong passwords. Try again in 15 minutes.');
    const good = await checkPassword(password, user ? user.pw_hash : DUMMY_HASH);
    if (!user || !good) {
      if (user) {
        await q(`update users set fail_count = case when fail_count + 1 >= $2 then 0 else fail_count + 1 end,
                 locked_until = case when fail_count + 1 >= $2 then $3::timestamptz else null end where id = $1`,
        [user.id, MAX_TRIES, new Date(Date.now() + LOCK_MS).toISOString()]);
      }
      fail(401, 'That email and password do not match');
    }
    if (user.disabled) fail(403, 'This account no longer has access. Ask the person who invited you.');
    if (user.fail_count || user.locked_until) await q('update users set fail_count = 0, locked_until = null where id = $1', [user.id]);
    return { session: await makeSession(user), email: user.email, name: user.name, isNew: !user.key_hash };
  },

  // Set a new password with a one-time reset code from the owner. Signs out every other phone and signs this one in.
  'POST auth/reset': async (req) => {
    const b = await readBody(req);
    const email = String(b.email || '').trim().toLowerCase();
    const code = String(b.code || '').trim();
    const password = String(b.password || '');
    if (await tooManyTries(req)) fail(429, 'Too many tries. Wait 15 minutes and try again.');
    if (password.length < 10) fail(400, 'Use a password of at least 10 characters');
    if (password.length > 200) fail(400, 'That password is too long');
    const bad = async () => { await noteFailedTry(req); fail(403, 'That reset code is not valid or has expired. Ask the person who runs the app for a new one.'); };
    if (!email || !/^rst_[A-Za-z0-9_-]{16,64}$/.test(code)) await bad();
    const user = (await q('select * from users where lower(email) = $1', [email]))[0];
    const good = user && user.reset_hash && user.reset_expires && new Date(user.reset_expires).getTime() > Date.now()
      && crypto.timingSafeEqual(Buffer.from(sha(code)), Buffer.from(String(user.reset_hash)));
    if (!good) await bad();
    if (user.disabled) fail(403, 'This account no longer has access. Ask the person who invited you.');
    const rows = await q('update users set pw_hash = $2, reset_hash = null, reset_expires = null, fail_count = 0, locked_until = null, session_version = session_version + 1 where id = $1 and reset_hash = $3 returning *',
      [user.id, await hashPassword(password), user.reset_hash]);
    if (!rows[0]) await bad();
    return { session: await makeSession(rows[0]), email: rows[0].email, name: rows[0].name, isNew: !rows[0].key_hash };
  },

  // Change your own password. Every other phone is signed out; this one keeps going with a fresh session.
  'PUT me/password': async (req) => {
    const u = await signedIn(req);
    const b = await readBody(req);
    const current = String(b.current || '').slice(0, 200);
    const password = String(b.password || '');
    if (await tooManyTries(req)) fail(429, 'Too many tries. Wait 15 minutes and try again.');
    if (password.length < 10) fail(400, 'Use a password of at least 10 characters');
    if (password.length > 200) fail(400, 'That password is too long');
    if (!(await checkPassword(current, u.pw_hash))) { await noteFailedTry(req); fail(403, 'Your current password is not right'); }
    const rows = await q('update users set pw_hash = $2, reset_hash = null, reset_expires = null, session_version = session_version + 1 where id = $1 returning *', [u.id, await hashPassword(password)]);
    return { ok: true, session: await makeSession(rows[0]) };
  },

  'GET me': async (req) => {
    const u = await signedIn(req);
    const devices = await q('select count(*)::int as n from devices where user_id = $1', [u.id]);
    // The person's own categories ride along, so opening the app does not need a call just for them.
    return { email: u.email, name: u.name, isOwner: isOwner(u), dailyLimit: limitOf(u), tz: u.tz, hasCode: !!u.key_hash, devices: devices[0] ? devices[0].n : 0, vapidPublicKey: env('VAPID_PUBLIC_KEY'), categories: await loadCustom(u), ai: { enabled: aiOn(u), bills: billAiOn(u) } };
  },

  'PUT me': async (req) => {
    const u = await signedIn(req);
    const b = await readBody(req);
    if (b.tz !== undefined) {
      const tz = String(b.tz).slice(0, 64);
      try { new Intl.DateTimeFormat('en-CA', { timeZone: tz }); } catch (e) { fail(400, 'That time zone is not known'); }
      await q('update users set tz = $2 where id = $1', [u.id, tz]);
    }
    return { ok: true };
  },

  'PUT limit': async (req) => {
    const u = await signedIn(req);
    const b = await readBody(req);
    const v = Math.round(Number(b.dailyLimit) * 100) / 100;
    if (!(v >= 0) || v > 100000) fail(400, 'The limit must be between $0 and $100,000');
    await q('update users set daily_limit = $2 where id = $1', [u.id, v]);
    return { dailyLimit: v };
  },

  'GET setup-code': async (req) => {
    const u = await signedIn(req);
    if (u.key_enc) {
      try { return { code: unseal(u.key_enc) }; } catch (e) { /* make a new one below */ }
    }
    return { code: await newCode(u) };
  },

  'POST setup-code': async (req) => {
    const u = await signedIn(req);
    return { code: await newCode(u) };
  },

  'GET purchases': async (req) => {
    const u = await signedIn(req);
    return recentIssues(u.id);
  },

  // History: totals for a week, month, 3 months, year or all time, against the period before it. Computed with the app's own rules.
  'GET summary': async (req) => {
    const u = await signedIn(req);
    const params = new URL(req.url, 'http://x').searchParams;
    const range = String(params.get('range') || 'month');
    if (!compute.RANGES.includes(range)) fail(400, 'Choose week, month, 3m, year or all');
    const r = compute.rangeFor(range, params.get('anchor'), u.tz, Date.now());
    const fetchRows = async (from, to) => (from && to
      ? issuesOf(u.id, await q("select p.id, p.title, p.body, p.state, p.kind, p.created_at, b.n as b_n, b.need as b_need, b.fun as b_fun, b.unk as b_unk, exists(select 1 from bill_drafts d where d.purchase_id = p.id) as b_draft from purchases p left join (select purchase_id, count(*)::int as n, sum(alloc) filter (where kind = 'need') as need, sum(alloc) filter (where kind = 'fun') as fun, sum(alloc) filter (where kind = 'unk') as unk from bill_items where user_id = $1 group by purchase_id) b on b.purchase_id = p.id where p.user_id = $1 and p.state = 'open' and p.created_at >= $2 and p.created_at < $3 order by p.created_at desc limit 20000", [u.id, from, to]))
      : []);
    const [nowRows, prevRows] = await Promise.all([fetchRows(r.start, r.end), fetchRows(r.prevStart, r.prevEnd)]);
    const wantRows = params.get('rows') === '1' && (range === 'week' || range === 'month');
    const custom = await loadCustom(u);
    const s = compute.withCustom(custom, () => compute.summary(nowRows, prevRows, u.tz, Date.now(), wantRows, range === '3m' || range === 'year'));
    // This month's forecast, learned from the person's own history (time series once there are 3 weeks of it).
    let forecast = null;
    if (range === 'month' && r.inProgress) {
      try {
        const since = new Date(Date.now() - 120 * DAY).toISOString();
        const hist = issuesOf(u.id, await q("select p.id, p.title, p.body, p.state, p.kind, p.created_at, b.n as b_n, b.need as b_need, b.fun as b_fun, b.unk as b_unk, exists(select 1 from bill_drafts d where d.purchase_id = p.id) as b_draft from purchases p left join (select purchase_id, count(*)::int as n, sum(alloc) filter (where kind = 'need') as need, sum(alloc) filter (where kind = 'fun') as fun, sum(alloc) filter (where kind = 'unk') as unk from bill_items where user_id = $1 group by purchase_id) b on b.purchase_id = p.id where p.user_id = $1 and p.state = 'open' and p.created_at >= $2 order by p.created_at desc limit 20000", [u.id, since]));
        forecast = compute.withCustom(custom, () => compute.forecast(hist, u.tz, Date.now(), new Date(u.created_at).getTime()));
      } catch (e) { console.error('forecast failed:', e && e.message); }
    }
    return { range, forecast, startDay: r.startDay, endDay: r.endDay, today: r.today, limit: limitOf(u), title: r.title, prevLabel: r.prevLabel, inProgress: r.inProgress, days: r.days, prevAnchor: r.prevAnchor, nextAnchor: r.nextAnchor, ...s, perDay: Math.round((s.total / r.days) * 100) / 100 };
  },

  // The home screen's own timeline (7 / 30 / 365 days, always ending today, never navigated). 30 days and under come
  // back with a daily total for each day, so the app can draw bars; 365 days comes back as month totals instead,
  // since a year of individual purchases would be a slow, pointless download for a bar chart with 12 bars.
  // days=7, 30 or 365 gives one range. days=all gives all three from a single trip to the database, which is what the
  // app asks for: the database is far away, so three separate calls (each with its own connection) were the slow part.
  'GET trend': async (req) => {
    const u = await signedIn(req);
    const params = new URL(req.url, 'http://x').searchParams;
    const want = String(params.get('days'));
    const list = want === 'all' ? compute.TRAILING_DAYS : [Number(want)];
    if (list.some((d) => !compute.TRAILING_DAYS.includes(d))) fail(400, 'Choose 7, 30, 365 or all');
    const custom = await loadCustom(u);
    const widest = compute.trailingRange(Math.max(...list), u.tz, Date.now());
    const rows = issuesOf(u.id, await q("select p.id, p.title, p.body, p.state, p.kind, p.created_at, b.n as b_n, b.need as b_need, b.fun as b_fun, b.unk as b_unk, exists(select 1 from bill_drafts d where d.purchase_id = p.id) as b_draft from purchases p left join (select purchase_id, count(*)::int as n, sum(alloc) filter (where kind = 'need') as need, sum(alloc) filter (where kind = 'fun') as fun, sum(alloc) filter (where kind = 'unk') as unk from bill_items where user_id = $1 group by purchase_id) b on b.purchase_id = p.id where p.user_id = $1 and p.state = 'open' and p.created_at >= $2 and p.created_at < $3 order by p.created_at desc limit 20000", [u.id, widest.start, widest.end]));
    const one = (days) => {
      const r = compute.trailingRange(days, u.tz, Date.now());
      const mine = days === Math.max(...list) ? rows : rows.filter((x) => x.created_at >= r.start && x.created_at < r.end);
      const withDaily = days <= 30;
      const sm = compute.withCustom(custom, () => compute.summary(mine, [], u.tz, Date.now(), false, withDaily));
      return {
        days, total: sm.total, count: sm.count, perDay: Math.round((sm.total / days) * 100) / 100,
        daily: withDaily ? sm.daily : undefined,
        months: days === 365 ? sm.months.map((m) => ({ key: m.key, total: m.total })) : undefined,
        startDay: r.startDay, endDay: r.endDay, today: r.today, limit: limitOf(u)
      };
    };
    if (want !== 'all') return one(list[0]);
    return { ranges: { 7: one(7), 30: one(30), 365: one(365) } };
  },

  'POST purchases': async (req) => {
    const u = await signedIn(req);
    const b = await readBody(req);
    if (!b.title || !b.body) fail(400, 'A purchase needs a title and details');
    const row = await addPurchase(u, b.title, b.body, validDate(b.created_at));
    const after = await afterPurchase(u, row.id).catch(() => ({}));
    return { ...issueOf(row), message: after.message };
  },

  'GET purchases/:id': async (req, id) => {
    const u = await signedIn(req);
    const rows = await q('select id, title, body, state, kind, created_at from purchases where id = $1 and user_id = $2', [id, u.id]);
    if (!rows[0]) fail(404, 'That purchase was not found');
    return issuesOf(u.id, rows)[0];
  },

  'PATCH purchases/:id': async (req, id) => {
    const u = await signedIn(req);
    const b = await readBody(req);
    const rows = await q('select * from purchases where id = $1 and user_id = $2', [id, u.id]);
    if (!rows[0]) fail(404, 'That purchase was not found');
    const cur = vault.openRow(u.id, rows[0]);
    const title = b.title !== undefined ? clean(b.title, 200) : cur.title;
    const body = b.body !== undefined ? String(b.body).slice(0, 2000) : cur.body;
    const state = b.state === 'closed' || b.state === 'open' ? b.state : cur.state;
    // The person's own mark: 'need' (necessary), 'fun' (unnecessary), or empty to go back to the app's guess.
    if (b.kind !== undefined && !['need', 'fun', ''].includes(b.kind)) fail(400, 'A purchase can be marked need, fun, or cleared');
    const kind = b.kind !== undefined ? (b.kind || null) : (cur.kind || null);
    const changed = b.kind !== undefined && (kind || '') !== (cur.kind || '');
    const out = await q('update purchases set title = $3, body = $4, state = $5, kind = $6, kind_at = case when $7::boolean then now() else kind_at end, updated_at = now() where id = $1 and user_id = $2 returning id, state, kind, created_at', [id, u.id, vault.seal(u.id, 'title', title), vault.seal(u.id, 'body', body), state, kind, changed]);
    const issue = issueOf({ ...out[0], title, body });
    if (changed) { try { issue.learn = await rebuildLearn(u); } catch (e) { console.error('learning failed:', e && e.message); } }
    return issue;
  },

  // ---- reading a bill ----------------------------------------------------------------------------------------------
  // Sends one photo of a bill to the AI reader and returns the items it found, checked against the purchase. Nothing is
  // saved here, and the photo is never kept: the person reviews the items first and saves them with PUT .../items.
  'POST bills/scan': async (req) => {
    const u = await signedIn(req);
    if (!vision.configured()) fail(503, 'Bill scanning is not switched on yet. Ask the person who runs the app.');
    // A photo of a bill goes to an AI company, so it follows the same switch as everything else AI: only people the owner chose.
    if (!aiAllowed(u)) fail(403, 'AI bill scanning is not switched on for your account. Use the Shortcut, which reads the bill on your phone.');
    const b = await readBody(req, 4 * 1024 * 1024);
    const mime = String(b.mime || '');
    const image = String(b.image || '').replace(/^data:[^,]*,/, '');
    if (!/^image\/(jpeg|png|webp)$/.test(mime)) fail(400, 'Send the bill as a JPEG, PNG or WebP photo');
    if (image.length < 2000 || !/^[A-Za-z0-9+/=]+$/.test(image)) fail(400, 'That does not look like a photo');
    if (image.length > 3.2 * 1024 * 1024) fail(413, 'The photo is too large. Try again.');
    const limit = Math.max(1, Number(env('BILL_DAILY_LIMIT')) || 10);
    const used = await q('select count(*)::int as n from bill_scans where user_id = $1 and at > $2', [u.id, new Date(Date.now() - DAY).toISOString()]);
    if (used[0] && used[0].n >= limit) fail(429, 'That is ' + limit + ' bills today, the most for one day. Try again tomorrow.');
    await q('insert into bill_scans (user_id) values ($1)', [u.id]);
    await q('delete from bill_scans where at < $1', [new Date(Date.now() - 3 * DAY).toISOString()]);
    const store = clean(b.store, 60);
    const amount = bills.num(b.amount);
    let raw;
    try {
      raw = await vision.readBill({ image, mime, hint: { store, amount } });
    } catch (e) {
      console.error('bill read failed:', e && (e.detail || e.message));
      // The owner sees Google's own reason (a retired model, a bad key, no quota); everyone else a plain line.
      fail(502, isOwner(u) && e && e.detail ? 'The bill could not be read. ' + e.detail : 'The bill could not be read right now. Try again in a moment.');
    }
    if (raw && raw.error && !(raw.items && raw.items.length)) fail(422, 'That does not look like a bill. Take the photo again with the whole bill in view.');
    const out = bills.normalize(raw, { store, amount, memory: await itemMemory(u.id) });
    if (!out.items.length) fail(422, 'No items were found. Try again with the whole bill in view, flat and well lit.');
    return out;
  },

  // From the Apple Shortcut: the plain text the iPhone read off a bill. Rules turn it into items (no AI, nothing leaves the
  // server), the bill is matched to the purchase with the same total, and the result waits as a draft for the person to
  // check in the app. The Shortcut shows the returned message.
  'POST bills/text': async (req) => {
    const b = await readBody(req, 64 * 1024);
    const u = await userFromCode(req, b);
    const text = String(b.text || b.body || '').slice(0, 30000);
    const parsed = billtext.parse(text);
    if (!parsed.items.length || parsed.total === null) fail(422, 'No items were found on that bill. Take the photo again with the whole bill in view.');
    const n = await numbersFor(u);
    // When the app started the Shortcut it passes the purchase number, so the bill goes to exactly that purchase and the
    // total is not needed to find it. Only the person's own purchases count.
    const wanted = String(b.purchaseId === undefined ? (b.purchase === undefined ? '' : b.purchase) : b.purchaseId).trim();
    let target;
    req._billBy = wanted ? 'purchaseId' : 'total';
    if (wanted) {
      if (!/^\d{1,15}$/.test(wanted)) fail(400, 'That purchase number is not valid. Start the scan again from the purchase in the app.');
      target = n.spend.find((r) => String(r.id) === wanted);
      if (!target) fail(404, 'That purchase was not found. Open it in the app and scan again.');
    } else {
      const near = n.spend.filter((r) => r.amount > 0 && Math.abs(r.amount - parsed.total) <= 0.05).sort((a, c) => c.ts - a.ts);
      if (!near.length) fail(404, 'No purchase of ' + '$' + parsed.total.toFixed(2) + ' was found yet. Scan the bill again once the payment shows up in the app.');
      const have = await q('select purchase_id from bill_items where user_id = $1 and purchase_id = any($2::bigint[]) group by purchase_id', [u.id, near.map((r) => Number(r.id))]);
      const done = new Set(have.map((r) => String(r.purchase_id)));
      target = near.find((r) => !done.has(String(r.id))) || near[0];
    }
    const out = bills.normalize({ store: parsed.store, items: parsed.items.map((i) => ({ name: i.name, price: i.price, qty: i.qty, kind: itemkinds.kindOfItem(i.name) })), tax: parsed.tax, total: parsed.total },
      { store: target.merchant, amount: target.amount, memory: await itemMemory(u.id) });
    if (!out.items.length) fail(422, 'No items were found on that bill. Take the photo again with the whole bill in view.');
    const draft = { items: out.items.map((i) => ({ name: i.name, price: i.price, kind: i.kind })), tax: out.tax, total: out.total, matches: out.matches, diff: out.diff };
    await q('insert into bill_drafts (purchase_id, user_id, data) values ($1, $2, $3) on conflict (purchase_id) do update set data = excluded.data, created_at = now()',
      [Number(target.id), u.id, vault.seal(u.id, 'draft', JSON.stringify(draft))]);
    const price = draft.items.reduce((s, i) => s + i.price, 0);
    const funPart = price > 0 ? draft.items.filter((i) => i.kind === 'fun').reduce((s, i) => s + i.price, 0) / price * target.amount : 0;
    const msg = 'Found ' + draft.items.length + ' items for ' + target.merchant + '. ' + (funPart > 0.5 ? '$' + funPart.toFixed(2) + ' looks unnecessary. ' : '') + (draft.matches === false ? 'The total does not match exactly, so check it. ' : '') + 'Open the app to review them.';
    return { ok: true, message: msg, merchant: target.merchant, items: draft.items.length };
  },

  // ---- pay period: how much of the paycheck is left -----------------------------------------------------------------
  // The plan (paycheck, last payday, how often, fixed bills) is one small sealed value per person. The sums are done here
  // with the same file the tests check (public/payperiod.js), from the purchases since the last payday.
  'GET pay': async (req) => {
    const u = await signedIn(req);
    const plan = await loadPlan(u);
    if (!plan) return { plan: null, state: null };
    return { plan, state: (await payState(u, plan)).state };
  },

  'PUT pay': async (req) => {
    const u = await signedIn(req);
    const b = await readBody(req, 32 * 1024);
    const c = payperiod.clean({ ...b, bills: [] }, todayOf(u));
    if (c.error) fail(400, c.error);
    const old = await loadPlan(u);
    const plan = { ...c.plan, history: old ? old.history || [] : [] };
    await savePlan(u, plan);
    return { plan, state: (await payState(u, plan)).state };
  },

  // "Yes, I got paid": the finished period goes into the history and a new one starts on the day the person was paid.
  'POST pay/paid': async (req) => {
    const u = await signedIn(req);
    const b = await readBody(req, 4 * 1024);
    const plan = await loadPlan(u);
    if (!plan) fail(404, 'Set up your paycheck first');
    const today = todayOf(u);
    const date = b.date ? String(b.date) : today;
    if (!payperiod.parse(date)) fail(400, 'Choose the day you were paid');
    if (date > payperiod.addDays(today, 1)) fail(400, 'That day has not come yet');
    if (date <= plan.start) fail(400, 'A new period must start after ' + plan.start + ', the last payday you set');
    let amount;
    if (b.amount !== undefined && b.amount !== '') {
      amount = payperiod.money(b.amount, 1000000);
      if (amount === null || amount <= 0) fail(400, 'Enter what you got paid');
    }
    const { rows } = await payState(u, plan);
    const next = payperiod.rollOver(plan, rows, date, amount);
    await savePlan(u, next);
    return { plan: next, state: (await payState(u, next)).state };
  },

  'DELETE pay': async (req) => {
    const u = await signedIn(req);
    await q('delete from pay_plans where user_id = $1', [u.id]);
    return { ok: true };
  },

  // "Forget what you learned": the habits are cleared, and marks made before now are no longer counted. The marks themselves stay.
  'DELETE learn': async (req) => {
    const u = await signedIn(req);
    await rebuildLearn(u, true);
    return loadCustom(u);
  },

  // ---- AI categories: Gemini places the stores the rules cannot (only for people the owner switched it on for) -----------------
  // Only store names are sent, a few at a time. Each answer is remembered (sealed) so a store is asked about once.
  'POST ai/categorize': async (req) => {
    const u = await signedIn(req);
    if (!aiOn(u)) fail(403, 'AI categories are not switched on for your account');
    const b = await readBody(req, 8 * 1024);
    const names = Array.from(new Set((Array.isArray(b.stores) ? b.stores : []).map((x) => clean(x, 60)).filter(Boolean)));
    const have = await loadGuesses(u.id);
    let fresh = names.filter((n) => !(merchants.keyOf(n) in have) && !merchants.clean(n).category).slice(0, storeai.MAX_NAMES);
    if (!fresh.length) return { asked: 0 };
    // A daily allowance for each person and for the whole app, so a free key is never used up by one phone.
    const day = new Date().toISOString().slice(0, 10);
    const mine = Number(((await q('select n from ai_usage where user_id = $1 and day = $2', [u.id, day]))[0] || {}).n) || 0;
    const limit = Math.max(1, Number(env('AI_DAILY_LIMIT')) || 40);
    fresh = fresh.slice(0, Math.max(0, limit - mine));
    if (!fresh.length) fail(429, 'That is the most AI lookups for one day. Try again tomorrow.');
    const all = Number(((await q('select coalesce(sum(n), 0)::int as n from ai_usage where day = $1', [day]))[0] || {}).n) || 0;
    if (all + fresh.length > Math.max(1, Number(env('AI_GLOBAL_DAILY')) || 300)) fail(429, 'The AI helper is resting for today. Try again tomorrow.');
    await q('insert into ai_usage (user_id, day, n) values ($1, $2, $3) on conflict (user_id, day) do update set n = ai_usage.n + excluded.n', [u.id, day, fresh.length]);
    await q('delete from ai_usage where day < $1', [new Date(Date.now() - 4 * DAY).toISOString().slice(0, 10)]);
    let answer;
    try { answer = await storeai.categorize(fresh); } catch (e) {
      console.error('ai categorize failed:', e && (e.detail || e.message));
      // The owner sees Google's own reason (a wrong model name, a bad key, no quota) so it can be fixed; everyone else a plain line.
      fail(502, isOwner(u) && e && e.detail ? 'The AI helper could not answer. ' + e.detail : 'The AI helper could not answer right now. Try again later.');
    }
    fresh.forEach((n) => { have[merchants.keyOf(n)] = answer[n] || 'Other'; });
    const keys = Object.keys(have);
    if (keys.length > 2000) keys.slice(0, keys.length - 2000).forEach((k) => { delete have[k]; });
    await q(`insert into user_ai (user_id, data) values ($1, $2)
      on conflict (user_id) do update set data = excluded.data, updated_at = now()`, [u.id, vault.seal(u.id, 'ai', JSON.stringify(have))]);
    return { asked: fresh.length, guesses: have, answers: Object.fromEntries(fresh.map((n) => [n, answer[n] || 'Other'])) };
  },

  // ---- your own categories (Rent, Phone...) ------------------------------------------------------------------------
  'GET categories': async (req) => {
    const u = await signedIn(req);
    return loadCustom(u);
  },

  // The whole list is sent each time (it is small): add, change and delete are all one save.
  'PUT categories': async (req) => {
    const u = await signedIn(req);
    const b = await readBody(req, 32 * 1024);
    const c = customcats.clean(b);
    if (c.error) fail(400, c.error);
    const before = await readCustomRow(u);
    await writeCustomRow(u, { ...c.value, learn: before.learn });
    return loadCustom(u);
  },

  'GET purchases/:id/items': async (req, id) => {
    const u = await signedIn(req);
    const own = await q('select id from purchases where id = $1 and user_id = $2', [id, u.id]);
    if (!own[0]) fail(404, 'That purchase was not found');
    const rows = await q('select name, price, alloc, kind from bill_items where purchase_id = $1 and user_id = $2 order by pos', [id, u.id]);
    const d = await q('select data from bill_drafts where purchase_id = $1 and user_id = $2', [id, u.id]);
    let draft = null;
    if (d[0]) { try { draft = JSON.parse(vault.open(u.id, 'draft', d[0].data)); } catch (e) { draft = null; } }
    return { items: rows.map((r) => ({ name: vault.open(u.id, 'item', r.name), price: Number(r.price), alloc: Number(r.alloc), kind: r.kind })), draft };
  },

  // The items the person confirmed, replacing any earlier ones. The amount paid is shared out over them in one go.
  'PUT purchases/:id/items': async (req, id) => {
    const u = await signedIn(req);
    const b = await readBody(req, 128 * 1024);
    const own = await q('select id from purchases where id = $1 and user_id = $2', [id, u.id]);
    if (!own[0]) fail(404, 'That purchase was not found');
    const list = Array.isArray(b.items) ? b.items.slice(0, 120) : [];
    const items = list.map((it) => ({ name: clean(it && it.name, 80), price: bills.num(it && it.price), kind: it && (it.kind === 'need' || it.kind === 'fun') ? it.kind : 'unk' })).filter((it) => it.name && it.price !== null && Math.abs(it.price) <= 5000);
    const amount = bills.num(b.amount);
    if (!items.length) {
      await q('delete from bill_items where purchase_id = $1 and user_id = $2', [id, u.id]);
      await q('delete from bill_drafts where purchase_id = $1 and user_id = $2', [id, u.id]);
      return { ok: true, count: 0 };
    }
    if (!(amount > 0) || amount > 100000) fail(400, 'The amount paid is missing');
    const alloc = bills.allocate(items.map((i) => i.price), amount);
    // One statement: the old items go and the new ones arrive together, so a failure never leaves half a bill.
    await q(`with gone as (delete from bill_items where purchase_id = $1 and user_id = $2), draft as (delete from bill_drafts where purchase_id = $1 and user_id = $2)
             insert into bill_items (purchase_id, user_id, pos, name, price, alloc, kind)
             select $1, $2, t.pos, t.name, t.price, t.alloc, t.kind
             from unnest($3::int[], $4::text[], $5::numeric[], $6::numeric[], $7::text[]) as t(pos, name, price, alloc, kind)`,
    [id, u.id, items.map((_, i) => i), items.map((i) => vault.seal(u.id, 'item', i.name)), items.map((i) => i.price), alloc, items.map((i) => i.kind)]);
    return { ok: true, count: items.length };
  },

  'DELETE purchases/:id/items': async (req, id) => {
    const u = await signedIn(req);
    await q('delete from bill_items where purchase_id = $1 and user_id = $2', [id, u.id]);
    await q('delete from bill_drafts where purchase_id = $1 and user_id = $2', [id, u.id]);
    return { ok: true };
  },

  // The Shortcut sends each purchase here, with its setup code instead of a session.
  'POST log': async (req) => {
    const b = await readBody(req);
    const u = await userFromCode(req, b);
    const p = fromShortcut(b);
    const row = await addPurchase(u, p.title, p.body, new Date().toISOString());
    const after = await afterPurchase(u, row.id).catch(() => ({ message: 'Logged.' }));
    return { ok: true, id: Number(row.id), message: after.message, alert: after.alert || null };
  },

  'POST devices': async (req) => {
    const u = await signedIn(req);
    const b = await readBody(req);
    const s = b.subscription || {};
    let host = '';
    try { host = new URL(s.endpoint).hostname; } catch (e) { /* checked below */ }
    if (!String(s.endpoint || '').startsWith('https://') || !PUSH_HOSTS.some((re) => re.test(host))) fail(400, 'That is not a phone push address');
    if (!s.keys || !s.keys.p256dh || !s.keys.auth) fail(400, 'The push keys are missing');
    const d = { endpoint: String(s.endpoint).slice(0, 1000), p256dh: String(s.keys.p256dh).slice(0, 200), auth: String(s.keys.auth).slice(0, 200) };
    await q(`insert into devices (user_id, endpoint, p256dh, auth) values ($1, $2, $3, $4)
             on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`, [u.id, d.endpoint, d.p256dh, d.auth]);
    await pushTo(u.id, { title: 'Spending alerts are on', body: 'You will get a note each morning with what you can spend, an alert when you go over your limit, and a reminder each night at 9.' }, d);
    return { ok: true };
  },

  'DELETE devices': async (req) => {
    const u = await signedIn(req);
    const b = await readBody(req);
    await q('delete from devices where user_id = $1 and endpoint = $2', [u.id, String(b.endpoint || '')]);
    return { ok: true };
  },

  'POST devices/test': async (req) => {
    const u = await signedIn(req);
    return { sent: await pushTo(u.id, { title: 'Test alert', body: 'If you can read this, spending alerts are working.' }) };
  },

  'POST signout-all': async (req) => {
    const u = await signedIn(req);
    await q('update users set session_version = session_version + 1 where id = $1', [u.id]);
    return { ok: true };
  },

  'DELETE account': async (req) => {
    const u = await signedIn(req);
    await q('delete from users where id = $1', [u.id]);
    return { ok: true };
  },

  // The morning and evening notes. Vercel calls this on a schedule with the cron secret.
  'GET cron': async (req) => {
    if (!env('CRON_SECRET') || !secretIs(bearer(req), env('CRON_SECRET'))) fail(401, 'Not allowed');
    const users = await q('select u.* from users u where not u.disabled and exists (select 1 from devices d where d.user_id = u.id)');
    let sent = 0;
    for (const u of users) {
      try {
        const n = await numbersFor(u);
        const kind = n.hour >= 8 && n.hour <= 10 ? 'morning' : n.hour >= 21 && n.hour <= 23 ? 'evening' : '';
        if (!kind) continue;
        const fresh = await q('insert into notes_sent (user_id, kind, day) values ($1, $2, $3) on conflict do nothing returning day', [u.id, kind, n.today]);
        if (!fresh.length) continue;
        const m = kind === 'morning' ? notes.morningFor(n, limitOf(u)) : notes.eveningFor(n, limitOf(u));
        sent += await pushTo(u.id, m);
      } catch (e) {
        console.error('note failed for a user', e && e.message);
      }
    }
    await q("delete from notes_sent where day < $1", [new Date(Date.now() - 10 * DAY).toISOString().slice(0, 10)]);
    return { users: users.length, sent };
  },

  // ---- the saving game ----
  'GET game': async (req) => gameState(await signedIn(req)),

  'PUT game/goal': async (req) => {
    const u = await signedIn(req);
    const b = await readBody(req);
    const name = clean(b.name, 40);
    const emoji = String(b.emoji || '').slice(0, 8);
    const amount = Math.round(Number(b.amount) * 100) / 100;
    if (!name) fail(400, 'Give your goal a name, like "Japan trip"');
    if (!(amount >= 1) || amount > 1000000) fail(400, 'The goal must be between $1 and $1,000,000');
    await q(`insert into game (user_id, goal_name, goal_emoji, goal_amount) values ($1, $2, $3, $4)
             on conflict (user_id) do update set goal_name = excluded.goal_name, goal_emoji = excluded.goal_emoji, goal_amount = excluded.goal_amount`,
    [u.id, name, emoji, amount]);
    return gameState(u);
  },

  // Start over: forget the goal, every collected day and all XP. Purchases are never touched.
  'DELETE game': async (req) => {
    const u = await signedIn(req);
    await q('delete from game_days where user_id = $1', [u.id]);
    await q('delete from game where user_id = $1', [u.id]);
    return gameState(u);
  },

  'POST game/collect': async (req) => {
    const u = await signedIn(req);
    const before = await gameState(u);
    const days = [];
    for (const c of before.collectible) {
      const ins = await q('insert into game_days (user_id, day, saved, limit_at) values ($1, $2, $3, $4) on conflict do nothing returning day',
        [u.id, c.day, c.amount, before.limit]);
      if (ins.length) days.push(c);
    }
    const coins = r2(days.reduce((sum, c) => sum + c.amount, 0));
    const xpGain = days.reduce((sum, c) => sum + 10 + Math.floor(c.amount), 0);
    if (xpGain) await addXp(u, xpGain);
    const after = await gameState(u);
    return { ...after, gained: { days, coins, xp: xpGain, levelUp: after.level > before.level ? after.level : 0 } };
  },

  // "I moved it to my savings for real": a golden coin, worth 1 more XP per dollar.
  'POST game/real': async (req) => {
    const u = await signedIn(req);
    const b = await readBody(req);
    const want = (Array.isArray(b.days) ? b.days : []).map(String).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).slice(0, 10);
    const before = await gameState(u);
    const rows = want.length
      ? await q('update game_days set real = true where user_id = $1 and day = any($2::text[]) and real = false returning saved', [u.id, want])
      : [];
    const coins = r2(rows.reduce((sum, r) => sum + Number(r.saved), 0));
    const xpGain = rows.reduce((sum, r) => sum + Math.floor(Number(r.saved)), 0);
    if (xpGain) await addXp(u, xpGain);
    const after = await gameState(u);
    return { ...after, gained: { coins, xp: xpGain, levelUp: after.level > before.level ? after.level : 0 } };
  },

  // ---- owner: invites and who has access ----
  'GET owner/people': async (req) => {
    await ownerOnly(req);
    // Usage only, never what was bought: is the Shortcut connected, how many purchases, when the last one came, when the app was last opened.
    const people = await q(`select u.id, u.email, u.created_at, u.disabled, u.last_seen, u.ai_access, (u.key_hash is not null) as connected,
      (select count(*)::int from purchases p where p.user_id = u.id) as purchases,
      (select max(p.created_at) from purchases p where p.user_id = u.id) as last_purchase,
      (select count(*)::int from devices d where d.user_id = u.id) as devices
      from users u order by u.created_at`);
    const invites = await q("select id, note, created_at, expires_at from invites where used_at is null and revoked_at is null and expires_at > now() order by created_at desc limit 50");
    return {
      signupsOpen: await signupsOpen(),
      aiConfigured: storeai.configured(),
      people: people.map((p) => {
        const lastP = p.last_purchase ? new Date(p.last_purchase).getTime() : 0;
        const status = !p.connected ? 'not-connected' : !p.purchases ? 'waiting' : lastP > Date.now() - 7 * DAY ? 'active' : 'quiet';
        return { id: p.id, email: p.email, joined: iso(p.created_at), disabled: !!p.disabled, owner: String(p.email).toLowerCase() === ownerEmail(), ai: String(p.email).toLowerCase() === ownerEmail() || !!p.ai_access,
          usage: { status, connected: !!p.connected, purchases: p.purchases, lastPurchase: p.last_purchase ? iso(p.last_purchase) : null, lastSeen: p.last_seen ? iso(p.last_seen) : null, alerts: p.devices > 0 } };
      }),
      invites: invites.map((i) => ({ id: Number(i.id), note: i.note, created_at: iso(i.created_at), expires_at: iso(i.expires_at) }))
    };
  },

  'POST owner/invites': async (req) => {
    await ownerOnly(req);
    const b = await readBody(req);
    return makeInvite(b.note, b.days);
  },

  'DELETE owner/invites/:id': async (req, id) => {
    await ownerOnly(req);
    await q('update invites set revoked_at = now() where id = $1 and used_at is null', [id]);
    return { ok: true };
  },

  'PUT owner/signups': async (req) => {
    await ownerOnly(req);
    const b = await readBody(req);
    const open = b.open === true || b.open === 'true';
    await q("insert into app_settings (key, value) values ('signups_open', $1) on conflict (key) do update set value = excluded.value", [open ? 'true' : 'false']);
    return { signupsOpen: open };
  },

  // Removing access signs the person out everywhere and blocks their login and Shortcut. Their data is kept, so it can be restored.
  'POST owner/people/:id/:action': async (req, arg) => {
    const me = await ownerOnly(req);
    const rows = await q('select id, email from users where id = $1', [arg.id]);
    if (!rows[0]) fail(404, 'That person was not found');
    // The owner decides who gets AI categories. The owner always has them.
    if (arg.action === 'ai-on' || arg.action === 'ai-off') {
      if (String(rows[0].email).toLowerCase() === ownerEmail()) fail(400, 'You always have AI categories');
      await q('update users set ai_access = $2 where id = $1', [arg.id, arg.action === 'ai-on']);
      return { ok: true, ai: arg.action === 'ai-on' };
    }
    if (arg.action !== 'reset') {
      if (arg.id === me.id) fail(400, 'You cannot remove your own access');
      if (String(rows[0].email).toLowerCase() === ownerEmail()) fail(400, 'The owner cannot be removed');
    }
    if (arg.action === 'reset') {
      if (arg.id === me.id) fail(400, 'Use Change password in Settings for your own account');
      return { ...(await makeReset(arg.id)), email: rows[0].email };
    }
    const off = arg.action === 'remove';
    await q('update users set disabled = $2, session_version = session_version + 1 where id = $1', [arg.id, off]);
    return { ok: true, disabled: off };
  },

  // For the owner of the server, with the admin secret: a reset code for anyone, including the owner if they are locked out.
  'POST admin/reset': async (req) => {
    if (!env('ADMIN_SECRET') || !secretIs(bearer(req), env('ADMIN_SECRET'))) fail(401, 'Not allowed');
    const b = await readBody(req);
    const u = (await q('select id, email from users where lower(email) = $1', [String(b.email || '').trim().toLowerCase()]))[0];
    if (!u) fail(404, 'No account with that email');
    return { ...(await makeReset(u.id)), email: u.email };
  },

  // For the owner of the server, with the admin secret: make an invite without signing in (also used to start a new install).
  'POST admin/invites': async (req) => {
    if (!env('ADMIN_SECRET') || !secretIs(bearer(req), env('ADMIN_SECRET'))) fail(401, 'Not allowed');
    const b = await readBody(req);
    return makeInvite(b.note, b.days);
  },

  // One-time move of existing purchases into an account, by the owner of this server.
  'POST admin/import': async (req) => {
    if (!env('ADMIN_SECRET') || !secretIs(bearer(req), env('ADMIN_SECRET'))) fail(401, 'Not allowed');
    const b = await readBody(req, 512 * 1024);
    const users = await q('select * from users where lower(email) = lower($1)', [String(b.email || '')]);
    if (!users[0]) fail(404, 'No account with that email has been created yet');
    let added = 0;
    for (const i of (Array.isArray(b.issues) ? b.issues : []).slice(0, 2000)) {
      if (!i.title || !i.body) continue;
      await q('insert into purchases (user_id, title, body, state, created_at) values ($1, $2, $3, $4, $5)', [users[0].id, vault.seal(users[0].id, 'title', clean(i.title, 200)), vault.seal(users[0].id, 'body', String(i.body).slice(0, 2000)), i.state === 'closed' ? 'closed' : 'open', isNaN(Date.parse(i.created_at)) ? new Date().toISOString() : i.created_at]);
      added++;
    }
    if (b.dailyLimit !== undefined) await q('update users set daily_limit = $2 where id = $1', [users[0].id, Number(b.dailyLimit) || 0]);
    return { added };
  }
};
routes['POST cron'] = routes['GET cron'];

const handler = async (req, res) => {
  let routeKey = '';
  try {
    const url = new URL(req.url, 'http://x');
    let route = url.searchParams.get('route');
    if (route === null) route = url.pathname.replace(/^\/api\/?/, '');
    route = route.replace(/^\/+|\/+$/g, '');
    let key = req.method + ' ' + route;
    routeKey = key;
    let arg;
    const m = /^purchases\/(\d{1,18})$/.exec(route);
    const mb = /^purchases\/(\d{1,18})\/items$/.exec(route);
    const mi = /^owner\/invites\/(\d{1,18})$/.exec(route);
    const mp = /^owner\/people\/([0-9a-f-]{36})\/(remove|restore|reset|ai-on|ai-off)$/.exec(route);
    if (m) {
      key = req.method + ' purchases/:id';
      arg = m[1];
    } else if (mb) {
      key = req.method + ' purchases/:id/items';
      arg = mb[1];
    } else if (mi) {
      key = req.method + ' owner/invites/:id';
      arg = mi[1];
    } else if (mp) {
      key = req.method + ' owner/people/:id/:action';
      arg = { id: mp[1], action: mp[2] };
    }
    const fn = routes[key];
    if (!fn) return send(res, 404, { error: 'Not found' });
    const out = await fn(req, arg);
    if (key === 'POST log') console.log(JSON.stringify({ evt: 'shortcut-log', status: 200, who: req._who || '' }));
    if (key === 'POST bills/text') console.log(JSON.stringify({ evt: 'shortcut-bill', status: 200, who: req._who || '', items: out && out.items, by: req._billBy || '' }));
    return send(res, 200, out);
  } catch (e) {
    if (e instanceof HttpError) {
      // Shortcut requests are logged (no purchase details, no setup code) so a missing purchase can be traced.
      if (routeKey === 'POST bills/text') console.log(JSON.stringify({ evt: 'shortcut-bill', status: e.status, reason: e.message, who: req._who || '' }));
      if (req.method === 'POST' && /\/log\/?$|route=log\b/.test(String(req.url))) console.log(JSON.stringify({ evt: 'shortcut-log', status: e.status, reason: e.message, who: req._who || '' }));
      // A Shortcut shows the field called message, so for its routes the reason goes there too.
      return send(res, e.status, routeKey === 'POST log' || routeKey === 'POST bills/text' ? { error: e.message, message: e.message } : { error: e.message });
    }
    console.error(e);
    return send(res, 500, { error: 'Something went wrong on the server. Try again.' });
  }
};

module.exports = handler;
module.exports._test = {
  setPushSender: (fn) => { pushSender = fn; },
  setBillReader: (fn) => vision.setReader(fn),
  setCategorizer: (fn) => storeai.setCategorizer(fn),
  fromShortcut
};
