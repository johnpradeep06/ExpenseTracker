// Tests of the pay period maths (public/payperiod.js). Run: node test/payperiod.test.js
'use strict';
const assert = require('assert');
const P = require('../public/payperiod');
let pass = 0;
const ok = (c, l) => { assert.ok(c, l); pass++; console.log('  ok', l); };
const eq = (a, b, l) => { assert.deepStrictEqual(a, b, l + ' (got ' + JSON.stringify(a) + ')'); pass++; console.log('  ok', l); };

// dates
eq(P.addDays('2026-11-06', 14), '2026-11-20', 'two weeks after Nov 6 is Nov 20');
eq(P.addDays('2026-12-25', 10), '2027-01-04', 'dates roll over the year end');
eq(P.addMonths('2026-01-31', 1), '2026-02-28', 'a month after Jan 31 is the end of February, not March');
eq(P.addMonths('2028-01-31', 1), '2028-02-29', 'and the 29th in a leap year');
eq(P.addMonths('2026-12-15', 1), '2027-01-15', 'a month after Dec 15 is Jan 15');
eq(P.daysBetween('2026-11-15', '2026-11-20'), 5, 'five days from Nov 15 to Nov 20');
eq(P.daysBetween('2026-03-07', '2026-03-09'), 2, 'clock changes do not move a day (Mar 7 to 9)');
eq(P.nextPayday('2026-11-06', '2 weeks'), '2026-11-20', 'next payday for every 2 weeks');
eq(P.nextPayday('2026-11-06', 'week'), '2026-11-13', 'next payday for every week');
eq(P.nextPayday('2026-11-06', 'month'), '2026-12-06', 'next payday for every month');
ok(P.parse('2026-02-30') === null && P.parse('nope') === null && P.parse('2026-11-06') !== null, 'bad dates are refused');

// bills spread over the paychecks of a year
eq(P.billShare({ amount: 1400, every: 'month' }, '2 weeks'), 646.15, 'rent of $1,400 a month takes $646.15 from a paycheck every 2 weeks');
eq(P.billShare({ amount: 70, every: '2 weeks' }, '2 weeks'), 70, 'a bill every 2 weeks takes its whole amount');
eq(P.billShare({ amount: 30, every: 'week' }, '2 weeks'), 60, 'a weekly bill takes two weeks of it');
eq(P.billShare({ amount: 520, every: 'year' }, '2 weeks'), 20, 'a yearly bill is a 26th of it');
eq(P.billShare({ amount: 100, every: 'month' }, 'month'), 100, 'a monthly bill on a monthly paycheck is whole');

// the example from the mockup
const plan = { amount: 1850, every: '2 weeks', start: '2026-11-06', bills: [
  { name: 'Rent', amount: 1400, every: 'month', ap: false }, { name: 'Hydro', amount: 90, every: 'month', ap: false },
  { name: 'Internet', amount: 70, every: 'month', ap: false }, { name: 'Phone', amount: 55, every: 'month', ap: false }] };
eq(P.fixedTotal(plan), 745.38, 'the four bills take $745.38 from each paycheck');
const rows = [{ day: '2026-11-05', amount: 500 }, { day: '2026-11-06', amount: 300 }, { day: '2026-11-10', amount: 340 }];
let s = P.stateOf(plan, rows, '2026-11-15');
eq([s.free, s.spent, s.left, s.daysLeft, s.next], [1104.62, 640, 464.62, 5, '2026-11-20'], 'free 1104.62, spent 640 since payday (not the day before), left 464.62, 5 days to go');
eq(s.perDay, 92.92, 'about $92.92 a day to make it to payday');
eq(s.level, 'good', 'plenty left is good');
eq(s.due, false, 'payday has not come yet');

// tight and over
s = P.stateOf(plan, rows.concat([{ day: '2026-11-12', amount: 400 }]), '2026-11-15');
eq(s.level, 'warn', 'spending faster than the days left allow is a warning');
ok(s.runsOutIn !== null && s.runsOutIn < s.daysLeft, 'and says when the money would run out');
s = P.stateOf(plan, rows.concat([{ day: '2026-11-12', amount: 700 }]), '2026-11-15');
eq([s.left, s.level, s.perDay], [-235.38, 'bad', 0], 'spending past what is free is over: negative, no daily amount');
s = P.stateOf({ ...plan, bills: [{ name: 'Rent', amount: 5000, every: 'month', ap: false }] }, [], '2026-11-15');
eq(s.level, 'bad', 'bills bigger than the paycheck is over from the start');

// payday
s = P.stateOf(plan, rows, '2026-11-20');
eq([s.due, s.daysLeft], [true, 0], 'on payday it asks "did you get paid"');
s = P.stateOf(plan, rows, '2026-11-23');
eq([s.due, s.daysLeft, s.spent], [true, 0, 640], 'days after payday it still asks, and keeps counting the old period');
s = P.stateOf(plan, [{ day: '2026-11-06', amount: 10 }, { day: '2026-11-07', amount: -4 }], '2026-11-06');
eq([s.spent, s.elapsed], [6, 1], 'a refund takes money back off, and the first day counts as day 1');

// the part of spending that is already a bill
s = P.stateOf(plan, rows.concat([{ day: '2026-11-08', amount: 120, category: 'Bills & Utilities' }, { day: '2026-11-03', amount: 99, category: 'Bills & Utilities' }, { day: '2026-11-09', amount: 10, category: 'Groceries' }]), '2026-11-15');
eq([s.billsPaid, s.otherSpent, s.spent], [120, 650, 770], 'Bills & Utilities purchases since payday are shown on their own (not the one before payday), and the rest is "other spending"');
eq(P.stateOf(plan, rows, '2026-11-15').billsPaid, 0, 'with none, the bills part is zero');

// bills paid with Apple Pay are not taken off up front
const ap = { ...plan, bills: [{ name: 'Rent', amount: 1400, every: 'month', ap: true }, { name: 'Hydro', amount: 90, every: 'month', ap: false }] };
eq(P.fixedTotal(ap), 41.54, 'a bill paid with Apple Pay is left out of the up-front total');

// getting paid
let next = P.rollOver(plan, rows.concat([{ day: '2026-11-19', amount: 100 }]), '2026-11-20', 1900);
eq([next.start, next.amount, next.history.length], ['2026-11-20', 1900, 1], 'a new period starts on the day paid, with the new amount');
eq([next.history[0].spent, next.history[0].left], [740, 364.62], 'the finished period is kept: what it spent and what it ended with');
s = P.stateOf(next, [], '2026-11-20');
eq([s.last.left, s.spent, s.daysLeft], [364.62, 0, 14], 'the new period starts at zero with 14 days, and remembers how the last one ended');
let many = plan;
for (let i = 0; i < 15; i++) many = P.rollOver(many, [], P.addDays(many.start, 14), undefined);
eq(many.history.length, 12, 'only the last 12 periods are kept');

// what a person sends
let c = P.clean({ amount: '1,850.00', every: '2 weeks', start: '2026-11-06', bills: [{ name: ' Rent ', amount: '1400', every: 'month', ap: true }, { name: '', amount: 0, every: 'month' }] }, '2026-11-15');
eq([c.plan.amount, c.plan.bills.length, c.plan.bills[0].name, c.plan.bills[0].ap], [1850, 1, 'Rent', true], 'a typed paycheck is read, a blank bill row is dropped');
ok(P.clean({ amount: 0, every: '2 weeks', start: '2026-11-06' }, '2026-11-15').error, 'a zero paycheck is refused');
ok(P.clean({ amount: 100, every: 'daily', start: '2026-11-06' }, '2026-11-15').error, 'an unknown frequency is refused');
ok(P.clean({ amount: 100, every: 'week', start: '2027-01-01' }, '2026-11-15').error, 'a payday in the future is refused');
ok(P.clean({ amount: 100, every: 'week', start: '2024-01-01' }, '2026-11-15').error, 'a payday years ago is refused');
ok(P.clean({ amount: 100, every: 'week', start: '2026-11-06', bills: [{ name: 'X', amount: 'abc', every: 'month' }] }, '2026-11-15').error, 'a bill with a bad amount is refused');
ok(P.clean({ amount: 100, every: 'week', start: '2026-11-06', bills: [{ name: 'X', amount: 5, every: 'sometimes' }] }, '2026-11-15').error, 'a bill with an unknown frequency is refused');
c = P.clean({ amount: 100, every: 'week', start: '2026-11-06', bills: [{ name: 'A'.repeat(200), amount: 5, every: 'month', evil: 1 }] }, '2026-11-15');
eq([c.plan.bills[0].name.length, Object.keys(c.plan.bills[0]).sort().join()], [40, 'amount,ap,every,name'], 'names are cut short and only known fields are kept');

console.log('\nALL PASSED:', pass);
