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
  ok(!JSON.stringify(r.data).includes('purchase'), 'the list shows no purchase details');
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

  r = await call('GET', 'nope');
  ok(r.status === 404, 'unknown route 404');

  console.log('\nALL PASSED:', pass);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
