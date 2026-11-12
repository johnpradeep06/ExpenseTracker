'use strict';
// Works out the app's numbers on the server with the app's own files (runtime.js, calcs.js, loader.js),
// so alerts always agree with what the app shows.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = path.join(__dirname, '..', 'public');
const FILES = ['runtime.js', 'calcs.js', 'loader.js'].map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]);

const fresh = () => {
  const ctx = {
    console,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { querySelectorAll: () => [] },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    fetch: () => Promise.reject(new Error('no network on the server'))
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const [name, code] of FILES) vm.runInContext(code, ctx, { filename: name });
  return ctx;
};

// Runs fn with the clock set to a time zone. Everything inside is synchronous, so no other request can see it.
const inZone = (tz, fn) => {
  const before = process.env.TZ;
  process.env.TZ = tz || 'America/Toronto';
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
};

// issues: [{ number, title, body, created_at }] for the last 29 days. Returns the same numbers the app uses.
const numbers = (issues, tz, now) => inZone(tz, () => {
  const ctx = fresh();
  ctx.dash.computeNow(ctx.window.spendRows(issues, now || Date.now()));
  const get = (id) => {
    const d = ctx.dash.data(id);
    if (d.status !== 'ok') throw new Error(id + ' could not be worked out: ' + d.message);
    return JSON.parse(JSON.stringify(d.data));
  };
  const p = (n) => (n < 10 ? '0' : '') + n;
  const d = new Date(now || Date.now());
  const y = new Date(d.getTime());
  y.setDate(y.getDate() - 1);
  return {
    spend: get('spend'),
    kpi: get('kpi')[0],
    byDay: get('by_day'),
    today: d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()),
    yesterday: y.getFullYear() + '-' + p(y.getMonth() + 1) + '-' + p(y.getDate()),
    hour: d.getHours()
  };
});

// ---- history: one chosen period against the period to compare it with -------------------------------------------
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYMS = 86400000;
const ymd = (d) => { const p = (n) => (n < 10 ? '0' : '') + n; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
const parseYmd = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null; };
const RANGES = ['week', 'month', '3m', 'year', 'all'];

// Work out the dates for a range ('week', 'month', '3m', 'year', 'all') around an anchor day, in the person's time zone.
// A period still in progress is compared with the same number of days of the one before ("same days").
const rangeFor = (range, anchor, tz, nowMs) => inZone(tz, () => {
  const now = new Date(nowMs || Date.now());
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const a0 = parseYmd(anchor) || new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let start, end, prevStart, title, short;
  if (range === 'week') {
    const dow = (a0.getDay() + 6) % 7; // Monday first
    start = new Date(a0.getFullYear(), a0.getMonth(), a0.getDate() - dow);
    end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
    prevStart = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 7);
    const last = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1);
    title = MONTHS[start.getMonth()].slice(0, 3) + ' ' + start.getDate() + ' – ' + (last.getMonth() === start.getMonth() ? '' : MONTHS[last.getMonth()].slice(0, 3) + ' ') + last.getDate();
    short = 'last week';
  } else if (range === 'month') {
    start = new Date(a0.getFullYear(), a0.getMonth(), 1);
    end = new Date(a0.getFullYear(), a0.getMonth() + 1, 1);
    prevStart = new Date(a0.getFullYear(), a0.getMonth() - 1, 1);
    title = MONTHS[start.getMonth()] + ' ' + start.getFullYear();
    short = MONTHS[prevStart.getMonth()];
  } else if (range === '3m') {
    start = new Date(a0.getFullYear(), a0.getMonth() - 2, 1);
    end = new Date(a0.getFullYear(), a0.getMonth() + 1, 1);
    prevStart = new Date(a0.getFullYear(), a0.getMonth() - 5, 1);
    title = MONTHS[start.getMonth()].slice(0, 3) + ' – ' + MONTHS[end.getMonth() === 0 ? 11 : end.getMonth() - 1].slice(0, 3) + ' ' + a0.getFullYear();
    short = 'the 3 months before';
  } else if (range === 'year') {
    start = new Date(a0.getFullYear(), 0, 1);
    end = new Date(a0.getFullYear() + 1, 0, 1);
    prevStart = new Date(a0.getFullYear() - 1, 0, 1);
    title = String(start.getFullYear());
    short = String(prevStart.getFullYear());
  } else {
    start = new Date(2000, 0, 1);
    end = tomorrow;
    prevStart = null;
    title = 'All time';
    short = '';
  }
  const inProgress = end > tomorrow;
  const effEnd = inProgress ? tomorrow : end;
  let prevEnd = null;
  if (prevStart) {
    const days = Math.round((effEnd - start) / DAYMS);
    prevEnd = new Date(prevStart.getFullYear(), prevStart.getMonth(), prevStart.getDate() + days);
    if (prevEnd > start) prevEnd = start;
  }
  const nextStart = end;
  return {
    start: start.toISOString(), end: effEnd.toISOString(),
    prevStart: prevStart ? prevStart.toISOString() : null, prevEnd: prevEnd ? prevEnd.toISOString() : null,
    inProgress, title, prevLabel: short,
    days: Math.max(1, Math.round((effEnd - start) / DAYMS)),
    startDay: ymd(start), endDay: ymd(new Date(effEnd.getFullYear(), effEnd.getMonth(), effEnd.getDate() - 1)), today: ymd(now),
    prevAnchor: prevStart && range !== 'all' ? ymd(prevStart) : null,
    nextAnchor: range !== 'all' && nextStart <= tomorrow && nextStart < tomorrow ? ymd(nextStart) : null
  };
});

// issuesNow / issuesPrev: [{ number, title, body, created_at }] for the chosen period and the one to compare with.
const summary = (issuesNow, issuesPrev, tz, nowMs, withRows, withDaily) => inZone(tz, () => {
  const ctx = fresh();
  ctx.dash.computeNow(ctx.window.spendRowsFrom(issuesNow, issuesPrev));
  const d = ctx.dash.data('spend');
  if (d.status !== 'ok') throw new Error('spend could not be worked out: ' + d.message);
  const spend = JSON.parse(JSON.stringify(d.data));
  const cur = spend.filter((r) => r.period === 'now');
  const prev = spend.filter((r) => r.period === 'prev');
  const r2 = (v) => Math.round(v * 100) / 100;
  const sum = (a) => r2(a.reduce((s, r) => s + r.amount, 0));
  const group = (rows, keyOf) => {
    const m = new Map();
    rows.forEach((r) => {
      const k = keyOf(r);
      const g = m.get(k) || { amount: 0, count: 0 };
      g.amount += r.amount;
      g.count += 1;
      m.set(k, g);
    });
    return m;
  };
  const posTotal = (m) => [...m.values()].filter((g) => g.amount > 0).reduce((s, g) => s + g.amount, 0);
  const prevCat = group(prev, (r) => r.category);
  const catMap = group(cur, (r) => r.category);
  const catTotal = posTotal(catMap);
  const categories = [...catMap.entries()].filter(([, g]) => g.amount > 0).map(([category, g]) => {
    const merchants = [...group(cur.filter((r) => r.category === category), (r) => r.merchant).entries()]
      .filter(([, x]) => x.amount > 0).sort((a, b) => b[1].amount - a[1].amount).slice(0, 5)
      .map(([merchant, x]) => ({ merchant, amount: r2(x.amount), count: x.count }));
    const before = (prevCat.get(category) || { amount: 0 }).amount;
    return { category, amount: r2(g.amount), count: g.count, share: catTotal > 0 ? g.amount / catTotal : 0, prevAmount: r2(before), change: before > 0 ? (g.amount - before) / before : null, merchants };
  }).sort((a, b) => b.amount - a.amount);
  const cardMap = group(cur, (r) => r.card || '');
  const cardTotal = posTotal(cardMap);
  const cards = [...cardMap.entries()].filter(([, g]) => g.amount > 0)
    .map(([card, g]) => ({ card, amount: r2(g.amount), count: g.count, share: cardTotal > 0 ? g.amount / cardTotal : 0 })).sort((a, b) => b.amount - a.amount);
  const merchants = [...group(cur, (r) => r.merchant).entries()].filter(([, g]) => g.amount > 0)
    .map(([merchant, g]) => ({ merchant, amount: r2(g.amount), count: g.count })).sort((a, b) => b.amount - a.amount).slice(0, 8);
  // Month by month, each month split by category (drawn as stacked bars).
  const monthly = new Map();
  cur.forEach((r) => {
    const key = String(r.day || '').slice(0, 7);
    if (!key) return;
    const m = monthly.get(key) || { total: 0, byCat: {} };
    m.total += r.amount;
    m.byCat[r.category] = (m.byCat[r.category] || 0) + r.amount;
    monthly.set(key, m);
  });
  const months = [...monthly.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, m]) => ({ key, total: r2(m.total), byCat: Object.fromEntries(Object.entries(m.byCat).filter(([, v]) => v > 0).map(([k, v]) => [k, r2(v)])) }));
  const out = { total: sum(cur), count: cur.length, prevTotal: sum(prev), prevCount: prev.length, categories, cards, merchants, months };
  // The individual purchases (for the calendar, chart and list of a week or month). Newest first, capped.
  // Total for each day (3 months and year), for the heatmap of every day.
  if (withDaily) {
    const dm = {};
    cur.forEach((r) => { if (r.day) dm[r.day] = r2((dm[r.day] || 0) + r.amount); });
    out.daily = dm;
  }
  if (withRows) out.rows = cur.slice(0, 3000).map((r) => ({ id: r.id, ts: r.ts, day: r.day, merchant: r.merchant, card: r.card, amount: r.amount, category: r.category, dupIds: r.dupIds || [] }));
  return out;
});

// ---- forecast: where this month is heading -----------------------------------------------------------------------
const { forecastMonth } = require('./forecast');
const hashOf = (str) => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

// issues: purchases from (at least) the person's first day up to now. sinceMs: the first day to learn from (when they joined).
const forecast = (issues, tz, nowMs, sinceMs) => inZone(tz, () => {
  const ctx = fresh();
  ctx.dash.computeNow(ctx.window.spendRowsFrom(issues, []));
  const d = ctx.dash.data('spend');
  if (d.status !== 'ok') throw new Error('spend could not be worked out: ' + d.message);
  const byDay = new Map();
  d.data.forEach((r) => { if (r.day) byDay.set(r.day, (byDay.get(r.day) || 0) + r.amount); });
  const now = new Date(nowMs || Date.now());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayKey = ymd(today);
  // the learning window starts when they started (at most 120 days back) and ends yesterday
  const joined = new Date(sinceMs || nowMs);
  const earliest = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 120);
  let start = new Date(joined.getFullYear(), joined.getMonth(), joined.getDate());
  // purchases imported from before they joined count too: learn from the earliest day we know about
  [...byDay.keys()].forEach((k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k); if (m) { const dd = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])); if (dd < start) start = dd; } });
  if (start < earliest) start = earliest;
  const daily = [];
  for (let t = new Date(start); t < today; t = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1)) daily.push(byDay.get(ymd(t)) || 0);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  let spentBefore = 0;
  for (let t = new Date(monthStart); t < today; t = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1)) spentBefore += byDay.get(ymd(t)) || 0;
  const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const remaining = monthEnd.getDate() - today.getDate();
  return forecastMonth({ daily, todaySoFar: Math.max(0, byDay.get(todayKey) || 0), remaining, spentBefore, seed: hashOf(todayKey + ':' + daily.length + ':' + Math.round(daily.reduce((a, b) => a + b, 0))) });
});

module.exports = { numbers, inZone, summary, rangeFor, forecast, RANGES };
