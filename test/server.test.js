// End-to-end tests of the server against an in-memory Postgres. Run: TZ=UTC node test/server.test.js
'use strict';
const assert = require('assert');

(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = new PGlite();
  const db = require('../lib/db');
  db.setTestDb(async (t, p) => (await pg.query(t, p)).rows);

  process.env.SESSION_SECRET = 'test-secret-'.repeat(4);
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
