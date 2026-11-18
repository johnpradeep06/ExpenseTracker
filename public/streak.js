/* Days under your limit: the streak. Pure date and money maths, no network and no screen, so a test can check every
   rule. Dates are plain "YYYY-MM-DD" strings (your own calendar days).

   Rules, in plain words:
   - A day counts when you spent no more than your daily limit (a day with no purchases counts too).
   - Today is not counted until it is over, but it can break the streak the moment you go past the limit.
   - One over-limit day each calendar week (Monday to Sunday) is forgiven automatically, like a rest day. It keeps the
     streak alive but adds nothing to it. A second over-limit day in the same week breaks the streak.
   - Only the days the app has (the last 28) are counted, and days before your first purchase are not counted. */
(function () {
  const DAY = 86400000;
  const WINDOW = 28;
  const p2 = (n) => (n < 10 ? '0' : '') + n;
  const parse = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null; };
  const fmt = (ms) => { const d = new Date(ms); return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()); };
  const addDays = (s, n) => fmt(parse(s) + n * DAY);
  // The Monday of the week a day is in: the week one skip belongs to.
  const weekOf = (s) => { const dow = (new Date(parse(s)).getUTCDay() + 6) % 7; return addDays(s, -dow); };
  const r2 = (n) => Math.round(n * 100) / 100;

  // byDay: { 'YYYY-MM-DD': amount spent that day }. limit: dollars a day (0 or less means no limit set).
  const compute = (byDay, limit, today) => {
    const lim = Number(limit) || 0;
    const t = parse(today);
    if (!(lim > 0) || t === null) return { active: false, count: 0, broke: null, week: [], skipLeft: 1, capped: false, todayOver: false, todayLeft: 0 };
    const spent = (d) => r2(Number(byDay && byDay[d]) || 0);
    const known = Object.keys(byDay || {}).filter((d) => parse(d) !== null && parse(d) <= t && spent(d) !== 0).sort();
    const windowStart = addDays(today, -(WINDOW - 1));
    const first = known.length ? (known[0] > windowStart ? known[0] : windowStart) : today;
    const todayOver = spent(today) > lim;

    // Label every day from the first one up to today, oldest first: under the limit, over it and forgiven (the first
    // over-limit day of a calendar week), or over it with no skip left (the streak ends there).
    const label = {};
    const usedWeek = {};
    for (let d = first; parse(d) <= parse(today); d = addDays(d, 1)) {
      if (spent(d) <= lim) { label[d] = d === today ? 'today' : 'ok'; continue; }
      const wk = weekOf(d);
      if (!usedWeek[wk]) { usedWeek[wk] = true; label[d] = 'skip'; } else label[d] = 'bad';
    }
    // Counts the days under the limit going back from `from`, stopping at the first day that broke the streak.
    const run = (from) => {
      let count = 0;
      for (let d = from; parse(d) >= parse(first); d = addDays(d, -1)) {
        if (label[d] === 'bad') return { count, broke: d };
        if (label[d] === 'ok') count++;
      }
      return { count, broke: null };
    };
    const now = run(today);
    let broke = null;
    if (now.broke) broke = { day: now.broke, over: r2(spent(now.broke) - lim), was: run(addDays(now.broke, -1)).count };
    const week = [];
    for (let i = 6; i >= 0; i--) {
      const d = addDays(today, -i);
      const s = label[d] || 'none';
      week.push({ day: d, status: s });
    }
    const skipLeft = usedWeek[weekOf(today)] ? 0 : 1;
    const capped = !now.broke && parse(first) <= parse(windowStart);
    return { active: true, count: now.count, broke, week, skipLeft, capped, todayOver, todayLeft: r2(lim - spent(today)) };
  };

  const api = { compute, weekOf, addDays, WINDOW, MILESTONES: [3, 7, 14, 28] };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else window.spendStreak = api;
})();
