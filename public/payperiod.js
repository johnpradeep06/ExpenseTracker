/* Pay period: how much of a paycheck is left to spend. Pure date and money maths, no network: the server loads this file
   to do the sums, and the tests check them. Dates are plain "YYYY-MM-DD" strings (the person's own calendar days), so no
   time zone can shift a payday by a day.

   free to spend = paycheck - fixed bills (rent, utilities...) - what was spent since the last payday.
   A bill is spread over the paychecks of a year (a monthly bill is 12 a year, a paycheck every 2 weeks is 26 a year),
   so the daily number stays steady instead of one period carrying the whole rent. A bill marked "paid with Apple Pay"
   is not taken off up front: it counts as spending when it is actually paid. */
(function () {
  const PAY_EVERY = ['week', '2 weeks', 'month'];
  const BILL_EVERY = ['week', '2 weeks', 'month', 'year'];
  const PERIODS_PER_YEAR = { week: 52, '2 weeks': 26, month: 12 };
  const BILLS_PER_YEAR = { week: 52, '2 weeks': 26, month: 12, year: 1 };
  const DAY = 86400000;
  const BILLS_CATEGORY = 'Bills & Utilities';
  const r2 = (n) => Math.round(n * 100) / 100;
  const p2 = (n) => (n < 10 ? '0' : '') + n;

  const parse = (s) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    const d = new Date(ms);
    return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? ms : null;
  };
  const fmt = (ms) => { const d = new Date(ms); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()); };
  const addDays = (s, n) => fmt(parse(s) + n * DAY);
  const addMonths = (s, n) => {
    const d = new Date(parse(s));
    const y = d.getUTCFullYear();
    const m = d.getUTCMonth() + n;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return fmt(Date.UTC(y, m, Math.min(d.getUTCDate(), last)));
  };
  const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / DAY);
  const nextPayday = (start, every) => (every === 'week' ? addDays(start, 7) : every === '2 weeks' ? addDays(start, 14) : addMonths(start, 1));

  // What one bill takes out of one paycheck.
  const billShare = (bill, every) => r2((Number(bill.amount) || 0) * BILLS_PER_YEAR[bill.every] / PERIODS_PER_YEAR[every]);
  const fixedTotal = (plan) => r2((plan.bills || []).filter((b) => !b.ap).reduce((s, b) => s + billShare(b, plan.every), 0));

  const spentBetween = (rows, from, to) => r2((rows || []).filter((r) => r && r.day >= from && (to === undefined || r.day < to)).reduce((s, r) => s + (Number(r.amount) || 0), 0));

  // The numbers for today. rows: [{ day: 'YYYY-MM-DD', amount }] (refunds are negative).
  const stateOf = (plan, rows, today) => {
    const next = nextPayday(plan.start, plan.every);
    const due = today >= next;
    const daysLeft = due ? 0 : daysBetween(today, next);
    const elapsed = Math.max(1, daysBetween(plan.start, today) + 1);
    const spent = spentBetween(rows, plan.start);
    // Of what was spent, the part that is already a bill (a Bills & Utilities purchase: hydro, phone, internet...).
    const billsPaid = spentBetween((rows || []).filter((r) => r && r.category === BILLS_CATEGORY), plan.start);
    const fixed = fixedTotal(plan);
    const free = r2((Number(plan.amount) || 0) - fixed);
    const left = r2(free - spent);
    const usual = r2(spent / elapsed);
    const perDay = daysLeft > 0 ? r2(Math.max(0, left) / daysLeft) : 0;
    let level = 'good';
    if (left < 0 || free <= 0) level = 'bad';
    else if (left < free * 0.1 || (daysLeft > 0 && usual > 0 && usual * daysLeft > left)) level = 'warn';
    const last = (plan.history || [])[(plan.history || []).length - 1] || null;
    return {
      start: plan.start, next, due, daysLeft, elapsed, length: daysBetween(plan.start, next),
      amount: r2(Number(plan.amount) || 0), fixed, free, spent, billsPaid, otherSpent: r2(spent - billsPaid), left, perDay, usual,
      pct: free > 0 ? Math.max(0, Math.min(100, Math.round(spent / free * 100))) : 100,
      runsOutIn: usual > 0 && left > 0 ? Math.round(left / usual * 10) / 10 : null,
      level, last: last ? { start: last.start, end: last.end, left: last.left } : null
    };
  };

  // Payday came: the finished period goes into the history and a new one starts on the day the person was paid.
  const rollOver = (plan, rows, date, amount) => {
    const spent = spentBetween(rows, plan.start, date);
    const free = r2((Number(plan.amount) || 0) - fixedTotal(plan));
    const history = (plan.history || []).concat([{ start: plan.start, end: date, free, spent, left: r2(free - spent) }]).slice(-12);
    return { ...plan, start: date, amount: amount === undefined ? plan.amount : amount, history };
  };

  const money = (v, max) => {
    const n = typeof v === 'number' ? v : Number(String(v === undefined || v === null ? '' : v).replace(/[\s$,]/g, ''));
    return isFinite(n) && n >= 0 && n <= max ? r2(n) : null;
  };
  const text = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);

  // Checks what a person sent and returns a plan with only known fields, or { error }. today: 'YYYY-MM-DD'.
  const clean = (input, today) => {
    const b = input || {};
    const amount = money(b.amount, 1000000);
    if (amount === null || amount <= 0) return { error: 'Enter what you get paid each time' };
    if (PAY_EVERY.indexOf(b.every) < 0) return { error: 'Choose how often you are paid' };
    if (!parse(b.start)) return { error: 'Choose the day you were last paid' };
    if (b.start > addDays(today, 1)) return { error: 'The last payday cannot be in the future' };
    if (b.start < addDays(today, -400)) return { error: 'That payday is too long ago. Choose a more recent one' };
    const list = Array.isArray(b.bills) ? b.bills.slice(0, 40) : [];
    const bills = [];
    for (const it of list) {
      const name = text(it && it.name, 40);
      const a = money(it && it.amount, 1000000);
      if (!name && !(a > 0)) continue;      // a blank row left in the list is dropped, not an error
      if (!name) return { error: 'Give each bill a name' };
      if (a === null) return { error: 'Check the amount of ' + name };
      if (BILL_EVERY.indexOf(it.every) < 0) return { error: 'Choose how often ' + name + ' is due' };
      bills.push({ name, amount: a, every: it.every, ap: it.ap === true });
    }
    return { plan: { amount, every: b.every, start: b.start, bills } };
  };

  const api = { PAY_EVERY, BILL_EVERY, parse, fmt, addDays, addMonths, daysBetween, nextPayday, billShare, fixedTotal, stateOf, rollOver, clean, money };
  if (typeof window !== 'undefined') window.spendPay = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
