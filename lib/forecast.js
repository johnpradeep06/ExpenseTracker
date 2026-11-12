'use strict';
// Month-end spending forecast.
// With 21 or more days of history it fits a Holt-Winters time-series model (level, a little trend and a weekly pattern,
// so a typical Friday or Saturday counts for more than a Tuesday), forecasts every remaining day, and simulates many
// possible months from the model's own past errors to give a range. With less history it uses the median day instead.
// Pure functions, no dependencies, so the same numbers come out in tests.

const M = 7;

const mean = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))] : 0);
const sortedCopy = (a) => a.slice().sort((x, y) => x - y);
const r2 = (v) => Math.round(v * 100) / 100;

// A small, repeatable random number generator, so a forecast does not change between two calls with the same data.
const rng = (seed) => {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
};

// Fit additive Holt-Winters with weekly seasonality to y. Returns the final state and the one-step errors.
const fit = (y, a, b, g) => {
  const n = y.length;
  const seasons = Math.floor(n / M);
  let level = mean(y.slice(0, M));
  let trend = seasons >= 2 ? (mean(y.slice(M, 2 * M)) - mean(y.slice(0, M))) / M : 0;
  const s = [];
  for (let i = 0; i < M; i++) s.push(y[i] - level);
  const errors = [];
  let sse = 0;
  for (let t = M; t < n; t++) {
    const i = t % M;
    const f = level + trend + s[i];
    const e = y[t] - f;
    errors.push(e);
    sse += e * e;
    const lNew = a * (y[t] - s[i]) + (1 - a) * (level + trend);
    trend = b * (lNew - level) + (1 - b) * trend;
    s[i] = g * (y[t] - lNew) + (1 - g) * s[i];
    level = lNew;
  }
  return { level, trend, s, errors, sse, n };
};

const bestFit = (y) => {
  let best = null;
  for (const a of [0.05, 0.15, 0.3, 0.5]) {
    for (const b of [0, 0.05, 0.1]) {
      for (const g of [0.05, 0.15, 0.3, 0.5]) {
        const f = fit(y, a, b, g);
        if (!best || f.sse < best.sse) best = { ...f, a, b, g };
      }
    }
  }
  return best;
};

// h days after the last training day (h = 1 is the day right after). The trend fades out, so it never runs away.
const PHI = 0.8;
const ahead = (st, h) => {
  let damp = 0;
  for (let k = 1; k <= h; k++) damp += Math.pow(PHI, k);
  return st.level + damp * st.trend + st.s[(st.n + h - 1) % M];
};

// daily: array of daily totals, oldest first, ending on the last COMPLETE day (yesterday).
// todaySoFar: what has been spent today so far. remaining: whole days left in the month after today.
// spentBefore: spent in the month before today. Returns null when there is too little to say anything.
const forecastMonth = ({ daily, todaySoFar, remaining, spentBefore, seed }) => {
  const days = daily.length;
  const spentNow = (spentBefore || 0) + (todaySoFar || 0);
  if (days < 7) return null;
  const nonNeg = daily.map((v) => Math.max(0, v));
  const cap = Math.max(1, pct(sortedCopy(nonNeg), 0.97));      // one huge day should not set the pace for the whole month
  const y = nonNeg.map((v) => Math.min(v, cap));
  const rand = rng(seed || 12345);

  const finish = (method, paths, extra) => {
    const sorted = sortedCopy(paths);
    const low = pct(sorted, 0.1), mid = pct(sorted, 0.5), high = pct(sorted, 0.9);
    const width = mid > 0 ? (high - low) / mid : 1;
    let level = days < 28 ? 0 : days < 60 ? 1 : 2;
    if (width > 0.6) level = Math.max(0, level - 1);
    return {
      method, daysOfData: days, remainingDays: remaining,
      point: r2(spentNow + mid), low: r2(spentNow + low), high: r2(spentNow + high),
      confidence: ['low', 'medium', 'good'][level], ...extra
    };
  };

  // Not enough history for a weekly pattern: use the typical (median) day.
  if (days < 21) {
    const sorted = sortedCopy(y);
    const med = pct(sorted, 0.5), lo = pct(sorted, 0.25), hi = pct(sorted, 0.75);
    const todayLeft = Math.max(0, med - (todaySoFar || 0));
    const paths = [];
    for (let k = 0; k < 400; k++) {
      let sum = 0;
      for (let d = 0; d < remaining; d++) sum += lo + rand() * (hi - lo) + (rand() < 0.1 ? med : 0);
      paths.push(Math.max(0, todayLeft * (0.5 + rand())) + sum);
    }
    return finish('typical-day', paths, {});
  }

  const st = bestFit(y);
  const errs = st.errors.length ? st.errors : [0];
  const paths = [];
  const todayF = Math.max(0, ahead(st, 1));
  for (let k = 0; k < 500; k++) {
    // today: whatever the model expected for the day, less what is already spent
    let sum = Math.max(0, todayF + errs[Math.floor(rand() * errs.length)] - (todaySoFar || 0));
    for (let h = 2; h <= remaining + 1; h++) sum += Math.max(0, ahead(st, h) + errs[Math.floor(rand() * errs.length)]);
    paths.push(sum);
  }
  return finish('weekly-pattern', paths, { weekly: st.s.map((v) => r2(v)) });
};

module.exports = { forecastMonth, fit, bestFit, ahead };
