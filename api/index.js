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
const issueOf = (r) => ({ number: Number(r.id), title: r.title, body: r.body, state: r.state, created_at: iso(r.created_at) });
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
  const isWallet = /wallet|notification/i.test(String(pick(o, 'source', 'type'))) || (!pick(o, 'merchant', 'amount') && (wTitle || wSub || wBody));
  if (isWallet) {
    if (!(wTitle || wSub || wBody)) fail(400, 'The Wallet alert had no text');
    return {
      title: 'Spending - wallet alert',
      body: ['Source: wallet-notification', 'Date: ' + date, 'Title: ' + clean(wTitle), 'Subtitle: ' + clean(wSub), 'Body: ' + clean(wBody, 300)].join('\n')
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
const recentIssues = async (userId) => {
  const rows = await q("select id, title, body, state, created_at from purchases where user_id = $1 and state = 'open' and created_at > $2 order by created_at desc limit 3000", [userId, new Date(Date.now() - 29 * DAY).toISOString()]);
  return rows.map(issueOf);
};
const numbersFor = async (user) => numbers(await recentIssues(user.id), user.tz, Date.now());
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

const addPurchase = async (user, title, body, createdAt) => {
  const today = await q("select count(*)::int as n from purchases where user_id = $1 and created_at > $2", [user.id, new Date(Date.now() - DAY).toISOString()]);
  if (today[0] && today[0].n >= 300) fail(429, 'Too many purchases today');
  const rows = await q('insert into purchases (user_id, title, body, created_at) values ($1, $2, $3, $4) returning id, title, body, state, created_at', [user.id, clean(title, 200), String(body).slice(0, 2000), createdAt]);
  return rows[0];
};

const validDate = (v) => {
  const t = Date.parse(v);
  if (isNaN(t)) return new Date().toISOString();
  return new Date(Math.min(Math.max(t, Date.now() - 30 * DAY), Date.now() + 3600000)).toISOString();
};

// ---- routes -----------------------------------------------------------------------------------------------------
const routes = {
  'GET config': async () => ({ vapidPublicKey: env('VAPID_PUBLIC_KEY') }),

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
    return { email: u.email, name: u.name, isOwner: isOwner(u), dailyLimit: limitOf(u), tz: u.tz, hasCode: !!u.key_hash, devices: devices[0] ? devices[0].n : 0, vapidPublicKey: env('VAPID_PUBLIC_KEY') };
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
      ? (await q("select id, title, body, state, created_at from purchases where user_id = $1 and state = 'open' and created_at >= $2 and created_at < $3 order by created_at desc limit 20000", [u.id, from, to])).map(issueOf)
      : []);
    const [nowRows, prevRows] = await Promise.all([fetchRows(r.start, r.end), fetchRows(r.prevStart, r.prevEnd)]);
    const wantRows = params.get('rows') === '1' && (range === 'week' || range === 'month');
    const s = compute.summary(nowRows, prevRows, u.tz, Date.now(), wantRows);
    return { range, startDay: r.startDay, endDay: r.endDay, today: r.today, limit: limitOf(u), title: r.title, prevLabel: r.prevLabel, inProgress: r.inProgress, days: r.days, prevAnchor: r.prevAnchor, nextAnchor: r.nextAnchor, ...s, perDay: Math.round((s.total / r.days) * 100) / 100 };
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
    const rows = await q('select id, title, body, state, created_at from purchases where id = $1 and user_id = $2', [id, u.id]);
    if (!rows[0]) fail(404, 'That purchase was not found');
    return issueOf(rows[0]);
  },

  'PATCH purchases/:id': async (req, id) => {
    const u = await signedIn(req);
    const b = await readBody(req);
    const rows = await q('select * from purchases where id = $1 and user_id = $2', [id, u.id]);
    if (!rows[0]) fail(404, 'That purchase was not found');
    const cur = rows[0];
    const title = b.title !== undefined ? clean(b.title, 200) : cur.title;
    const body = b.body !== undefined ? String(b.body).slice(0, 2000) : cur.body;
    const state = b.state === 'closed' || b.state === 'open' ? b.state : cur.state;
    const out = await q('update purchases set title = $3, body = $4, state = $5, updated_at = now() where id = $1 and user_id = $2 returning id, title, body, state, created_at', [id, u.id, title, body, state]);
    return issueOf(out[0]);
  },

  // The Shortcut sends each purchase here, with its setup code instead of a session.
  'POST log': async (req) => {
    const code = bearer(req) || String(req.headers['x-setup-code'] || '');
    const b = await readBody(req);
    const given = code || String(b.code || b.setupCode || '');
    if (!/^sp_[A-Za-z0-9_-]{20,}$/.test(given)) fail(401, 'This Shortcut needs your setup code from the app');
    const rows = await q('select * from users where key_hash = $1', [sha(given)]);
    const u = rows[0];
    if (!u) fail(401, 'That setup code is not valid any more. Copy the new one from the app.');
    if (u.disabled) fail(401, 'This account no longer has access.');
    req._who = String(u.id).slice(0, 8);
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
    if (!env('CRON_SECRET') || bearer(req) !== env('CRON_SECRET')) fail(401, 'Not allowed');
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
    const people = await q(`select u.id, u.email, u.created_at, u.disabled, u.last_seen, (u.key_hash is not null) as connected,
      (select count(*)::int from purchases p where p.user_id = u.id) as purchases,
      (select max(p.created_at) from purchases p where p.user_id = u.id) as last_purchase,
      (select count(*)::int from devices d where d.user_id = u.id) as devices
      from users u order by u.created_at`);
    const invites = await q("select id, note, created_at, expires_at from invites where used_at is null and revoked_at is null and expires_at > now() order by created_at desc limit 50");
    return {
      signupsOpen: await signupsOpen(),
      people: people.map((p) => {
        const lastP = p.last_purchase ? new Date(p.last_purchase).getTime() : 0;
        const status = !p.connected ? 'not-connected' : !p.purchases ? 'waiting' : lastP > Date.now() - 7 * DAY ? 'active' : 'quiet';
        return { id: p.id, email: p.email, joined: iso(p.created_at), disabled: !!p.disabled, owner: String(p.email).toLowerCase() === ownerEmail(),
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
    if (!env('ADMIN_SECRET') || bearer(req) !== env('ADMIN_SECRET')) fail(401, 'Not allowed');
    const b = await readBody(req);
    const u = (await q('select id, email from users where lower(email) = $1', [String(b.email || '').trim().toLowerCase()]))[0];
    if (!u) fail(404, 'No account with that email');
    return { ...(await makeReset(u.id)), email: u.email };
  },

  // For the owner of the server, with the admin secret: make an invite without signing in (also used to start a new install).
  'POST admin/invites': async (req) => {
    if (!env('ADMIN_SECRET') || bearer(req) !== env('ADMIN_SECRET')) fail(401, 'Not allowed');
    const b = await readBody(req);
    return makeInvite(b.note, b.days);
  },

  // One-time move of existing purchases into an account, by the owner of this server.
  'POST admin/import': async (req) => {
    if (!env('ADMIN_SECRET') || bearer(req) !== env('ADMIN_SECRET')) fail(401, 'Not allowed');
    const b = await readBody(req, 512 * 1024);
    const users = await q('select * from users where lower(email) = lower($1)', [String(b.email || '')]);
    if (!users[0]) fail(404, 'No account with that email has been created yet');
    let added = 0;
    for (const i of (Array.isArray(b.issues) ? b.issues : []).slice(0, 2000)) {
      if (!i.title || !i.body) continue;
      await q('insert into purchases (user_id, title, body, state, created_at) values ($1, $2, $3, $4, $5)', [users[0].id, clean(i.title, 200), String(i.body).slice(0, 2000), i.state === 'closed' ? 'closed' : 'open', isNaN(Date.parse(i.created_at)) ? new Date().toISOString() : i.created_at]);
      added++;
    }
    if (b.dailyLimit !== undefined) await q('update users set daily_limit = $2 where id = $1', [users[0].id, Number(b.dailyLimit) || 0]);
    return { added };
  }
};
routes['POST cron'] = routes['GET cron'];

const handler = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let route = url.searchParams.get('route');
    if (route === null) route = url.pathname.replace(/^\/api\/?/, '');
    route = route.replace(/^\/+|\/+$/g, '');
    let key = req.method + ' ' + route;
    let arg;
    const m = /^purchases\/(\d{1,18})$/.exec(route);
    const mi = /^owner\/invites\/(\d{1,18})$/.exec(route);
    const mp = /^owner\/people\/([0-9a-f-]{36})\/(remove|restore|reset)$/.exec(route);
    if (m) {
      key = req.method + ' purchases/:id';
      arg = m[1];
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
    return send(res, 200, out);
  } catch (e) {
    if (e instanceof HttpError) {
      // Shortcut requests are logged (no purchase details, no setup code) so a missing purchase can be traced.
      if (req.method === 'POST' && /\/log\/?$|route=log\b/.test(String(req.url))) console.log(JSON.stringify({ evt: 'shortcut-log', status: e.status, reason: e.message, who: req._who || '' }));
      return send(res, e.status, { error: e.message });
    }
    console.error(e);
    return send(res, 500, { error: 'Something went wrong on the server. Try again.' });
  }
};

module.exports = handler;
module.exports._test = {
  setPushSender: (fn) => { pushSender = fn; },
  fromShortcut
};
