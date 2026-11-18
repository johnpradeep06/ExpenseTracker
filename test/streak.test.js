// Tests of the streak rules (public/streak.js). Run: node test/streak.test.js
'use strict';
const assert = require('assert');
const S = require('../public/streak');
let pass = 0;
const eq = (a, b, l) => { assert.deepStrictEqual(a, b, l + ' (got ' + JSON.stringify(a) + ')'); pass++; console.log('  ok', l); };
const ok = (c, l) => { assert.ok(c, l); pass++; console.log('  ok', l); };
const days = (start, amounts) => Object.fromEntries(amounts.map((a, i) => [S.addDays(start, i), a]));

// 2026-11-18 is a Wednesday. Its week starts Monday 2026-11-16.
eq(S.weekOf('2026-11-18'), '2026-11-16', 'a Wednesday belongs to the week starting Monday');
eq(S.weekOf('2026-11-22'), '2026-11-16', 'and so does that Sunday');
eq(S.weekOf('2026-11-23'), '2026-11-23', 'the next Monday starts a new week');

eq(S.compute({}, 0, '2026-11-18').active, false, 'no limit set: no streak');
let r = S.compute(days('2026-11-10', [30, 40, 20, 10, 5, 45, 12, 8, 3]), 50, '2026-11-18');
eq([r.count, r.broke, r.todayOver], [8, null, false], 'eight days under the limit, today not counted yet');
eq(r.week.map((w) => w.status), ['ok', 'ok', 'ok', 'ok', 'ok', 'ok', 'today'], 'the week row shows today as still in progress');
eq(r.skipLeft, 1, 'a free skip is still available');

// one bad day is forgiven, two in one week break it
r = S.compute(days('2026-11-10', [30, 40, 90, 10, 5, 45, 12, 8, 3]), 50, '2026-11-18');
eq([r.count, r.broke], [7, null], 'one over-limit day (Nov 12) is forgiven: it adds nothing but does not break the streak');
eq(r.week.map((w) => w.status), ['skip', 'ok', 'ok', 'ok', 'ok', 'ok', 'today'], 'the week row marks the forgiven day (Nov 12) as a skip')
// Mon 16: 12 ok, Tue 17: 8 ok, Wed 18 today 3 ok -> make Mon and Tue both over
r = S.compute(days('2026-11-10', [30, 40, 20, 10, 5, 45, 90, 80, 3]), 50, '2026-11-18');
eq([r.count, r.broke && r.broke.day, r.broke && r.broke.over], [0, '2026-11-17', 30], 'two over-limit days in one week: the first (Mon) is forgiven, the second (Tue) breaks it');
eq(r.broke.was, 6, 'and it remembers the streak it broke: 6 days');
eq(r.skipLeft, 0, 'the skip for this week is used up');

// today going over
r = S.compute(days('2026-11-10', [30, 40, 20, 10, 5, 45, 12, 8, 70]), 50, '2026-11-18');
eq([r.count, r.todayOver, r.week[6].status, r.skipLeft], [8, true, 'skip', 0], 'going over today uses this week\'s skip, so the streak survives');
r = S.compute(days('2026-11-10', [30, 40, 20, 10, 5, 45, 90, 8, 70]), 50, '2026-11-18');
eq([r.count, r.broke && r.broke.day, r.broke && r.broke.was], [0, '2026-11-18', 7], 'but going over a second time in the week breaks it today, and remembers the 7 days it broke');

// new people: only days since the first purchase count
r = S.compute({ '2026-11-17': 20 }, 50, '2026-11-18');
eq(r.count, 1, 'a person with one day of history has a streak of 1, not 28');
eq(r.week.map((w) => w.status).slice(0, 5), ['none', 'none', 'none', 'none', 'none'], 'days before the first purchase are blank');
r = S.compute({}, 50, '2026-11-18');
eq([r.active, r.count], [true, 0], 'no purchases at all: active but nothing to count');

// the 28 day window
const all = {}; for (let i = 0; i < 40; i++) all[S.addDays('2026-10-10', i)] = 10;
r = S.compute(all, 50, '2026-11-18');
eq([r.count, r.capped], [27, true], 'a full window is capped (27 finished days + today in progress) and says so');
ok(S.MILESTONES.join() === '3,7,14,28', 'milestones are 3, 7, 14 and 28 days');
console.log('\nALL PASSED: ' + pass);
