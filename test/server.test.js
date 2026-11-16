// End-to-end tests of the server against an in-memory Postgres. Run: TZ=UTC node test/server.test.js
'use strict';
const assert = require('assert');

(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const db = require('../lib/db');
  db.setTestDb(async (t, p) => (await pg.query(t, p)).rows);

  process.env.SESSION_SECRET = 'test-secret-'.repeat(4);
  process.env.DATA_KEY = 'test-data-key-'.repeat(4);
  process.env.CRON_SECRET = 'cron-secret';
  process.env.ADMIN_SECRET = 'admin-secret';
  process.env.OWNER_EMAIL = 'ana@example.com';
  const wp = require('web-push').generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = wp.publicKey;
  process.env.VAPID_PRIVATE_KEY = wp.privateKey;

  const api = require('../api/index.js');
  const pushes = [];
  api._test.setPushSender(async (sub, payload) => {
    if (sub.endpoint.endsWith('/gone')) { const e = new Error('gone'); e.statusCode = 410; throw e; }
    pushes.push({ to: sub.endpoint, ...JSON.parse(payload) });
  });
  const call = (method, route, { body, auth, headers } = {}) => new Promise((resolve) => {
    const req = { method, url: '/api/index?route=' + encodeURIComponent(route), headers: { ...(headers || {}) }, body };
    if (auth) req.headers.authorization = 'Bearer ' + auth;
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s) { resolve({ status: this.statusCode, data: JSON.parse(s) }); } };
    api(req, res);
  });
  const invite = async (note, days) => (await call('POST', 'admin/invites', { auth: 'admin-secret', body: { note, days } })).data.code;
  let pass = 0;
  const ok = (cond, label) => { assert.ok(cond, label); pass++; console.log('  ok', label); };

  // config + sign-up + sign-in
  let r = await call('GET', 'config');
  ok(r.status === 200 && r.data.vapidPublicKey === process.env.VAPID_PUBLIC_KEY && !('googleClientId' in r.data), 'config has no Google client id');
  // signup needs an invite
  r = await call('POST', 'auth/signup', { body: { email: 'ana@example.com', password: 'ana-password-1' } });
  ok(r.status === 403 && !r.data.session, 'signup without an invite is refused');
  r = await call('POST', 'auth/signup', { body: { email: 'ana@example.com', password: 'ana-password-1', invite: 'inv_notarealcodenotarealcode' } });
  ok(r.status === 403, 'a made-up invite is refused');
  r = await call('POST', 'admin/invites', { body: {} });
  ok(r.status === 401, 'only the admin secret makes an invite without signing in');
  const invAna = await invite('Ana', 7);
  ok(/^inv_[A-Za-z0-9_-]{20,}$/.test(invAna), 'invite code made');
  r = await call('POST', 'auth/signup', { body: { email: 'not-an-email', password: 'longenough-pw', invite: invAna } });
  ok(r.status === 400, 'bad email refused');
  r = await call('POST', 'auth/signup', { body: { email: 'ana@example.com', password: 'short', invite: invAna } });
  ok(r.status === 400, 'short password refused');
  const unused = await pg.query("select count(*)::int as n from invites where used_at is null");
  ok(unused.rows[0].n === 1, 'typos did not use the invite up');
  r = await call('POST', 'auth/signup', { body: { email: 'Ana@Example.com', password: 'ana-password-1', invite: invAna } });
  ok(r.status === 200 && r.data.session && r.data.isNew === true && r.data.email === 'ana@example.com', 'Ana signs up and gets a session');
  const ana = r.data.session;
  r = await call('POST', 'auth/signup', { body: { email: 'bo2@example.com', password: 'bo-password-1', invite: invAna } });
  ok(r.status === 403, 'an invite works only once');
  r = await call('POST', 'auth/signup', { body: { email: 'ANA@example.com', password: 'another-password', invite: await invite('dup', 7) } });
  ok(r.status === 409, 'same email cannot sign up twice');
  const unusedAfter = await pg.query("select count(*)::int as n from invites where used_at is null");
  ok(unusedAfter.rows[0].n === 1, 'a refused duplicate email did not use up its invite');
  r = await call('POST', 'auth/signup', { body: { email: 'bo@example.com', password: 'bo-password-1', invite: await invite('Bo', 7) } });
  const bo = r.data.session;
  const stored = await pg.query("select pw_hash from users where email = 'ana@example.com'");
  ok(/^s1\$/.test(stored.rows[0].pw_hash) && !stored.rows[0].pw_hash.includes('ana-password-1'), 'password stored only as a hash');
  r = await call('POST', 'auth/login', { body: { email: 'ana@example.com', password: 'wrong-password' } });
  ok(r.status === 401 && !r.data.session, 'wrong password refused');
  r = await call('POST', 'auth/login', { body: { email: 'nobody@example.com', password: 'whatever-password' } });
  ok(r.status === 401, 'unknown email refused the same way');
  r = await call('POST', 'auth/login', { body: { email: 'ANA@example.com', password: 'ana-password-1' } });
  ok(r.status === 200 && r.data.session && r.data.isNew === true, 'Ana signs in (email not case sensitive)');
  r = await call('POST', 'auth/google', { body: { credential: 'x' } });
  ok(r.status === 404, 'Google sign-in is gone');
  r = await call('GET', 'me');
  ok(r.status === 401, 'no session -> 401');
  r = await call('GET', 'me', { auth: ana + 'x' });
  ok(r.status === 401, 'tampered session -> 401');
  r = await call('GET', 'me', { auth: ana });
  ok(r.status === 200 && r.data.email === 'ana@example.com' && r.data.hasCode === false && r.data.dailyLimit === 0, 'me works');

  // setup code + Shortcut log
  r = await call('GET', 'setup-code', { auth: ana });
  const code = r.data.code;
  ok(/^sp_/.test(code), 'setup code made');
  r = await call('GET', 'setup-code', { auth: ana });
  ok(r.data.code === code, 'same setup code shown again');
  r = await call('POST', 'log', { auth: 'sp_wrongwrongwrongwrongwrong', body: { merchant: 'X', amount: '5' } });
  ok(r.status === 401, 'wrong setup code refused');
  r = await call('POST', 'log', { auth: code, body: {} });
  ok(r.status === 400, 'empty Shortcut body refused');
  r = await call('POST', 'log', { auth: code, body: { Merchant: 'Tim Hortons', Amount: '12.40', Card: 'Visa', Category: 'Dining & Coffee' } });
  ok(r.status === 200 && r.data.ok && /\$12\.40 spent today/.test(r.data.message), 'tap purchase logged: ' + r.data.message);
  r = await call('POST', 'log', { auth: code, body: { source: 'wallet', title: 'Visa', subtitle: 'TIM HORTONS #1234', body: '$12.40' } });
  ok(r.status === 200 && /\$12\.40 spent today/.test(r.data.message), 'Wallet duplicate counted once: ' + r.data.message);
  r = await call('POST', 'log', { headers: { 'x-setup-code': code }, body: JSON.stringify({ merchant: 'Metro\nCategory: Hack', amount: 30 }) });
  ok(r.status === 200 && /\$42\.40/.test(r.data.message), 'code in header, text body, newline injection flattened');

  // purchases are private to each person
  r = await call('GET', 'purchases', { auth: ana });
  ok(r.data.length === 3 && r.data.every((i) => i.state === 'open'), 'Ana sees her 3 purchases');
  const metro = r.data.find((i) => /Metro/.test(i.body));
  ok(!/\nCategory: Hack/.test(metro.body) && /Merchant: Metro Category: Hack/.test(metro.body), 'injected line stayed inside the merchant');
  r = await call('GET', 'purchases', { auth: bo });
  ok(r.data.length === 0, 'Bo sees none of Ana\'s purchases');
  r = await call('PATCH', 'purchases/' + metro.number, { auth: bo, body: { state: 'closed' } });
  ok(r.status === 404, 'Bo cannot change Ana\'s purchase');
  r = await call('GET', 'purchases/' + metro.number, { auth: bo });
  ok(r.status === 404, 'Bo cannot read Ana\'s purchase');

  // limit + alerts
  r = await call('PUT', 'limit', { auth: ana, body: { dailyLimit: -3 } });
  ok(r.status === 400, 'negative limit refused');
  r = await call('PUT', 'limit', { auth: ana, body: { dailyLimit: 40 } });
  ok(r.data.dailyLimit === 40, 'limit saved');
  r = await call('POST', 'devices', { auth: ana, body: { subscription: { endpoint: 'https://evil.example.com/x', keys: { p256dh: 'a', auth: 'b' } } } });
  ok(r.status === 400, 'non-push device address refused');
  pushes.length = 0;
  r = await call('POST', 'devices', { auth: ana, body: { subscription: { endpoint: 'https://web.push.apple.com/ana1', keys: { p256dh: 'p', auth: 'a' } } } });
  ok(r.status === 200 && pushes.length === 1 && pushes[0].title === 'Spending alerts are on', 'device saved and welcomed');
  await call('POST', 'devices', { auth: ana, body: { subscription: { endpoint: 'https://web.push.apple.com/gone', keys: { p256dh: 'p', auth: 'a' } } } });
  pushes.length = 0;
  r = await call('POST', 'purchases', { auth: ana, body: { title: 'Spending - $5.00', body: 'Date: ' + new Date().toISOString() + '\nMerchant: Uber Eats\nAmount: $5.00\nCard: Added by hand\nCategory: Dining & Coffee\nEntry: manual' } });
  ok(r.status === 200 && pushes.length === 1 && /over your daily limit/i.test(pushes[0].title), 'manual add over the limit alerts: ' + (pushes[0] && pushes[0].body));
  const devs = await pg.query('select endpoint from devices');
  ok(devs.rows.length === 1, 'dead device removed after a failed push');
  r = await call('PATCH', 'purchases/' + r.data.number, { auth: ana, body: { state: 'closed' } });
  ok(r.data.state === 'closed', 'delete (close) works');
  r = await call('GET', 'purchases', { auth: ana });
  ok(r.data.length === 3, 'closed purchase hidden');

  // timed notes
  r = await call('GET', 'cron');
  ok(r.status === 401, 'cron needs its secret');
  r = await call('GET', 'cron', { auth: 'cron-secret' });
  ok(r.status === 200 && r.data.users === 1, 'cron runs for people with alerts on (sent ' + r.data.sent + ' at this hour)');

  // admin import
  r = await call('POST', 'admin/import', { auth: 'nope', body: {} });
  ok(r.status === 401, 'import needs the admin secret');
  r = await call('POST', 'admin/import', { auth: 'admin-secret', body: { email: 'BO@example.com', issues: [{ title: 'Spending - $6.14', body: 'Date: 2026-11-08T21:47:08Z\nMerchant: Dollarama\nAmount: $6.14\nCard: Visa\nCategory: Shopping', created_at: new Date(Date.now() - 3600e3).toISOString() }], dailyLimit: 30 } });
  ok(r.data.added === 1, 'import into Bo');
  r = await call('GET', 'me', { auth: bo });
  ok(r.data.dailyLimit === 30, 'imported limit');

  // lockout after repeated wrong passwords (uses Cy so Ana and Bo are unaffected)
  await call('POST', 'auth/signup', { body: { email: 'cy@example.com', password: 'cy-password-1', invite: await invite('Cy', 7) } });
  for (let i = 0; i < 5; i++) r = await call('POST', 'auth/login', { body: { email: 'cy@example.com', password: 'nope-nope-nope' } });
  r = await call('POST', 'auth/login', { body: { email: 'cy@example.com', password: 'cy-password-1' } });
  ok(r.status === 429, 'account locked after 5 wrong passwords, even for the right one');
  await pg.query("update users set locked_until = now() - interval '1 minute' where email = 'cy@example.com'");
  r = await call('POST', 'auth/login', { body: { email: 'cy@example.com', password: 'cy-password-1' } });
  ok(r.status === 200, 'lock expires');

  // sign out everywhere + delete account
  r = await call('POST', 'signout-all', { auth: bo });
  r = await call('GET', 'me', { auth: bo });
  ok(r.status === 401, 'old session dead after sign out everywhere');
  r = await call('POST', 'auth/login', { body: { email: 'bo@example.com', password: 'bo-password-1' } });
  const bo2 = r.data.session;
  ok(r.status === 200 && !!r.data.session, 'Bo signs back in');
  r = await call('DELETE', 'account', { auth: bo2 });
  ok(r.data.ok, 'Bo deletes his account');
  const left = await pg.query("select (select count(*) from users where email = 'bo@example.com')::int as u, (select count(*) from purchases p join users u on u.id = p.user_id where u.email = 'bo@example.com')::int as p");
  ok(left.rows[0].u === 0 && left.rows[0].p === 0, 'all of Bo\'s data is gone');
  // ---- owner: invites, signups switch, removing access ----
  r = await call('GET', 'me', { auth: ana });
  ok(r.data.isOwner === true, 'Ana (OWNER_EMAIL) is the owner');
  const boNow = (await call('POST', 'auth/signup', { body: { email: 'ed@example.com', password: 'ed-password-1', invite: await invite('Ed', 7) } })).data.session;
  r = await call('GET', 'me', { auth: boNow });
  ok(r.data.isOwner === false, 'Ed is not the owner');
  r = await call('GET', 'owner/people', { auth: boNow });
  ok(r.status === 403, 'a normal person cannot open the owner list');
  r = await call('POST', 'owner/invites', { auth: boNow, body: { note: 'x' } });
  ok(r.status === 403, 'a normal person cannot make invites');
  r = await call('GET', 'owner/people', { auth: ana });
  ok(r.status === 200 && r.data.people.some((p) => p.email === 'ana@example.com' && p.owner) && r.data.signupsOpen === true, 'owner sees the people list');
  ok(!JSON.stringify(r.data).match(/merchant|amount|\"title\"|\"body\"/i), 'the list shows no purchase details, only counts');
  r = await call('POST', 'owner/invites', { auth: ana, body: { note: 'For Di', days: 1 } });
  ok(r.status === 200 && /^inv_/.test(r.data.code), 'owner makes an invite');
  const invDi = r.data.code;
  const exp = new Date(r.data.expires_at).getTime() - Date.now();
  ok(exp > 23 * 3600e3 && exp < 25 * 3600e3, 'a 1 day invite expires in about a day');
  r = await call('GET', 'owner/people', { auth: ana });
  const diInvite = r.data.invites.find((i) => i.note === 'For Di');
  ok(!!diInvite, 'pending invite is listed');
  const invId = diInvite.id;
  r = await call('DELETE', 'owner/invites/' + invId, { auth: ana });
  r = await call('POST', 'auth/signup', { body: { email: 'di@example.com', password: 'di-password-1', invite: invDi } });
  ok(r.status === 403, 'a cancelled invite no longer works');
  await pg.query("update invites set expires_at = now() - interval '1 minute' where code_hash is not null and used_at is null");
  const invOld = await invite('old', 7);
  await pg.query("update invites set expires_at = now() - interval '1 minute' where used_at is null");
  r = await call('POST', 'auth/signup', { body: { email: 'di@example.com', password: 'di-password-1', invite: invOld } });
  ok(r.status === 403, 'an expired invite no longer works');
  // switch signups off
  const invDi2 = await invite('Di', 7);
  r = await call('PUT', 'owner/signups', { auth: ana, body: { open: false } });
  ok(r.data.signupsOpen === false, 'owner turns signups off');
  r = await call('POST', 'auth/signup', { body: { email: 'di@example.com', password: 'di-password-1', invite: invDi2 } });
  ok(r.status === 403 && /closed/.test(r.data.error), 'with signups off even a good invite is refused');
  r = await call('POST', 'auth/login', { body: { email: 'ed@example.com', password: 'ed-password-1' } });
  ok(r.status === 200, 'existing people can still sign in with signups off');
  await call('PUT', 'owner/signups', { auth: ana, body: { open: true } });
  r = await call('POST', 'auth/signup', { body: { email: 'di@example.com', password: 'di-password-1', invite: invDi2 } });
  ok(r.status === 200, 'signups back on: the invite works');
  const di = r.data.session;
  // remove access
  r = await call('GET', 'setup-code', { auth: di });
  const diCode = r.data.code;
  r = await call('POST', 'log', { auth: diCode, body: { merchant: 'Cafe', amount: '4.00' } });
  ok(r.status === 200, 'Di logs a purchase');
  const people = (await call('GET', 'owner/people', { auth: ana })).data.people;
  const diRow = people.find((p) => p.email === 'di@example.com');
  r = await call('POST', 'owner/people/' + diRow.id + '/remove', { auth: boNow });
  ok(r.status === 403, 'a normal person cannot remove anyone');
  r = await call('POST', 'owner/people/' + diRow.id + '/remove', { auth: ana });
  ok(r.status === 200 && r.data.disabled === true, 'owner removes Di');
  r = await call('GET', 'me', { auth: di });
  ok(r.status === 401, 'Di\'s open session stops working');
  r = await call('POST', 'auth/login', { body: { email: 'di@example.com', password: 'di-password-1' } });
  ok(r.status === 403 && !r.data.session, 'Di cannot sign in any more');
  r = await call('POST', 'log', { auth: diCode, body: { merchant: 'Cafe', amount: '4.00' } });
  ok(r.status === 401, 'Di\'s Shortcut stops logging');
  const kept = await pg.query("select count(*)::int as n from purchases p join users u on u.id = p.user_id where u.email = 'di@example.com'");
  ok(kept.rows[0].n === 1, 'Di\'s data is kept while access is removed');
  const anaRow = people.find((p) => p.email === 'ana@example.com');
  r = await call('POST', 'owner/people/' + anaRow.id + '/remove', { auth: ana });
  ok(r.status === 400, 'the owner cannot remove themselves');
  r = await call('POST', 'owner/people/' + diRow.id + '/restore', { auth: ana });
  ok(r.status === 200 && r.data.disabled === false, 'owner restores Di');
  r = await call('POST', 'auth/login', { body: { email: 'di@example.com', password: 'di-password-1' } });
  ok(r.status === 200, 'Di can sign in again');
  // wrong invite guesses are limited
  for (let i = 0; i < 10; i++) await call('POST', 'auth/signup', { body: { email: 'x' + i + '@example.com', password: 'xx-password-1', invite: 'inv_' + 'a'.repeat(20) + i } });
  const good = await invite('late', 7);
  r = await call('POST', 'auth/signup', { body: { email: 'late@example.com', password: 'late-password-1', invite: good } });
  ok(r.status === 429, 'too many wrong invite guesses are blocked, even for a good code');
  await pg.query('delete from signup_attempts');

  // ---- the saving game ----
  const gm = (await call('POST', 'auth/signup', { body: { email: 'gamer@example.com', password: 'gamer-password-1', invite: await invite('Gamer', 7) } })).data.session;
  await call('PUT', 'me', { auth: gm, body: { tz: 'UTC' } });
  r = await call('GET', 'game', { auth: gm });
  ok(r.status === 200 && r.data.xp === 0 && r.data.level === 1 && r.data.collectible.length === 0, 'new player: level 1, nothing to collect yet');
  const dk = (i) => new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10);
  const buy = (i, amt, merchant) => ({ title: 'Spending - $' + amt + ' - ' + dk(i) + ' - Other', body: 'Date: ' + dk(i) + 'T12:00:00Z\nMerchant: ' + merchant + '\nAmount: $' + amt + '\nCard: Visa\nCategory: Other', created_at: dk(i) + 'T12:00:00Z' });
  await call('POST', 'admin/import', { auth: 'admin-secret', body: { email: 'gamer@example.com', issues: [buy(4, '10.00', 'A'), buy(2, '60.00', 'B'), buy(1, '20.00', 'C')] } });
  r = await call('GET', 'game', { auth: gm });
  ok(r.data.collectible.length === 0, 'no coins without a daily limit');
  await call('PUT', 'limit', { auth: gm, body: { dailyLimit: 50 } });
  r = await call('GET', 'game', { auth: gm });
  const late = new Date().getUTCHours() >= 20;
  const want = (late ? [[dk(0), 50]] : []).concat([[dk(1), 30], [dk(3), 50], [dk(4), 40]]);
  ok(JSON.stringify(r.data.collectible.map((c) => [c.day, c.amount])) === JSON.stringify(want),
    'coins waiting: under-limit days only, none before the first purchase, the over-limit day skipped, a $0 day worth the full limit' + (late ? ', and today after 8 PM' : ''));
  const totalCoins = want.reduce((sum, w) => sum + w[1], 0);
  ok(r.data.coins === totalCoins, 'total coins waiting: $' + totalCoins);
  r = await call('POST', 'game/collect', { auth: gm });
  const wantXp = want.reduce((sum, w) => sum + 10 + w[1], 0);
  ok(r.status === 200 && r.data.gained.coins === totalCoins && r.data.gained.xp === wantXp && r.data.xp === wantXp, 'collecting feeds Penny: +' + wantXp + ' XP');
  ok(r.data.level === 2 && r.data.gained.levelUp === 2 && r.data.outfit === 'hat', 'level up to 2 unlocks the party hat');
  ok(r.data.goal.saved === totalCoins && r.data.collectible.length === 0, 'goal total counts the coins; nothing left to collect');
  r = await call('POST', 'game/collect', { auth: gm });
  ok(r.data.gained.coins === 0 && r.data.gained.xp === 0, 'collecting twice gives nothing');
  r = await call('POST', 'game/real', { auth: gm, body: { days: [dk(1)] } });
  ok(r.data.gained.xp === 30 && r.data.realSaved === 30, 'moving it to savings for real: a golden coin, +30 XP');
  r = await call('POST', 'game/real', { auth: gm, body: { days: [dk(1)] } });
  ok(r.data.gained.xp === 0, 'the golden coin only counts once');
  await call('POST', 'admin/import', { auth: 'admin-secret', body: { email: 'gamer@example.com', issues: [buy(1, '25.00', 'D')] } });
  r = await call('GET', 'game', { auth: gm });
  ok(r.data.goal.saved === totalCoins - 25, 'spending more on a collected day lowers what it is worth ($30 -> $5)');
  r = await call('PUT', 'game/goal', { auth: gm, body: { name: '', amount: 1000 } });
  ok(r.status === 400, 'a goal needs a name');
  r = await call('PUT', 'game/goal', { auth: gm, body: { name: 'Japan trip', emoji: '✈️', amount: 0 } });
  ok(r.status === 400, 'a goal needs an amount');
  r = await call('PUT', 'game/goal', { auth: gm, body: { name: 'Japan trip', emoji: '✈️', amount: 1000 } });
  ok(r.status === 200 && r.data.goal.name === 'Japan trip' && r.data.goal.emoji === '✈️' && r.data.goal.amount === 1000 && r.data.xp === wantXp + 30, 'goal saved, XP kept');
  r = await call('DELETE', 'game', { auth: gm });
  ok(r.status === 200 && r.data.xp === 0 && r.data.level === 1 && r.data.goal.name === '' && r.data.goal.saved === 0 && r.data.outfit === '', 'Start over: goal, coins, XP and outfit all cleared');
  const keptBuys = await pg.query("select count(*)::int as n from purchases p join users u on u.id = p.user_id where u.email = 'gamer@example.com'");
  ok(keptBuys.rows[0].n === 4, 'Start over leaves purchases alone');
  r = await call('GET', 'game', { auth: gm });
  ok(r.data.collectible.length > 0 && r.data.coins > 0, 'after starting over the past days can be collected again');
  r = await call('GET', 'game');
  ok(r.status === 401, 'the game needs a sign-in');
  r = await call('DELETE', 'account', { auth: gm });
  const leftRows = await pg.query("select count(*)::int as n from game_days d left join users u on u.id = d.user_id where u.id is null");
  ok(leftRows.rows[0].n === 0, 'deleting the account deletes the game too');

  // ---- reset and change password ----
  r = await call('POST', 'auth/signup', { body: { email: 'reese@example.com', password: 'reese-password-1', invite: await invite('Reese', 7) } });
  const reese = r.data.session;
  const reeseRow = (await call('GET', 'owner/people', { auth: ana })).data.people.find((x) => x.email === 'reese@example.com');
  r = await call('POST', 'owner/people/' + reeseRow.id + '/reset', { auth: reese });
  ok(r.status === 403, 'only the owner can make a reset code');
  r = await call('POST', 'owner/people/' + reeseRow.id + '/reset', { auth: ana });
  const rstCode = r.data.code;
  ok(r.status === 200 && /^rst_[A-Za-z0-9_-]{20,}$/.test(rstCode) && r.data.email === 'reese@example.com', 'owner makes a reset code for Reese');
  const stored2 = await pg.query("select reset_hash from users where email = 'reese@example.com'");
  ok(stored2.rows[0].reset_hash && !stored2.rows[0].reset_hash.includes(rstCode), 'only the hash of the reset code is stored');
  const anaSelf = (await call('GET', 'owner/people', { auth: ana })).data.people.find((x) => x.email === 'ana@example.com');
  r = await call('POST', 'owner/people/' + anaSelf.id + '/reset', { auth: ana });
  ok(r.status === 400, 'the owner uses Change password for their own account');
  r = await call('POST', 'auth/reset', { body: { email: 'reese@example.com', code: 'rst_notarealcodenotarealcode', password: 'reese-new-password' } });
  ok(r.status === 403 && !r.data.session, 'a wrong reset code is refused');
  r = await call('POST', 'auth/reset', { body: { email: 'ana@example.com', code: rstCode, password: 'reese-new-password' } });
  ok(r.status === 403, 'a reset code only works for the account it was made for');
  r = await call('POST', 'auth/reset', { body: { email: 'reese@example.com', code: rstCode, password: 'short' } });
  ok(r.status === 400, 'reset refuses a short new password');
  r = await call('POST', 'auth/reset', { body: { email: 'reese@example.com', code: rstCode, password: 'reese-new-password' } });
  ok(r.status === 200 && r.data.session && r.data.email === 'reese@example.com', 'the right code sets a new password and signs in');
  const reese2 = r.data.session;
  r = await call('GET', 'me', { auth: reese });
  ok(r.status === 401, 'the old session stops working after a reset');
  r = await call('POST', 'auth/login', { body: { email: 'reese@example.com', password: 'reese-password-1' } });
  ok(r.status === 401, 'the old password no longer works');
  r = await call('POST', 'auth/login', { body: { email: 'reese@example.com', password: 'reese-new-password' } });
  ok(r.status === 200, 'the new password works');
  r = await call('POST', 'auth/reset', { body: { email: 'reese@example.com', code: rstCode, password: 'reese-another-pw-1' } });
  ok(r.status === 403, 'a reset code works only once');
  r = await call('POST', 'owner/people/' + reeseRow.id + '/reset', { auth: ana });
  await pg.query("update users set reset_expires = now() - interval '1 minute' where email = 'reese@example.com'");
  r = await call('POST', 'auth/reset', { body: { email: 'reese@example.com', code: r.data.code, password: 'reese-another-pw-1' } });
  ok(r.status === 403, 'an expired reset code is refused');
  r = await call('PUT', 'me/password', { auth: reese2, body: { current: 'wrong-password-1', password: 'reese-third-pw-1' } });
  ok(r.status === 403, 'change password needs the right current password');
  r = await call('PUT', 'me/password', { auth: reese2, body: { current: 'reese-new-password', password: 'short' } });
  ok(r.status === 400, 'change password refuses a short new one');
  r = await call('PUT', 'me/password', { auth: reese2, body: { current: 'reese-new-password', password: 'reese-third-pw-1' } });
  ok(r.status === 200 && r.data.session, 'change password works and returns a fresh session');
  const reese3 = r.data.session;
  r = await call('GET', 'me', { auth: reese2 });
  ok(r.status === 401, 'other phones are signed out after changing the password');
  r = await call('GET', 'me', { auth: reese3 });
  ok(r.status === 200, 'this phone stays signed in');
  r = await call('PUT', 'me/password', { body: { current: 'x', password: 'reese-fourth-pw-1' } });
  ok(r.status === 401, 'change password needs a sign-in');
  r = await call('POST', 'admin/reset', { body: { email: 'ana@example.com' } });
  ok(r.status === 401, 'admin reset needs the admin secret');
  r = await call('POST', 'admin/reset', { auth: 'admin-secret', body: { email: 'nobody@example.com' } });
  ok(r.status === 404, 'admin reset for an unknown email is 404');
  r = await call('POST', 'admin/reset', { auth: 'admin-secret', body: { email: 'ana@example.com' } });
  ok(r.status === 200 && /^rst_/.test(r.data.code), 'the admin secret can make a reset code for the owner');
  r = await call('POST', 'auth/reset', { body: { email: 'ana@example.com', code: r.data.code, password: 'ana-new-password-1' } });
  ok(r.status === 200 && r.data.session, 'the owner can get back in with that code');
  const ana2 = r.data.session; void ana2;
  await call('DELETE', 'account', { auth: reese3 });

  // ---- owner usage view: counts and times only ----
  r = await call('GET', 'owner/people', { auth: ana2 });
  const usageKeys = ['alerts', 'connected', 'lastPurchase', 'lastSeen', 'purchases', 'status'];
  ok(r.data.people.every((x) => x.usage && JSON.stringify(Object.keys(x.usage).sort()) === JSON.stringify(usageKeys)), 'each person has usage: connected, purchases, last purchase, last seen, alerts, status');
  ok(!JSON.stringify(r.data).match(/merchant|amount|"title"|"body"|Metro|Tim Hortons/i), 'the usage view never includes what was bought');
  const anaUse = r.data.people.find((x) => x.email === 'ana@example.com').usage;
  ok(anaUse.lastSeen && new Date(anaUse.lastSeen).getTime() > Date.now() - 3600000, 'last seen is recorded when the app is used');
  const noCode = r.data.people.find((x) => !x.usage.connected);
  ok(!noCode || noCode.usage.status === 'not-connected', 'someone without a setup code is marked not connected');
  ok(r.data.people.filter((x) => x.usage.connected && x.usage.purchases === 0).every((x) => x.usage.status === 'waiting'), 'a setup code with no purchase yet is marked waiting');
  r = await call('GET', 'owner/people', { auth: reese });
  ok(r.status === 401 || r.status === 403, 'a normal person cannot see the usage view');
  // ---- history summary (week / month / 3 months / year / all) ----
  const hist = (auth, qs) => new Promise((resolve) => {
    const req = { method: 'GET', url: '/api/index?route=summary' + (qs ? '&' + qs : ''), headers: auth ? { authorization: 'Bearer ' + auth } : {} };
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s2) { resolve({ status: this.statusCode, data: JSON.parse(s2) }); } };
    api(req, res);
  });
  r = await call('POST', 'auth/signup', { body: { email: 'hist@example.com', password: 'hist-password-1', invite: await invite('Hist', 7) } });
  const histTok = r.data.session;
  const histId = (await pg.query("select id from users where email = 'hist@example.com'")).rows[0].id;
  const addAt = async (daysAgo, merchant, amount, card, cat) => {
    const at = new Date(Date.now() - daysAgo * 86400000).toISOString();
    await pg.query("insert into purchases (user_id, title, body, created_at) values ($1, $2, $3, $4)", [histId, 'Spending - $' + amount, 'Date: ' + at + '\nMerchant: ' + merchant + '\nAmount: $' + amount + '\nCard: ' + card + '\nCategory: ' + (cat || ''), at]);
  };
  // today, last month and a year ago
  await addAt(0, 'Uber Eats', '30.00', 'Amex Gold');
  await addAt(0, 'Metro', '50.00', 'Visa Debit');
  await addAt(40, 'Metro', '70.00', 'Visa Debit');
  await addAt(40, 'DoorDash', '20.00', 'Amex Gold');
  await addAt(400, 'Costco', '200.00', 'Amex Gold');
  r = await hist(null, 'range=month');
  ok(r.status === 401, 'history needs a sign-in');
  r = await hist(histTok, 'range=century');
  ok(r.status === 400, 'an unknown range is refused');
  r = await hist(histTok, 'range=month');
  ok(r.status === 200 && r.data.range === 'month' && r.data.inProgress === true, 'this month is in progress');
  ok(r.data.total >= 80 && r.data.count >= 2, 'the month includes what was bought today ($80 or more)');
  ok(r.data.categories.some((c) => c.category === 'Food Delivery') && r.data.categories.some((c) => c.category === 'Groceries'), 'categories include Food Delivery and Groceries');
  ok(r.data.cards.length >= 2 && r.data.merchants[0].amount >= 50, 'cards and biggest merchants come with it');
  ok(!JSON.stringify(r.data).match(/Date:|Merchant:|Card:/), 'no raw purchase text leaks into the summary');
  r = await hist(histTok, 'range=month&rows=1');
  ok(Array.isArray(r.data.rows) && r.data.rows.length === r.data.count && r.data.startDay && r.data.endDay && r.data.today, 'a month can include its individual purchases and its dates');
  ok(r.data.rows.every((x) => x.id && x.merchant && typeof x.amount === 'number' && x.day), 'each purchase has an id, merchant, amount and day');
  r = await hist(histTok, 'range=year&rows=1');
  ok(!('rows' in r.data), 'longer ranges never send individual purchases');
  r = await hist(histTok, 'range=month');
  ok(!('rows' in r.data), 'purchases are only sent when asked for');
  r = await hist(histTok, 'range=year');
  ok(r.status === 200 && r.data.total >= 80, 'the year view works');
  r = await hist(histTok, 'range=all');
  ok(r.data.total >= 370 && r.data.prevAnchor === null && r.data.months.length >= 2, 'all time includes the old purchase, has month buckets and no comparison');
  r = await hist(histTok, 'range=week');
  ok(r.data.total >= 80 && r.data.nextAnchor === null, 'this week has no next week yet');
  const lastMonth = new Date(); lastMonth.setMonth(lastMonth.getMonth() - 1);
  const pad = (n) => (n < 10 ? '0' : '') + n;
  r = await hist(histTok, 'range=month&anchor=' + lastMonth.getFullYear() + '-' + pad(lastMonth.getMonth() + 1) + '-15');
  ok(r.data.inProgress === false && r.data.nextAnchor !== null, 'last month is complete and has a next month to go to');
  r = await hist(histTok, 'range=month');
  ok(r.data.prevAnchor !== null, 'this month has a previous month to go back to');

  // ---- trend (the home screen's own 7 / 30 / 365-day timeline) ----
  const trend = (auth, qs) => new Promise((resolve) => {
    const req = { method: 'GET', url: '/api/index?route=trend' + (qs ? '&' + qs : ''), headers: auth ? { authorization: 'Bearer ' + auth } : {} };
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s2) { resolve({ status: this.statusCode, data: JSON.parse(s2) }); } };
    api(req, res);
  });
  r = await trend(null, 'days=7');
  ok(r.status === 401, 'trend needs a sign-in');
  r = await trend(histTok, 'days=10');
  ok(r.status === 400, 'an unsupported day count is refused');
  r = await trend(histTok, 'days=7');
  ok(r.status === 200 && r.data.days === 7 && r.data.total >= 80 && r.data.count === 2, 'the last 7 days is just what was bought today');
  ok(r.data.daily && Object.values(r.data.daily).reduce((a, b) => a + b, 0) >= 80, 'the 7-day page gets a daily breakdown');
  ok(!('months' in r.data), 'the 7-day page has no month buckets');
  r = await trend(histTok, 'days=30');
  ok(r.data.total >= 80 && r.data.total < 170, '30 days still misses the purchase from 40 days ago');
  r = await trend(histTok, 'days=365');
  ok(r.data.total >= 170 && r.data.total < 370 && r.data.count === 4, '365 days reaches 40 days back but not the 400-day-old purchase');
  ok(!('daily' in r.data), 'the 365-day page has no day-by-day breakdown');
  ok(Array.isArray(r.data.months) && r.data.months.length >= 1 && r.data.months.every((m) => /^\d{4}-\d{2}$/.test(m.key) && typeof m.total === 'number'), 'the 365-day page is grouped into months instead');
  // all three ranges in one call must be exactly what three separate calls give (this is what the app now asks for)
  {
    const one = {};
    for (const d of [7, 30, 365]) one[d] = (await trend(histTok, 'days=' + d)).data;
    const all = await trend(histTok, 'days=all');
    ok(all.status === 200 && all.data.ranges && Object.keys(all.data.ranges).join() === '7,30,365', 'days=all returns the 7, 30 and 365 day pages together');
    ok([7, 30, 365].every((d) => JSON.stringify(all.data.ranges[d]) === JSON.stringify(one[d])), 'each page in days=all is identical to asking for it on its own');
    ok((await trend(null, 'days=all')).status === 401, 'days=all needs a sign-in too');
    ok((await trend(histTok, 'days=all,10')).status === 400, 'and a made-up value is still refused');
  }
  await call('DELETE', 'account', { auth: histTok });

  // ---- forecast (time series) ----
  {
    const fc = require('../lib/forecast');
    let seed = 7;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const base = [20, 20, 20, 20, 45, 70, 40];        // weekends cost more
    const daily = [];
    for (let i = 0; i < 56; i++) daily.push(Math.max(0, base[i % 7] + (rnd() - 0.5) * 20));
    const truth = 300 + 10 + (() => { let sum = 0; for (let h = 0; h < 16; h++) sum += base[(56 + 1 + h) % 7]; return sum; })();
    const f1 = fc.forecastMonth({ daily, todaySoFar: 10, remaining: 16, spentBefore: 300, seed: 1 });
    ok(f1 && f1.method === 'weekly-pattern', 'with 8 weeks of history the time-series model is used');
    ok(Math.abs(f1.point - truth) / truth < 0.12, 'the forecast lands within 12% of the true pattern (' + f1.point + ' vs about ' + Math.round(truth) + ')');
    ok(f1.low < f1.point && f1.point < f1.high && f1.low >= 310, 'the range surrounds the forecast and never goes below what is already spent');
    ok(f1.weekly.length === 7 && Math.max(...f1.weekly) === f1.weekly[5], 'it learned that Saturday is the biggest day');
    const f1b = fc.forecastMonth({ daily, todaySoFar: 10, remaining: 16, spentBefore: 300, seed: 1 });
    ok(JSON.stringify(f1) === JSON.stringify(f1b), 'the same data gives the same forecast every time');
    const f2 = fc.forecastMonth({ daily: daily.slice(0, 14), todaySoFar: 0, remaining: 16, spentBefore: 100, seed: 1 });
    ok(f2 && f2.method === 'typical-day' && f2.confidence === 'low', 'under 3 weeks of history it falls back to the typical day, with low confidence');
    ok(fc.forecastMonth({ daily: [5, 6, 7], todaySoFar: 0, remaining: 10, spentBefore: 0 }) === null, 'under a week of history there is no forecast');
    const quiet = fc.forecastMonth({ daily: new Array(40).fill(0), todaySoFar: 0, remaining: 10, spentBefore: 0, seed: 1 });
    ok(quiet && quiet.point === 0 && quiet.high === 0, 'a person who spends nothing is forecast at zero');
    const spiky = daily.slice(); spiky[30] = 2500;      // one huge purchase must not set the pace for the month
    const f3 = fc.forecastMonth({ daily: spiky, todaySoFar: 10, remaining: 16, spentBefore: 300, seed: 1 });
    ok(f3.point < f1.point * 1.4, 'one huge purchase in the past does not blow up the forecast');
    ok([f1, f2, f3].every((x) => [x.point, x.low, x.high].every((v) => Number.isFinite(v))), 'no forecast is NaN or infinite');
  }
  r = await call('POST', 'auth/signup', { body: { email: 'fc@example.com', password: 'forecast-password-1', invite: await invite('Fc', 7) } });
  const fcTok = r.data.session;
  const fcId = (await pg.query("select id from users where email = 'fc@example.com'")).rows[0].id;
  for (let d = 40; d >= 1; d--) {                       // 40 days of history, bigger on weekends
    const at = new Date(Date.now() - d * 86400000);
    const amt = [0, 5, 6].includes((at.getUTCDay() + 6) % 7) ? '60.00' : '20.00';
    await pg.query("insert into purchases (user_id, title, body, created_at) values ($1, $2, $3, $4)", [fcId, 'Spending - $' + amt, 'Date: ' + at.toISOString() + '\nMerchant: Metro\nAmount: $' + amt + '\nCard: Visa\nCategory: ', at.toISOString()]);
  }
  const hist2 = (auth, qs) => new Promise((resolve) => {
    const req = { method: 'GET', url: '/api/index?route=summary' + (qs ? '&' + qs : ''), headers: { authorization: 'Bearer ' + auth } };
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(s2) { resolve({ status: this.statusCode, data: JSON.parse(s2) }); } };
    api(req, res);
  });
  r = await hist2(fcTok, 'range=month');
  ok(r.status === 200 && r.data.forecast && r.data.forecast.point > 0 && r.data.forecast.low <= r.data.forecast.high, 'the month summary carries a forecast');
  ok(r.data.forecast.method === 'weekly-pattern' && r.data.forecast.daysOfData >= 30, 'a person with 40 days of history gets the time-series forecast');
  r = await hist2(fcTok, 'range=year');
  ok(r.data.forecast === null, 'only the current month has a forecast');
  await call('DELETE', 'account', { auth: fcTok });

  // ---- purchase text is stored encrypted ----
  {
    const vault = require('../lib/vault');
    const migrate = require('../tools/encrypt-purchases');
    const raw = async (sql, p) => (await pg.query(sql, p || [])).rows;
    r = await call('POST', 'auth/signup', { body: { email: 'vault@example.com', password: 'vault-password-1', invite: await invite('V', 7) } });
    const vTok = r.data.session;
    r = await call('POST', 'auth/signup', { body: { email: 'vault2@example.com', password: 'vault-password-2', invite: await invite('V2', 7) } });
    const v2Tok = r.data.session;
    const vId = (await raw("select id from users where email = 'vault@example.com'"))[0].id;
    const v2Id = (await raw("select id from users where email = 'vault2@example.com'"))[0].id;
    const title = 'Spending - $12.34 - ' + new Date().toISOString().slice(0, 10) + ' - Coffee';
    const body = 'Date: ' + new Date().toISOString() + '\nMerchant: Secret Cafe\nAmount: $12.34\nCard: Visa 4242\nCategory: Coffee';

    ok(vault.enabled(), 'encryption is on when DATA_KEY is set');
    r = await call('POST', 'purchases', { auth: vTok, body: { title, body } });
    const pid = r.data.number;
    ok(r.status === 200 && r.data.title === title && r.data.body === body, 'adding a purchase answers with the real text');
    let row = (await raw('select title, body from purchases where id = $1', [pid]))[0];
    ok(row.title.startsWith('e1:') && row.body.startsWith('e1:'), 'the database stores the title and details encrypted');
    ok(!/Secret Cafe|12\.34|4242|Coffee|Spending/.test(row.title + row.body), 'nothing readable (merchant, amount, card) is in the stored text');
    r = await call('GET', 'purchases/' + pid, { auth: vTok });
    ok(r.status === 200 && r.data.title === title && r.data.body === body, 'reading a purchase gives the real text back');
    r = await call('GET', 'purchases', { auth: vTok });
    ok(r.data.length === 1 && r.data[0].title === title && r.data[0].body === body, 'the feed gives the real text back');
    const sum = (await hist2(vTok, 'range=month')).data;
    ok(sum.total === 12.34 && sum.count === 1, 'totals and categories still work on encrypted purchases');

    // the same text twice looks different (fresh random value each time), so patterns cannot be spotted
    r = await call('POST', 'purchases', { auth: vTok, body: { title, body } });
    const twin = (await raw('select title from purchases where id = $1', [r.data.number]))[0].title;
    ok(twin !== row.title, 'the same purchase twice is stored as two different values');

    // editing keeps it encrypted
    r = await call('PATCH', 'purchases/' + pid, { auth: vTok, body: { state: 'closed' } });
    ok(r.status === 200 && r.data.title === title && r.data.state === 'closed', 'closing a purchase keeps its text');
    row = (await raw('select title, body, state from purchases where id = $1', [pid]))[0];
    ok(row.title.startsWith('e1:') && row.body.startsWith('e1:') && row.state === 'closed', 'an edited purchase is still stored encrypted');
    await call('PATCH', 'purchases/' + pid, { auth: vTok, body: { state: 'open', title: 'Spending - $20.00 - changed' } });
    r = await call('GET', 'purchases/' + pid, { auth: vTok });
    ok(r.data.title === 'Spending - $20.00 - changed' && r.data.body === body, 'editing the title changes only the title');

    // a stored value is tied to its owner and its column
    const other = (await call('POST', 'purchases', { auth: v2Tok, body: { title: 'Spending - $5.00 - other', body: 'Merchant: Other Shop\nAmount: $5.00' } })).data.number;
    const mine = (await raw('select title, body from purchases where id = $1', [pid]))[0];
    await pg.query('update purchases set title = $2, body = $3 where id = $1', [other, mine.title, mine.body]);
    r = await call('GET', 'purchases/' + other, { auth: v2Tok });
    ok(r.status >= 400 && !JSON.stringify(r.data).includes('Secret Cafe'), 'a value copied onto another person\'s purchase is refused, not shown');
    await pg.query('update purchases set title = $2, body = $3 where id = $1', [other, mine.body, mine.title]);
    r = await call('GET', 'purchases/' + other, { auth: v2Tok });
    ok(r.status >= 400, 'a value moved to the other column is refused');
    await pg.query("update purchases set body = $2 where id = $1", [pid, mine.body.slice(0, -4) + 'AAAA']);
    r = await call('GET', 'purchases/' + pid, { auth: vTok });
    ok(r.status >= 400, 'a value that was changed in the database is refused');
    await pg.query('update purchases set title = $2, body = $3 where id = $1', [pid, mine.title, mine.body]);
    r = await call('GET', 'purchases/' + pid, { auth: vTok });
    ok(r.status === 200 && r.data.body === body, 'putting the real value back works again');
    await pg.query('delete from purchases where id = $1', [other]);

    // old plain text rows keep working next to encrypted ones
    await pg.query("insert into purchases (user_id, title, body, created_at) values ($1, 'Spending - $3.00 - old', 'Merchant: Old Shop\nAmount: $3.00', now())", [vId]);
    r = await call('GET', 'purchases', { auth: vTok });
    ok(r.data.some((x) => x.title === 'Spending - $3.00 - old') && r.data.some((x) => x.title === 'Spending - $20.00 - changed'), 'old plain rows and encrypted rows show together');

    // the shortcut route stores encrypted too
    r = await call('POST', 'setup-code', { auth: vTok });
    const code = r.data.code;
    r = await call('POST', 'log', { auth: code, body: { merchant: 'Shortcut Diner', amount: '7.50', card: 'Visa', category: 'Food' } });
    ok(r.status === 200 && r.data.ok, 'the Shortcut can still log a purchase');
    const lastRow = (await raw('select title, body from purchases where id = $1', [r.data.id]))[0];
    ok(lastRow.title.startsWith('e1:') && !/Shortcut Diner/.test(lastRow.body), 'a purchase from the Shortcut is stored encrypted');

    // moving old rows over
    const msgs = [];
    let s1 = await migrate.run({ q: db.q, apply: false, log: (m) => msgs.push(m) });
    ok(s1.plain >= 1 && s1.changed >= 1, 'the move tool, run to look only, finds the old plain rows');
    ok((await raw("select count(*)::int as n from purchases where title not like 'e1:%'"))[0].n >= 1, 'looking only changed nothing');
    s1 = await migrate.run({ q: db.q, apply: true, log: (m) => msgs.push(m) });
    ok(s1.failed === 0 && s1.changed >= 1, 'the move tool encrypts the old rows');
    ok((await raw("select count(*)::int as n from purchases where title not like 'e1:%' or body not like 'e1:%'"))[0].n === 0, 'afterwards no purchase is stored as plain text');
    let v = await migrate.verify({ q: db.q });
    ok(v.bad === 0 && v.plain === 0 && v.sealed === v.rows, 'every stored purchase opens with the key');
    r = await call('GET', 'purchases', { auth: vTok });
    ok(r.data.some((x) => x.title === 'Spending - $3.00 - old' && x.body.includes('Old Shop')), 'the old purchase reads the same after the move');
    s1 = await migrate.run({ q: db.q, apply: true, log: (m) => msgs.push(m) });
    ok(s1.changed === 0 && s1.failed === 0, 'running the move again changes nothing');
    ok(!msgs.some((m) => /Old Shop|Secret Cafe|Shortcut Diner|\$12\.34/.test(m)), 'the tool never prints purchase text');

    // a new key: old rows still open while the old key is kept as DATA_KEY_PREV, then they are moved to the new one
    const oldKey = process.env.DATA_KEY;
    process.env.DATA_KEY = 'a-brand-new-data-key-'.repeat(3);
    r = await call('GET', 'purchases', { auth: vTok });
    ok(r.status >= 400, 'with only a new key, rows made with the old key are refused');
    process.env.DATA_KEY_PREV = oldKey;
    r = await call('GET', 'purchases', { auth: vTok });
    ok(r.status === 200 && r.data.some((x) => x.title === 'Spending - $3.00 - old'), 'with the old key kept as DATA_KEY_PREV the rows still open');
    s1 = await migrate.run({ q: db.q, apply: true, rekey: true, log: () => {} });
    ok(s1.failed === 0 && s1.changed >= 1, 'the move tool can re-encrypt everything with the new key');
    delete process.env.DATA_KEY_PREV;
    r = await call('GET', 'purchases', { auth: vTok });
    ok(r.status === 200 && r.data.some((x) => x.title === 'Spending - $3.00 - old'), 'after that the old key is no longer needed');

    // undoing it, and running with no key at all
    s1 = await migrate.run({ q: db.q, apply: true, decrypt: true, log: () => {} });
    ok(s1.failed === 0 && (await raw("select count(*)::int as n from purchases where title like 'e1:%' or body like 'e1:%'"))[0].n === 0, 'the move tool can undo it (write everything back as plain text)');
    const savedKey = process.env.DATA_KEY;
    delete process.env.DATA_KEY;
    ok(!vault.enabled(), 'encryption is off with no DATA_KEY');
    r = await call('POST', 'purchases', { auth: vTok, body: { title: 'Spending - $1.00 - nokey', body: 'Merchant: No Key\nAmount: $1.00' } });
    ok(r.status === 200 && (await raw('select title from purchases where id = $1', [r.data.number]))[0].title === 'Spending - $1.00 - nokey', 'with no key the app still works and stores plain text');
    process.env.DATA_KEY = 'too short';
    ok(!vault.enabled(), 'a key shorter than 32 characters is not used');
    process.env.DATA_KEY = savedKey;
    await migrate.run({ q: db.q, apply: true, log: () => {} });
    delete process.env.DATA_KEY;
    r = await call('GET', 'purchases', { auth: vTok });
    ok(r.status >= 400 && !JSON.stringify(r.data).includes('e1:'), 'encrypted rows with no key are refused, never shown as gibberish');
    process.env.DATA_KEY = savedKey;
    r = await call('GET', 'purchases', { auth: vTok });
    ok(r.status === 200 && r.data.length >= 4, 'with the key back, everything opens again');
    await call('DELETE', 'account', { auth: vTok });
    await call('DELETE', 'account', { auth: v2Tok });
    ok((await raw('select count(*)::int as n from purchases where user_id in ($1, $2)', [vId, v2Id]))[0].n === 0, 'deleting an account removes its purchases');
  }

  // ---- a Wallet alert can carry a cleaned-up name and a category (made by the phone's own model) ----
  {
    const sf = api._test.fromShortcut;
    let p = sf({ source: 'wallet', title: 'Visa', subtitle: 'Saq23028faubourg Ste-Cat', body: '$28.80', merchant: 'SAQ', category: 'Groceries' });
    ok(/Merchant: SAQ/.test(p.body) && /Category: Groceries/.test(p.body) && /Subtitle: Saq23028faubourg Ste-Cat/.test(p.body), 'a Wallet alert keeps the cleaned name and category next to the raw alert text');
    p = sf({ source: 'wallet', title: 'Visa', subtitle: 'TIM HORTONS #1234', body: '$12.40' });
    ok(!/Merchant:|Category:/.test(p.body), 'an alert without them is stored exactly as before');
    p = sf({ title: 'Visa', subtitle: 'Saq23028faubourg Ste-Cat', body: '$5.00', merchant: 'SAQ' });
    ok(/Source: wallet-notification/.test(p.body) && /Merchant: SAQ/.test(p.body), 'alert text plus a merchant but no amount is still a Wallet alert');
    p = sf({ source: 'wallet', title: 'Visa', subtitle: 'X STORE', body: '$5.00', name: 'Wallet' });
    ok(!/Merchant:/.test(p.body), 'a field called name is not taken as the merchant of a Wallet alert');
    p = sf({ merchant: 'Metro', amount: '12.00', card: 'Visa', category: 'Groceries' });
    ok(/Merchant: Metro/.test(p.body) && !/Source:/.test(p.body), 'a tap purchase with a merchant and amount is unchanged');
    r = await call('POST', 'auth/signup', { body: { email: 'saq@example.com', password: 'saq-password-123', invite: await invite('Saq', 7) } });
    const saqTok = r.data.session;
    const saqCode = (await call('POST', 'setup-code', { auth: saqTok })).data.code;
    r = await call('POST', 'log', { auth: saqCode, body: { source: 'wallet', title: 'American Express', subtitle: 'Saq23028faubourg Ste-Cat', body: '$28.80', merchant: 'SAQ', category: 'Groceries' } });
    ok(r.status === 200 && r.data.ok, 'the server accepts a Wallet alert with a cleaned name and category');
    r = await call('POST', 'log', { auth: saqCode, body: { source: 'wallet', title: 'American Express', subtitle: 'Mystery Shop 4411', body: '$9.00' } });
    const sm = (await hist2(saqTok, 'range=week&rows=1')).data;
    const saqRow = (sm.rows || []).find((x) => x.amount === 28.8);
    const oldRow = (sm.rows || []).find((x) => x.amount === 9);
    ok(saqRow && saqRow.merchant === 'SAQ' && saqRow.category === 'Entertainment', 'in the app the purchase shows as SAQ in Entertainment, not the raw text in Other: ' + JSON.stringify(saqRow && [saqRow.merchant, saqRow.category]));
    ok(oldRow && oldRow.category === 'Other' && /Mystery/.test(oldRow.merchant), 'an alert without the extras behaves exactly as before');
    // the real fix: the raw text alone, with nothing cleaned by the phone, now comes out right
    r = await call('POST', 'log', { auth: saqCode, body: { source: 'wallet', title: 'American Express', subtitle: 'Marche Tharsnio 4411 Montreal QC', body: '$41.17' } });
    r = await call('POST', 'log', { auth: saqCode, body: { merchant: 'Saq23028faubourg Ste-Cat', amount: '33.10', card: 'Amex', category: 'Other' } });
    const raw2 = (await hist2(saqTok, 'range=week&rows=1')).data.rows || [];
    const mar = raw2.find((x) => x.amount === 41.17);
    const saq2 = raw2.find((x) => x.amount === 33.1);
    ok(mar && mar.merchant === 'Marche Tharsnio' && mar.category === 'Groceries', 'a raw Wallet alert from Marche Tharsnio shows as Marche Tharsnio in Groceries: ' + JSON.stringify(mar && [mar.merchant, mar.category]));
    ok(saq2 && saq2.merchant === 'SAQ' && saq2.category === 'Entertainment', 'a raw tap purchase from Saq23028faubourg Ste-Cat shows as SAQ in Entertainment even when the Shortcut said Other: ' + JSON.stringify(saq2 && [saq2.merchant, saq2.category]));
    await call('DELETE', 'account', { auth: saqTok });
  }

  // ---- the person's own necessary / unnecessary mark on a purchase ----
  {
    r = await call('POST', 'auth/signup', { body: { email: 'kind@example.com', password: 'kind-password-123', invite: await invite('K', 7) } });
    const kTok = r.data.session;
    r = await call('POST', 'auth/signup', { body: { email: 'kind2@example.com', password: 'kind2-password-123', invite: await invite('K2', 7) } });
    const k2Tok = r.data.session;
    r = await call('POST', 'purchases', { auth: kTok, body: { title: 'Spending - $9.00 - kind', body: 'Merchant: Tim Hortons\nAmount: $9.00\nCard: Visa' } });
    const kid = r.data.number;
    ok(r.data.kind === '', 'a new purchase has no mark of its own (the app guesses by category)');
    r = await call('PATCH', 'purchases/' + kid, { auth: kTok, body: { kind: 'fun' } });
    ok(r.status === 200 && r.data.kind === 'fun', 'a purchase can be marked unnecessary');
    r = await call('GET', 'purchases', { auth: kTok });
    ok(r.data.find((x) => x.number === kid).kind === 'fun', 'the mark comes back with the purchases');
    r = await call('GET', 'purchases/' + kid, { auth: kTok });
    ok(r.data.kind === 'fun' && /Tim Hortons/.test(r.data.body), 'and with a single purchase, the text untouched');
    r = await call('PATCH', 'purchases/' + kid, { auth: kTok, body: { kind: 'need' } });
    ok(r.data.kind === 'need', 'it can be switched to necessary');
    r = await call('PATCH', 'purchases/' + kid, { auth: kTok, body: { state: 'open', title: 'Spending - $9.00 - kind' } });
    ok(r.data.kind === 'need', 'editing something else keeps the mark');
    r = await call('PATCH', 'purchases/' + kid, { auth: kTok, body: { kind: 'sometimes' } });
    ok(r.status === 400, 'a made-up mark is refused');
    r = await call('PATCH', 'purchases/' + kid, { auth: k2Tok, body: { kind: 'fun' } });
    ok(r.status === 404, 'nobody else can mark your purchase');
    r = await call('PATCH', 'purchases/' + kid, { auth: kTok, body: { kind: '' } });
    ok(r.status === 200 && r.data.kind === '', 'an empty mark goes back to the app\'s guess');
    r = await hist2(kTok, 'range=week');
    ok(r.status === 200, 'summaries still work with marks');
    const stored = (await pg.query('select kind, title from purchases where id = $1', [kid])).rows[0];
    ok(stored.kind === null && /^e1:/.test(stored.title), 'the mark is its own column, and the purchase text stays encrypted');
    await call('DELETE', 'account', { auth: kTok });
    await call('DELETE', 'account', { auth: k2Tok });
  }

  // ---- reading a bill with the AI reader (a pretend reader, so no real photo or key is needed) ----
  {
    const vbills = require('../lib/bills');
    r = await call('POST', 'auth/signup', { body: { email: 'bill@example.com', password: 'bill-password-123', invite: await invite('Bill', 7) } });
    const bTok = r.data.session;
    r = await call('POST', 'auth/signup', { body: { email: 'bill2@example.com', password: 'bill2-password-123', invite: await invite('Bill2', 7) } });
    const b2Tok = r.data.session;
    const photo = 'A'.repeat(4000);          // looks like base64; the pretend reader never looks at it
    const scan = (tok, extra) => call('POST', 'bills/scan', { auth: tok, body: { image: photo, mime: 'image/jpeg', store: 'Metro', amount: '90.61', ...(extra || {}) } });
    const FRENCH = { store: 'METRO PLUS #204', date: '2026-11-15', subtotal: '84,40', tax: 6.21, total: '90,61', items: [
      { name: 'LAIT 2% 2L', qty: 1, price: '5,49', kind: 'need' }, { name: 'OEUFS DOUZ', qty: 1, price: 4.29, kind: 'need' },
      { name: 'POULET ENTIER', qty: 1, price: '12,40', kind: 'need' }, { name: 'CHIPS LAYS BBQ', qty: 1, price: 4.99, kind: 'fun' },
      { name: 'BIERE MOLSON 12X', qty: 1, price: 21.99, kind: 'need' },            // the reader got this wrong: it is alcohol
      { name: 'COCA-COLA 12X', qty: 1, price: 7.99, kind: 'fun' }, { name: 'CREME GLACEE', qty: 1, price: 6.49, kind: 'unk' },
      { name: 'RIZ BASMATI', qty: 1, price: 8.49, kind: 'need' }, { name: 'BROCOLI', qty: 1, price: 2.99, kind: 'need' },
      { name: 'BANANES 1,2KG', qty: 1, price: 2.10, kind: 'need' }, { name: 'SAVON LIQUIDE', qty: 1, price: 3.99, kind: 'need' },
      { name: 'PAIN TRANCHE', qty: 1, price: 3.19, kind: 'need' },
      { name: 'SOUS-TOTAL', price: 84.40 }, { name: 'TPS 5%', price: 2.07 }, { name: 'TVQ 9,975%', price: 4.14 }, { name: 'VISA ****4242', price: 90.61 }, { name: 'MONNAIE', price: 0 }] };

    r = await call('GET', 'config');
    ok(r.data.billScan === false, 'with no AI key the app says bill scanning is off');
    r = await scan(bTok);
    ok(r.status === 503, 'and a scan is refused with a clear message: ' + (r.data.error || ''));
    process.env.ANTHROPIC_API_KEY = 'test-key';
    api._test.setBillReader(async () => FRENCH);
    r = await call('GET', 'config');
    ok(r.data.billScan === true, 'with a key set the app says bill scanning is on');
    r = await call('POST', 'bills/scan', { body: { image: photo, mime: 'image/jpeg' } });
    ok(r.status === 401, 'scanning needs a sign-in');
    r = await call('POST', 'bills/scan', { auth: bTok, body: { image: photo, mime: 'application/pdf' } });
    ok(r.status === 400, 'only photos are accepted');
    r = await call('POST', 'bills/scan', { auth: bTok, body: { image: 'tiny', mime: 'image/jpeg' } });
    ok(r.status === 400, 'a tiny or empty image is refused');
    r = await call('POST', 'bills/scan', { auth: bTok, body: { image: '!'.repeat(3000), mime: 'image/jpeg' } });
    ok(r.status === 400, 'something that is not base64 is refused');

    r = await scan(bTok);
    ok(r.status === 200 && r.data.items.length === 12, 'a French bill gives its 12 items, without the subtotal, tax, card or change lines: ' + (r.data.items || []).length);
    const by = (n) => r.data.items.find((x) => x.name === n);
    ok(by('LAIT 2% 2L').price === 5.49 && by('POULET ENTIER').price === 12.4, 'prices with a French decimal comma are read right (5,49 is 5.49)');
    ok(by('BIERE MOLSON 12X').kind === 'fun' && by('BIERE MOLSON 12X').how === 'rule', 'beer is always unnecessary, even when the reader said otherwise');
    ok(by('CREME GLACEE').kind === 'unk', 'something the reader was unsure about stays not sure');
    ok(r.data.matches === true && r.data.itemsTotal === 84.4 && r.data.tax === 6.21, 'items plus tax match the purchase: ' + r.data.itemsTotal + ' + ' + r.data.tax);
    r = await scan(bTok, { amount: '120.00' });
    ok(r.status === 200 && r.data.matches === false && r.data.diff > 20, 'a bill that does not add up to the purchase is flagged');
    api._test.setBillReader(async () => ({ store: 'SAQ', items: [{ name: 'VIN ROUGE 750ML', price: 18.5, kind: 'need' }, { name: 'SAC', price: 0.1, kind: 'need' }], tax: 2.8, total: 21.4 }));
    r = await scan(bTok, { store: 'Saq23028faubourg Ste-Cat', amount: '21.40' });
    ok(r.data.items.every((x) => x.kind === 'fun' && x.how === 'store'), 'every item bought at the SAQ is unnecessary, and says why');
    api._test.setBillReader(async () => { throw new Error('boom'); });
    r = await scan(bTok);
    ok(r.status === 502 && !/boom/.test(JSON.stringify(r.data)), 'if the reader fails the person gets a plain message, not the error');
    api._test.setBillReader(async () => ({ items: [], error: 'not a receipt' }));
    r = await scan(bTok);
    ok(r.status === 422, 'a photo that is not a bill says so');
    api._test.setBillReader(async () => ({ items: [{ name: 'TPS', price: 2 }, { name: 'TOTAL', price: 9 }] }));
    r = await scan(bTok);
    ok(r.status === 422, 'a "bill" with only tax and total lines has no items');

    // the daily limit
    process.env.BILL_DAILY_LIMIT = '3';
    api._test.setBillReader(async () => FRENCH);
    const used = (await pg.query("select count(*)::int as n from bill_scans")).rows[0].n;
    r = await scan(b2Tok);
    ok(r.status === 200, 'a second person has their own daily count');
    await pg.query("delete from bill_scans");
    for (let k = 0; k < 3; k++) await scan(bTok);
    r = await scan(bTok);
    ok(r.status === 429, 'after the daily limit a scan is refused');
    delete process.env.BILL_DAILY_LIMIT;
    await pg.query("delete from bill_scans");
    ok(!(await pg.query("select column_name from information_schema.columns where table_name = 'bill_scans'")).rows.some((c) => /image|photo|data/.test(c.column_name)), 'the photo is never stored: the scan log has no place for it');

    // saving, reading back, privacy
    r = await call('POST', 'purchases', { auth: bTok, body: { title: 'Spending - $90.61 - bill', body: 'Merchant: Metro\nAmount: $90.61\nCard: Visa\nCategory: Groceries' } });
    const pid = r.data.number;
    const toSave = FRENCH.items.slice(0, 12).map((x) => ({ name: x.name, price: vbills.num(x.price), kind: x.name === 'BIERE MOLSON 12X' || x.name === 'CHIPS LAYS BBQ' || x.name === 'COCA-COLA 12X' || x.name === 'CREME GLACEE' ? 'fun' : 'need' }));
    r = await call('PUT', 'purchases/' + pid + '/items', { auth: bTok, body: { items: toSave, amount: 90.61 } });
    ok(r.status === 200 && r.data.count === 12, 'the confirmed items are saved');
    const stored = (await pg.query('select name, price, alloc from bill_items where purchase_id = $1 order by pos', [pid])).rows;
    ok(stored.length === 12 && stored.every((x) => /^e1:/.test(x.name)) && !stored.some((x) => /LAIT|BIERE/.test(x.name)), 'item names are stored encrypted');
    ok(Math.abs(stored.reduce((a, x) => a + Number(x.alloc), 0) - 90.61) < 0.005, 'the amount paid is shared over the items and adds up exactly: ' + stored.reduce((a, x) => a + Number(x.alloc), 0).toFixed(2));
    r = await call('GET', 'purchases/' + pid + '/items', { auth: bTok });
    ok(r.data.items.length === 12 && r.data.items[0].name === 'LAIT 2% 2L' && r.data.items.find((x) => x.name === 'BIERE MOLSON 12X').kind === 'fun', 'the items read back in order with their names and marks');
    r = await call('GET', 'purchases/' + pid + '/items', { auth: b2Tok });
    ok(r.status === 404, 'nobody else can read your items');
    r = await call('PUT', 'purchases/' + pid + '/items', { auth: b2Tok, body: { items: toSave, amount: 90.61 } });
    ok(r.status === 404, 'nobody else can change them');
    r = await call('GET', 'purchases', { auth: bTok });
    const withBill = r.data.find((x) => x.number === pid);
    const needA = withBill.bill.need, funA = withBill.bill.fun;
    ok(withBill.bill.n === 12 && Math.abs(needA + funA + withBill.bill.unk - 90.61) < 0.01 && funA > 40, 'the purchase comes back with its necessary / unnecessary split: ' + JSON.stringify(withBill.bill));
    r = await call('PUT', 'purchases/' + pid + '/items', { auth: bTok, body: { items: toSave, amount: 0 } });
    ok(r.status === 400, 'saving needs the amount paid');

    // it remembers what you decided about a product
    api._test.setBillReader(async () => ({ store: 'Metro', tax: 0, total: 5, items: [{ name: 'CHIPS LAYS BBQ 235G', price: 5, kind: 'need' }, { name: 'LAIT 2% 2L', price: 5.5, kind: 'fun' }] }));
    r = await scan(bTok, { amount: '10.5' });
    const chips = r.data.items.find((x) => /CHIPS/.test(x.name));
    const lait = r.data.items.find((x) => /LAIT/.test(x.name));
    ok(chips.kind === 'fun' && chips.how === 'remembered' && lait.kind === 'need' && lait.how === 'remembered', 'next time it starts from what you decided (chips unnecessary, milk necessary), whatever the reader says');

    r = await call('PUT', 'purchases/' + pid + '/items', { auth: bTok, body: { items: [] } });
    ok(r.status === 200 && (await pg.query('select count(*)::int as n from bill_items where purchase_id = $1', [pid])).rows[0].n === 0, 'saving no items clears them');
    await call('PUT', 'purchases/' + pid + '/items', { auth: bTok, body: { items: toSave, amount: 90.61 } });
    await call('DELETE', 'account', { auth: bTok });
    ok((await pg.query('select count(*)::int as n from bill_items')).rows[0].n === 0, 'deleting an account deletes its bill items');
    await call('DELETE', 'account', { auth: b2Tok });
    api._test.setBillReader(null);
    delete process.env.ANTHROPIC_API_KEY;
  }

  // ---- a bill from the Apple Shortcut: plain text, read by rules, matched to its purchase, waiting as a draft ----
  {
    const METRO_TEXT = `METRO PLUS #204
MONTREAL QC
2026-11-15 18:12
LAIT 2% 2L                5,49 FC
OEUFS GR A 12             4,29 FC
PAIN TRANCHE              3,19 FC
POULET ENTIER
   2,134 kg @ 5,81/kg      12,40 FC
CHIPS LAYS BBQ 235G       4,99 FCT
COCA-COLA 12X355ML        7,99 FCT
BIERE MOLSON 12X355ML    21,99 FCT
RABAIS                    -1,00
SOUS-TOTAL               58,34
TPS 5% (R123456789)       1,75
TVQ 9,975% (1234567890)   3,49
TOTAL                    63,58
VISA ****4242            63,58`;
    r = await call('POST', 'auth/signup', { body: { email: 'shortcut@example.com', password: 'shortcut-password-1', invite: await invite('Sc', 7) } });
    const sTok = r.data.session;
    r = await call('POST', 'auth/signup', { body: { email: 'shortcut2@example.com', password: 'shortcut2-password-1', invite: await invite('Sc2', 7) } });
    const s2Tok = r.data.session;
    const sCode = (await call('POST', 'setup-code', { auth: sTok })).data.code;
    const s2Code = (await call('POST', 'setup-code', { auth: s2Tok })).data.code;
    const mk = async (tok, merchant, amount) => (await call('POST', 'purchases', { auth: tok, body: { title: 'Spending - $' + amount, body: 'Merchant: ' + merchant + '\nAmount: $' + amount + '\nCard: Visa\nCategory: Groceries' } })).data.number;
    const pid = await mk(sTok, 'Metro', '63.58');
    const textBill = (code, text) => call('POST', 'bills/text', { auth: code, body: { text } });

    r = await call('POST', 'bills/text', { body: { text: METRO_TEXT } });
    ok(r.status === 401, 'a bill from the Shortcut needs the setup code');
    r = await textBill('sp_notarealcodenotarealcodenotarealcode', METRO_TEXT);
    ok(r.status === 401, 'and a wrong setup code is refused');
    r = await textBill(sCode, 'bonjour, ceci nest pas une facture');
    ok(r.status === 422, 'text with no bill in it says so');
    r = await textBill(sCode, METRO_TEXT.replace(/63,58/g, '123,45').replace('58,34', '118,21'));
    ok(r.status === 404 && /123\.45/.test(r.data.error), 'a bill with no matching purchase says what is missing: ' + r.data.error);
    ok(r.data.message === r.data.error, 'and the Shortcut can show that reason, because it is in the message field too');
    const t0 = Date.now();
    r = await call('POST', 'bills/text', { auth: sCode, body: { text: ('LAIT 5,49\n').repeat(20000) } });
    ok(r.status === 404 && Date.now() - t0 < 3000, 'a huge block of text is cut down and handled quickly, not allowed to hang the server (' + (Date.now() - t0) + ' ms)');

    r = await textBill(sCode, METRO_TEXT);
    ok(r.status === 200 && r.data.ok && r.data.merchant === 'Metro' && r.data.items === 8, 'the bill is read and matched to the Metro purchase: ' + JSON.stringify(r.data));
    ok(/unnecessary/.test(r.data.message) && /Open the app/.test(r.data.message) && !/does not match/.test(r.data.message), 'the Shortcut gets a plain message to show: ' + r.data.message);
    r = await call('GET', 'purchases/' + pid + '/items', { auth: sTok });
    ok(r.data.items.length === 0 && r.data.draft && r.data.draft.items.length === 8, 'it waits as a draft, not saved items yet');
    const kinds = Object.fromEntries(r.data.draft.items.map((i) => [i.name.split(' ')[0], i.kind]));
    ok(kinds.LAIT === 'need' && kinds.POULET === 'need' && kinds.CHIPS === 'fun' && kinds['COCA-COLA'] === 'fun' && kinds.BIERE === 'fun', 'items start with a guess: milk and chicken necessary, chips, soda and beer unnecessary');
    ok(r.data.draft.matches === true && r.data.draft.total === 63.58 && r.data.draft.tax === 5.24, 'the items and tax add up to the purchase');
    r = await call('GET', 'purchases', { auth: sTok });
    ok(r.data.find((x) => x.number === pid).draft === true, 'the purchase says a bill is waiting');
    const rawDraft = (await pg.query('select data from bill_drafts where purchase_id = $1', [pid])).rows[0].data;
    ok(/^e1:/.test(rawDraft) && !/LAIT|BIERE|POULET/.test(rawDraft), 'the draft is stored encrypted');
    r = await call('GET', 'purchases/' + pid + '/items', { auth: s2Tok });
    ok(r.status === 404, 'nobody else can see the draft');
    r = await textBill(s2Code, METRO_TEXT);
    ok(r.status === 404, 'another person\'s Shortcut cannot attach a bill to your purchase');

    // the app can name the purchase, so the bill lands on exactly that one even when the totals differ
    const pidSaq = await mk(sTok, 'SAQ', '31.00');
    r = await call('POST', 'bills/text', { auth: sCode, body: { text: METRO_TEXT, purchaseId: pidSaq } });
    ok(r.status === 200 && r.data.merchant === 'SAQ', 'a bill sent with a purchase number goes to that purchase, not the one with the same total: ' + JSON.stringify(r.data));
    r = await call('GET', 'purchases/' + pidSaq + '/items', { auth: sTok });
    ok(r.data.draft && r.data.draft.items.length === 8 && r.data.draft.matches === false, 'and it is flagged as not matching so the person checks it');
    r = await call('GET', 'purchases/' + pid + '/items', { auth: sTok });
    ok(r.data.draft && r.data.draft.items.length === 8, 'the other purchase\'s own draft is untouched');
    r = await call('POST', 'bills/text', { auth: s2Code, body: { text: METRO_TEXT, purchaseId: pidSaq } });
    ok(r.status === 404, 'another person cannot attach a bill to your purchase by number');
    r = await call('POST', 'bills/text', { auth: sCode, body: { text: METRO_TEXT, purchaseId: '12; drop table purchases' } });
    ok(r.status === 400, 'a purchase number that is not a number is refused');
    r = await call('POST', 'bills/text', { auth: sCode, body: { text: METRO_TEXT, purchaseId: 99999999 } });
    ok(r.status === 404, 'and so is one that does not exist');

    // scanning the same bill again replaces the draft instead of piling up
    r = await textBill(sCode, METRO_TEXT);
    ok(r.status === 200 && (await pg.query('select count(*)::int as n from bill_drafts where purchase_id = $1', [pid])).rows[0].n === 1, 'scanning again replaces the draft');

    // saving the items clears the draft, and the next bill starts from what was decided
    r = await call('GET', 'purchases/' + pid + '/items', { auth: sTok });
    const toSave = r.data.draft.items.map((i) => ({ name: i.name, price: i.price, kind: /CHIPS/.test(i.name) ? 'need' : i.kind }));
    r = await call('PUT', 'purchases/' + pid + '/items', { auth: sTok, body: { items: toSave, amount: 63.58 } });
    ok(r.status === 200, 'the person checks the items and saves them');
    r = await call('GET', 'purchases/' + pid + '/items', { auth: sTok });
    ok(r.data.draft === null && r.data.items.length === 8, 'the draft is gone and the items are saved');
    r = await call('GET', 'purchases', { auth: sTok });
    const row = r.data.find((x) => x.number === pid);
    ok(!row.draft && row.bill && row.bill.n === 8, 'the purchase no longer says a bill is waiting, and has its items');
    const pid2 = await mk(sTok, 'IGA', '63.58');
    r = await textBill(sCode, METRO_TEXT);
    ok(r.status === 200, 'a second purchase for the same amount takes the next bill');
    r = await call('GET', 'purchases/' + pid2 + '/items', { auth: sTok });
    ok(r.data.draft && r.data.draft.items.find((i) => /CHIPS/.test(i.name)).kind === 'need', 'it goes to the purchase that has no items yet, and remembers chips as you decided (necessary)');
    await call('DELETE', 'purchases/' + pid2 + '/items', { auth: sTok });
    r = await call('GET', 'purchases/' + pid2 + '/items', { auth: sTok });
    ok(r.data.draft === null, 'a draft can be thrown away');
    await textBill(sCode, METRO_TEXT);
    await pg.query('delete from purchases where id = $1', [pid2]);
    ok((await pg.query('select count(*)::int as n from bill_drafts where purchase_id = $1', [pid2])).rows[0].n === 0, 'deleting a purchase deletes its draft');
    await call('DELETE', 'account', { auth: sTok });
    await call('DELETE', 'account', { auth: s2Tok });
    ok((await pg.query('select count(*)::int as n from bill_drafts')).rows[0].n === 0, 'deleting an account deletes its drafts');
  }

  // ---- pay period: how much of the paycheck is left ----
  {
    const dayAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
    let r = await call('GET', 'pay');
    ok(r.status === 401, 'the pay plan needs a sign-in');
    r = await call('POST', 'auth/signup', { body: { email: 'payer@example.com', password: 'payer-password-1', invite: await invite('Pay', 7) } });
    const pTok = r.data.session;
    r = await call('POST', 'auth/signup', { body: { email: 'payer2@example.com', password: 'payer2-password-1', invite: await invite('Pay2', 7) } });
    const p2Tok = r.data.session;
    const uid = (await pg.query("select id from users where email = 'payer@example.com'")).rows[0].id;
    r = await call('GET', 'pay', { auth: pTok });
    ok(r.status === 200 && r.data.plan === null && r.data.state === null, 'before setup there is no plan');
    const PLAN = { amount: '1,850.00', every: '2 weeks', start: dayAgo(10), bills: [
      { name: 'Rent', amount: 1400, every: 'month', ap: false }, { name: 'Hydro', amount: 90, every: 'month', ap: false },
      { name: 'Phone', amount: 55, every: 'month', ap: true }, { name: '', amount: 0, every: 'month' }] };
    r = await call('PUT', 'pay', { auth: pTok, body: { ...PLAN, amount: 0 } });
    ok(r.status === 400, 'a paycheck of zero is refused: ' + r.data.error);
    r = await call('PUT', 'pay', { auth: pTok, body: { ...PLAN, every: 'daily' } });
    ok(r.status === 400, 'an unknown frequency is refused');
    r = await call('PUT', 'pay', { auth: pTok, body: { ...PLAN, start: dayAgo(-30) } });
    ok(r.status === 400, 'a payday far in the future is refused');
    r = await call('PUT', 'pay', { auth: pTok, body: PLAN });
    ok(r.status === 200 && r.data.plan.amount === 1850 && r.data.plan.bills.length === 0, 'the plan is saved; a bills list sent by an older app is ignored (fixed bills were taken out because they confused people)');
    ok(r.data.state.fixed === 0 && r.data.state.free === 1850 && r.data.state.spent === 0 && r.data.state.left === 1850, 'free to spend starts at the whole paycheck: ' + JSON.stringify(r.data.state));
    ok(r.data.state.daysLeft >= 3 && r.data.state.daysLeft <= 5 && r.data.state.due === false && r.data.state.level === 'good', 'about 4 days to payday');

    // purchases since payday count; the one before it does not
    const buy = async (n, amount) => pg.query("insert into purchases (user_id, title, body, created_at) values ($1, $2, $3, $4)",
      [uid, 'Spending - $' + amount, 'Date: ' + dayAgo(n) + 'T12:00:00Z\nMerchant: Metro\nAmount: $' + amount + '\nCard: Visa\nCategory: Groceries', dayAgo(n) + 'T12:00:00Z']);
    await buy(12, 500); await buy(8, 40); await buy(3, 60.5);
    r = await call('GET', 'pay', { auth: pTok });
    ok(r.data.state.spent === 100.5 && r.data.state.left === 1749.5, 'spending since the last payday is added up (not the one before it): ' + r.data.state.spent);
    await pg.query("insert into purchases (user_id, title, body, created_at) values ($1, $2, $3, $4)", [uid, 'Spending - $90', 'Date: ' + dayAgo(2) + 'T12:00:00Z\nMerchant: Hydro-Quebec\nAmount: $90\nCard: Visa\nCategory: Bills & Utilities', dayAgo(2) + 'T12:00:00Z']);
    r = await call('GET', 'pay', { auth: pTok });
    ok(r.data.state.billsPaid === 90 && r.data.state.otherSpent === 100.5, 'a Hydro payment is counted as a bill you paid, apart from the rest: ' + r.data.state.billsPaid + ' / ' + r.data.state.otherSpent);
    await pg.query("delete from purchases where user_id = $1 and body like '%Hydro-Quebec%'", [uid]);
    await pg.query("update purchases set state = 'closed' where user_id = $1 and created_at::text like $2", [uid, dayAgo(3) + '%']);
    r = await call('GET', 'pay', { auth: pTok });
    ok(r.data.state.spent === 40, 'a deleted purchase is not counted');
    const raw = (await pg.query('select data from pay_plans where user_id = $1', [uid])).rows[0].data;
    ok(/^e1:/.test(raw) && !/Rent|1400|1850/.test(raw), 'the plan is stored encrypted');
    r = await call('GET', 'pay', { auth: p2Tok });
    ok(r.data.plan === null, 'another person does not see it');

    // payday
    r = await call('POST', 'pay/paid', { auth: p2Tok, body: {} });
    ok(r.status === 404, 'getting paid with no plan is refused');
    r = await call('POST', 'pay/paid', { auth: pTok, body: { date: 'tomorrow-ish' } });
    ok(r.status === 400, 'a bad payday date is refused');
    r = await call('POST', 'pay/paid', { auth: pTok, body: { date: dayAgo(12) } });
    ok(r.status === 400, 'a new period cannot start before the last one');
    r = await call('POST', 'pay/paid', { auth: pTok, body: { date: dayAgo(-20) } });
    ok(r.status === 400, 'or in the future');
    r = await call('POST', 'pay/paid', { auth: pTok, body: { amount: 'lots' } });
    ok(r.status === 400, 'a bad amount is refused');
    r = await call('POST', 'pay/paid', { auth: pTok, body: { amount: '1,900' } });
    ok(r.status === 200 && r.data.plan.amount === 1900 && r.data.plan.history.length === 1, 'getting paid starts a new period with the new amount');
    ok(r.data.plan.history[0].spent === 40 && r.data.plan.history[0].left === 1810, 'the finished period is kept: spent 40, ended with 1810: ' + JSON.stringify(r.data.plan.history[0]));
    ok(r.data.state.spent === 0 && r.data.state.last && r.data.state.last.left === 1810, 'the new period starts at zero and remembers how the last one ended');
    r = await call('PUT', 'pay', { auth: pTok, body: { ...PLAN, start: r.data.plan.start, amount: 1900 } });
    ok(r.data.plan.history.length === 1, 'editing the plan keeps its history');
    r = await call('POST', 'pay/paid', { auth: pTok, body: {} });
    ok(r.status === 400, 'getting paid twice on the same day is refused');

    // clean up
    r = await call('DELETE', 'pay', { auth: pTok });
    r = await call('GET', 'pay', { auth: pTok });
    ok(r.data.plan === null, 'the plan can be removed');
    await call('PUT', 'pay', { auth: pTok, body: PLAN });
    await call('DELETE', 'account', { auth: pTok });
    await call('DELETE', 'account', { auth: p2Tok });
    ok((await pg.query('select count(*)::int as n from pay_plans')).rows[0].n === 0, 'deleting an account deletes its pay plan');
  }

  // ---- your own categories ----
  {
    let r = await call('GET', 'categories');
    ok(r.status === 401, 'your categories need a sign-in');
    r = await call('POST', 'auth/signup', { body: { email: 'cats@example.com', password: 'cats-password-1', invite: await invite('Cats', 7) } });
    const cTok = r.data.session;
    r = await call('POST', 'auth/signup', { body: { email: 'cats2@example.com', password: 'cats2-password-1', invite: await invite('Cats2', 7) } });
    const c2Tok = r.data.session;
    const cid = (await pg.query("select id from users where email = 'cats@example.com'")).rows[0].id;
    r = await call('GET', 'categories', { auth: cTok });
    ok(r.status === 200 && r.data.cats.length === 0, 'at first there are none');
    r = await call('PUT', 'categories', { auth: cTok, body: { cats: [{ name: 'Groceries', icon: '🛒', kind: 'need' }] } });
    ok(r.status === 400, 'a name that is already a built-in category is refused: ' + r.data.error);
    r = await call('PUT', 'categories', { auth: cTok, body: { cats: [{ name: 'Rent', icon: '🏠', kind: 'need' }, { name: 'rent', icon: '🏠', kind: 'need' }] } });
    ok(r.status === 400, 'so is the same name twice (any capitals)');
    r = await call('PUT', 'categories', { auth: cTok, body: { cats: [{ name: '', icon: '🏠' }] } });
    ok(r.status === 400, 'and a blank name');
    r = await call('PUT', 'categories', { auth: cTok, body: { cats: Array.from({ length: 21 }, (_, i) => ({ name: 'C' + i, icon: '🏠', kind: 'need' })) } });
    ok(r.status === 400, 'more than 20 is refused');
    r = await call('PUT', 'categories', { auth: cTok, body: { cats: [
      { name: 'Rent', icon: '🏠', kind: 'need' }, { name: 'Phone', icon: '📱', kind: 'need' }, { name: '  Fun   money ', icon: 'not an emoji', kind: 'sometimes' }],
      rules: { rogers: 'Phone', beausoir: 'Nope', '': 'Rent' } } });
    ok(r.status === 200 && r.data.cats.length === 3 && r.data.cats[2].name === 'Fun money' && r.data.cats[2].icon === '🏷️' && r.data.cats[2].kind === 'unk', 'a good list is saved, with names tidied, a bad icon replaced and an unknown kind made "not sure": ' + JSON.stringify(r.data.cats[2]));
    ok(JSON.stringify(r.data.rules) === '{"rogers":"Phone"}', 'a store rule for a category that does not exist is dropped, and so is a blank one');
    const raw = (await pg.query('select data from user_cats where user_id = $1', [cid])).rows[0].data;
    ok(/^e1:/.test(raw) && !/Rent|Phone|rogers/.test(raw), 'the list is stored encrypted');
    r = await call('GET', 'me', { auth: cTok });
    ok(r.data.categories && r.data.categories.cats.length === 3 && r.data.categories.rules.rogers === 'Phone', 'the list also comes with "me", so the app needs no extra call to get it when it opens');
    r = await call('GET', 'categories', { auth: c2Tok });
    ok(r.data.cats.length === 0, 'another person does not see it');

    // they work in the numbers
    const at = new Date().toISOString();
    const add = (merchant, amount, cat, manual) => pg.query("insert into purchases (user_id, title, body, created_at) values ($1, $2, $3, $4)",
      [cid, 'Spending - $' + amount, 'Date: ' + at + '\nMerchant: ' + merchant + '\nAmount: $' + amount + '\nCard: Visa\nCategory: ' + cat + (manual ? '\nEntry: manual' : ''), at]);
    await add('Landlord', 750, 'Rent', true);
    await add('Rogers', 55, 'Bills & Utilities', false);
    await add('Tim Hortons', 4.5, 'Dining & Coffee', false);
    await add('Somewhere', 20, 'Fun money', true);
    const rows = async () => (await hist(cTok, 'range=month&rows=1')).data.rows || [];
    const by = async (m) => (await rows()).find((x) => x.merchant === m);
    let x = await by('Landlord');
    ok(x && x.category === 'Rent' && x.leak === 'need', 'a payment you put in Rent shows as Rent, and as necessary because you said so: ' + JSON.stringify(x && [x.category, x.leak]));
    x = await by('Rogers');
    ok(x && x.category === 'Phone' && x.leak === 'need', 'a store you asked to always go to Phone goes there by itself');
    x = await by('Tim Hortons');
    ok(x && x.category === 'Dining & Coffee', 'other stores are not touched');
    x = await by('Somewhere');
    ok(x && x.category === 'Fun money' && x.leak === 'unk', 'a "not sure" category stays not sure');
    r = await hist(cTok, 'range=month');
    ok(r.data.categories.some((c) => c.category === 'Rent' && c.amount === 750), 'and Rent is in the categories total');
    // payments typed with a category the person does not have stay with the app's own guess
    await add('Mystery', 9, 'Ghost', true);
    x = await by('Mystery');
    ok(x && x.category !== 'Ghost', 'a manual category that does not exist is not invented');
    // delete a category: its payments go back to the app's own guess, nothing is lost
    r = await call('PUT', 'categories', { auth: cTok, body: { cats: [{ name: 'Rent', icon: '🏠', kind: 'need' }], rules: { rogers: 'Phone' } } });
    ok(r.status === 200 && r.data.cats.length === 1 && Object.keys(r.data.rules).length === 0, 'deleting a category also drops its store rules');
    x = await by('Rogers');
    ok(x && x.category === 'Bills & Utilities', 'its payments go back to the app\'s usual guess (Rogers is Bills & Utilities again)');
    ok((await rows()).length >= 5, 'no payment was lost');
    // another person with the same store is unaffected
    r = await call('PUT', 'categories', { auth: c2Tok, body: { cats: [] } });
    ok(r.status === 200, 'someone else can save their own (empty) list');
    await call('DELETE', 'account', { auth: cTok });
    await call('DELETE', 'account', { auth: c2Tok });
    ok((await pg.query('select count(*)::int as n from user_cats')).rows[0].n === 0, 'deleting an account deletes its categories');
  }

  // ---- starting up: the database setup runs once, not on every wake-up ----
  {
    const have = (await pg.query("select value from app_settings where key = 'schema_version'")).rows[0];
    ok(have && have.value === db.SCHEMA_VERSION, 'the database remembers which version of its setup it has');
    let count = 0;
    db.setTestDb(async (t, p) => { count++; return (await pg.query(t, p)).rows; });
    await db.q('select 1 as one');
    ok(count === 2, 'a new instance that finds the current version asks once and then does its work (' + count + ' statements instead of about 20)');
    // a database from before the version marker still gets its setup, including the new column
    await pg.query("delete from app_settings where key = 'schema_version'");
    await pg.query('alter table purchases drop column kind');
    count = 0;
    db.setTestDb(async (t, p) => { count++; return (await pg.query(t, p)).rows; });
    await db.q('select 1 as one');
    const col = (await pg.query("select column_name from information_schema.columns where table_name = 'purchases' and column_name = 'kind'")).rows;
    ok(count > 10 && col.length === 1, 'an older database gets the full setup, including the new column, and the marker is written');
    db.setTestDb(async (t, p) => (await pg.query(t, p)).rows);
    await db.q('select 1 as one');
  }

  // ---- the service worker file must never ship empty (it carries offline support and the alert handlers) ----
  {
    const fs = require('fs'); const path = require('path');
    const sw = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
    ok(sw.length > 1500 && /const CACHE = 'spend-v\d+'/.test(sw), 'the service worker file is present with a cache version');
    ok(["addEventListener('fetch'", "addEventListener('push'", "addEventListener('notificationclick'"].every((x) => sw.includes(x)), 'it handles offline loading, alerts and alert taps');
    const assets = (sw.match(/'\.\/[^']*'/g) || []).map((x) => x.slice(3, -1)).filter(Boolean);
    ok(assets.length > 15 && assets.every((f) => fs.existsSync(path.join(__dirname, '..', 'public', f))), 'every file it saves for offline exists');
  }

  r = await call('GET', 'nope');
  ok(r.status === 404, 'unknown route 404');

  console.log('\nALL PASSED:', pass);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
