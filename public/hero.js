/* The home screen's hero, Clean look only: a swipeable pair of widgets, like two home-screen widgets side by side.
   Widget 1 is the "Last 14 days" card you already know, with a 7D / 14D / 30D / 1Y switch added under it — the three
   new ranges reuse its own "over today / Change limit" line (copied live from the original, never recomputed here,
   so the capture math can never drift) and draw their own chart from GET /api/trend. Widget 2, one swipe away, is a
   small month calendar with a corner button to jump to any month and year.
   Fresh and Arcade are untouched: this file does nothing at all unless the Clean look is on, and the original
   "Last 14 days" card (built by app.js) is still there underneath, unmodified, for them. */
(function () {
  const cleanLook = () => !document.documentElement.classList.contains('candy') && !document.documentElement.classList.contains('retro');
  const headline = document.querySelector('#headline');
  const pager = document.querySelector('#hero-pager');
  const pgMain = document.querySelector('#hero-pg-main');
  const hero14 = document.querySelector('#hero14');
  if (!headline || !pager || !pgMain || !hero14 || !window.spendApi) return;

  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const money = (v) => '$' + Math.abs(v).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const whole = (v) => '$' + Math.round(Math.abs(v)).toLocaleString('en-CA');
  // Calendar tiles and bar labels: whole dollars up to $999, then $1k, $1.5k, $12k, so any amount fits.
  const short = (v) => {
    const n = Math.round(Math.abs(v));
    if (n < 1000) return (v < 0 ? '-' : '') + '$' + n;
    const unit = (x) => String(x >= 10 ? Math.round(x) : Math.round(x * 10) / 10);
    const k = n / 1000;
    const body = Number(unit(k)) < 1000 ? unit(k) + 'k' : unit(n / 1e6) + 'M';
    return (v < 0 ? '-' : '') + '$' + body;
  };
  const dayDate = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ''); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null; };
  const keyOf = (d) => { const p = (n) => (n < 10 ? '0' : '') + n; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
  const longDay = (k) => { const d = dayDate(k); return d ? d.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' }) : k; };
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const MON3 = MONTHS.map((m) => m.slice(0, 3));
  const errLine = (e) => (e && e.status ? e.message : 'Could not reach the server. Check your connection and try again.');

  const RANGES = [7, 14, 30, 365];
  const RANGE_KEY = 'spend.heroRange';
  const readRange = () => { let v = 14; try { v = Number(localStorage.getItem(RANGE_KEY)); } catch (e) { /* storage unavailable */ } return RANGES.includes(v) ? v : 14; };
  const writeRange = (v) => { try { localStorage.setItem(RANGE_KEY, String(v)); } catch (e) { /* storage unavailable */ } };

  let built = false;
  let range = readRange();
  let trendToken = 0;
  let calToken = 0;
  let calState = null; // { y, m, viewY, data: {limit, today, endDay, byDay: Map}, selDay }

  // ---- widget 1: the range switch, and a live copy of the "today" line -------------------------------------------
  let rngEl = null;
  let trendEl = null;
  let todayHost = null; // holds a clone of the real avg-note, kept in sync below

  const buildSwitch = () => {
    rngEl = el('div', 'htr-rng');
    rngEl.setAttribute('role', 'group');
    rngEl.setAttribute('aria-label', 'Timeline');
    const thumb = el('i', 'htr-thumb');
    rngEl.append(thumb);
    RANGES.forEach((d) => {
      const b = el('button', '', d === 365 ? '1Y' : d + 'D');
      b.type = 'button';
      b.dataset.range = String(d);
      b.setAttribute('aria-pressed', String(d === range));
      b.addEventListener('click', () => setRange(d));
      rngEl.append(b);
    });
    pgMain.append(rngEl);
    positionThumb();
  };
  const positionThumb = () => {
    if (!rngEl) return;
    const i = RANGES.indexOf(range);
    rngEl.style.setProperty('--p', String(i < 0 ? 1 : i));
    rngEl.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.range) === range)));
  };

  const buildTrend = () => {
    trendEl = el('div', 'htr');
    trendEl.hidden = true;
    const label = el('div', 'hero-label');
    const amt = el('div', 'hero-amt');
    const sub = el('div', 'hero-sub');
    todayHost = el('div', 'htr-today');
    const chart = el('div', 'htr-chart');
    const note = el('p', 'htr-note');
    trendEl.append(label, amt, sub, todayHost, chart, note);
    pgMain.append(trendEl);
  };

  // Mirrors the real "over today / Change limit" line into the trend widget, whichever range is showing. It is the
  // exact node app.js already built for the original card, just cloned — so the numbers can never disagree, and
  // there is nothing here that could get the math wrong.
  const syncTodayStrip = () => {
    if (!todayHost) return;
    const real = hero14.querySelector('[data-draw="days"] > .avg-note');
    todayHost.replaceChildren();
    if (!real) return;
    const clone = real.cloneNode(true);
    const btn = clone.querySelector('.set-limit');
    if (btn) btn.addEventListener('click', () => window.spendOpenLimit && window.spendOpenLimit());
    todayHost.append(clone);
  };

  // A day-by-day (7D, 30D) or month-by-month (1Y) bar chart. Bars are capped at 3x the reference line, so one huge
  // purchase cannot flatten every other bar into nothing; a bar that is cut shows its real amount above it. The
  // reference line's own label lives in a column of its own next to the bars, never above them, so a tall bar can
  // never grow up underneath it and hide it.
  const barsHtml = (vals, opts) => {
    const cap = opts.cap;
    const row = el('div', 'htr-row');
    const wrap = el('div', 'htr-bars' + (opts.wide ? ' wide' : ''));
    if (opts.lineLeft) row.append(lineCol(opts, cap));
    if (opts.line) {
      const lim = el('div', 'htr-lim');
      lim.style.bottom = Math.min(100, (opts.line / cap) * 100).toFixed(1) + '%';
      wrap.append(lim);
    }
    vals.forEach((v, i) => {
      const future = v === null;
      const over = !future && opts.limit && v > opts.limit;
      const clip = !future && v > cap;
      const h = future ? 0 : Math.min(100, (v / cap) * 100);
      const bc = el('div', 'htr-bc' + (i === opts.today ? ' t' : ''));
      const bar = el('i', future ? 'f' : over ? 'o' : '');
      bar.style.height = future ? '3px' : Math.max(2.5, h) + '%';
      if (clip) bar.append(el('b', '', short(v)));
      bc.append(bar);
      bc.title = opts.titleOf ? opts.titleOf(i, v) : '';
      wrap.append(bc);
    });
    row.append(wrap);
    if (opts.line && !opts.lineLeft) row.append(lineCol(opts, cap));
    const axis = el('div', 'htr-axis' + (opts.wide ? ' wide' : ''));
    opts.axis.forEach((t) => axis.append(el('span', '', t)));
    const axisRow = el('div', 'htr-axisrow');
    axisRow.append(axis);
    if (opts.line) axisRow.append(el('span', 'htr-spacer'));
    const box = el('div', 'htr-plot');
    box.append(row, axisRow);
    return box;
  };
  const lineCol = (opts, cap) => {
    const col = el('div', 'htr-limcol');
    const label = el('span', '', opts.lineLabel);
    label.style.bottom = Math.min(100, (opts.line / cap) * 100).toFixed(1) + '%';
    col.append(label);
    return col;
  };

  const renderTrendDaily = (days, data) => {
    const limit = data.limit > 0 ? data.limit : 0;
    const today = dayDate(data.today);
    const keys = [];
    for (let i = days - 1; i >= 0; i--) keys.push(keyOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)));
    const byDay = data.daily || {};
    const vals = keys.map((k) => byDay[k] || 0);
    const line = limit || data.perDay || Math.max(...vals, 1);
    const axis = days === 7
      ? keys.map((k) => dayDate(k).toLocaleDateString('en-CA', { weekday: 'narrow' }))
      : [keys[0].slice(5).replace('-', '/'), '', data.today.slice(5).replace('-', '/')];
    const chart = trendEl.querySelector('.htr-chart');
    chart.replaceChildren(barsHtml(vals, {
      cap: Math.max(line * 3, 1), line, lineLabel: limit ? 'Your limit ' + whole(limit) : 'Average ' + whole(line), limit, today: keys.length - 1, wide: days === 7,
      titleOf: (i) => longDay(keys[i]) + ' · ' + money(vals[i]),
      axis: days === 7 ? axis : [axis[0], axis[2]]
    }));
  };

  const renderTrendMonthly = (data) => {
    const today = dayDate(data.today);
    const map = new Map((data.months || []).map((m) => [m.key, m.total]));
    const keys = [];
    for (let i = 11; i >= 0; i--) { const d = new Date(today.getFullYear(), today.getMonth() - i, 1); keys.push(d.getFullYear() + '-' + (d.getMonth() < 9 ? '0' : '') + (d.getMonth() + 1)); }
    const vals = keys.map((k) => map.get(k) || 0);
    const line = vals.reduce((a, b) => a + b, 0) / 12 || 1;
    const chart = trendEl.querySelector('.htr-chart');
    chart.replaceChildren(barsHtml(vals, {
      cap: Math.max(line * 1.2, ...vals, 1), line, lineLabel: 'Average ' + short(line) + ' a month', lineLeft: true, today: 11, wide: true, limit: 0,
      titleOf: (i) => MONTHS[Number(keys[i].slice(5, 7)) - 1] + ' ' + keys[i].slice(0, 4) + ' · ' + money(vals[i]),
      axis: keys.map((k) => MON3[Number(k.slice(5, 7)) - 1][0])
    }));
  };

  const loadTrend = async (days) => {
    if (days === 14) { hero14.hidden = false; trendEl.hidden = true; return; }
    hero14.hidden = true;
    trendEl.hidden = false;
    const mine = ++trendToken;
    trendEl.querySelector('.hero-label').textContent = 'Last ' + (days === 365 ? '12 months' : days + ' days');
    trendEl.querySelector('.hero-amt').replaceChildren(el('span', '', '—'));
    trendEl.querySelector('.hero-sub').textContent = 'Loadingâ€¦';
    trendEl.querySelector('.htr-note').textContent = '';
    try {
      const r = await window.spendApi('GET', 'trend?days=' + days);
      if (mine !== trendToken) return;
      trendEl.querySelector('.hero-amt').replaceChildren(moneyBig(r.total));
      trendEl.querySelector('.hero-sub').textContent = (r.total > 0 ? money(r.perDay) + ' a day · ' : '') + r.count + (r.count === 1 ? ' purchase' : ' purchases');
      if (days === 365) renderTrendMonthly(r); else renderTrendDaily(days, r);
    } catch (e) {
      if (mine !== trendToken) return;
      trendEl.querySelector('.htr-note').textContent = errLine(e);
    }
  };

  const moneyBig = (v) => {
    const t = money(v);
    const i = t.lastIndexOf('.');
    const w = el('span', '', t.slice(0, i));
    w.append(el('span', 'cents', t.slice(i)));
    return w;
  };

  const setRange = (d) => {
    if (d === range) return;
    range = d;
    writeRange(d);
    positionThumb();
    loadTrend(d);
  };

  // ---- widget 2: a small month calendar, with a corner button for any month and year ------------------------------
  let calEl = null;
  const CHEV = () => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 10 6'); const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', 'M1 1l4 4 4-4'); s.append(p); return s; };

  const buildCalSkeleton = () => {
    calEl = el('div', 'hero-pg hero-pg-cal');
    const row = el('div', 'htr-crow');
    const label = el('div', 'hero-label', 'Spent this month');
    const pick = el('button', 'htr-pick');
    pick.type = 'button';
    pick.setAttribute('aria-haspopup', 'dialog');
    row.append(label, pick);
    const amt = el('div', 'hero-amt');
    const sub = el('div', 'hero-sub');
    const dow = el('div', 'hcal-dow');
    ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach((d) => dow.append(el('span', '', d)));
    const grid = el('div', 'hcal-grid');
    const read = el('div', 'hcal-read');
    calEl.append(row, amt, sub, dow, grid, read);
    pick.addEventListener('click', openPicker);
    pager.append(calEl);
  };

  const monthKey = (y, m) => y + '-' + (m < 9 ? '0' : '') + (m + 1) + '-01';

  const loadMonth = async (y, m) => {
    const mine = ++calToken;
    calEl.querySelector('.htr-pick').textContent = '';
    calEl.querySelector('.htr-pick').append(el('span', '', MON3[m] + ' ' + y), CHEV());
    calEl.querySelector('.hero-amt').replaceChildren(el('span', '', '—'));
    calEl.querySelector('.hero-sub').textContent = 'Loadingâ€¦';
    calEl.querySelector('.hcal-grid').replaceChildren();
    calEl.querySelector('.hcal-read').replaceChildren();
    try {
      const r = await window.spendApi('GET', 'summary?range=month&rows=1&anchor=' + monthKey(y, m));
      if (mine !== calToken) return;
      const byDay = new Map();
      (r.rows || []).forEach((row) => { byDay.set(row.day, (byDay.get(row.day) || 0) + row.amount); });
      const today = r.today;
      const cur = y === dayDate(today).getFullYear() && m === dayDate(today).getMonth();
      let selDay = cur ? today : null;
      if (!selDay) {
        let best = null, bv = -1;
        byDay.forEach((v, k) => { if (v > bv) { bv = v; best = k; } });
        selDay = best || (y + '-' + (m < 9 ? '0' : '') + (m + 1) + '-01');
      }
      calState = { y, m, data: { limit: r.limit, today, endDay: r.endDay, byDay }, selDay };
      calEl.querySelector('.hero-label').textContent = cur ? 'Spent this month' : 'Spent in ' + MONTHS[m] + (y !== dayDate(today).getFullYear() ? ' ' + y : '');
      calEl.querySelector('.hero-amt').replaceChildren(moneyBig(r.total));
      calEl.querySelector('.hero-sub').textContent = r.total > 0 ? money(r.perDay) + ' a day · ' + r.count + (r.count === 1 ? ' purchase' : ' purchases') : 'Nothing spent yet';
      drawMonthGrid();
    } catch (e) {
      if (mine !== calToken) return;
      calEl.querySelector('.hero-sub').textContent = errLine(e);
    }
  };

  const drawMonthGrid = () => {
    const { y, m, data, selDay } = calState;
    const grid = calEl.querySelector('.hcal-grid');
    grid.replaceChildren();
    const first = new Date(y, m, 1);
    const n = new Date(y, m + 1, 0).getDate();
    const lead = (first.getDay() + 6) % 7;
    for (let i = 0; i < lead; i++) grid.append(el('div', 'hcal-d blank'));
    for (let d = 1; d <= n; d++) {
      const k = keyOf(new Date(y, m, d));
      const future = k > data.endDay;
      const total = data.byDay.get(k) || 0;
      const t = el(future ? 'div' : 'button', 'hcal-d' + (future ? ' future' : '') + (data.limit && total > data.limit ? ' over' : '') + (k === data.today ? ' today' : '') + (k === selDay ? ' sel' : ''));
      if (!future) t.type = 'button';
      t.append(el('span', '', String(d)));
      if (!future && total > 0) t.append(el('small', '', short(total)));
      if (!future) t.addEventListener('click', () => { calState.selDay = k; drawMonthGrid(); });
      grid.append(t);
    }
    const sel = calState.selDay;
    const amt = data.byDay.get(sel) || 0;
    calEl.querySelector('.hcal-read').replaceChildren(el('b', '', longDay(sel)), el('span', '', amt > 0 ? money(amt) : 'No purchases'));
  };

  // ---- the corner picker: step a year, pick a month, future months blocked ---------------------------------------
  let scrim = null;
  let pop = null;
  const closePicker = () => { if (pop) pop.hidden = true; if (scrim) scrim.hidden = true; };
  const openPicker = () => {
    if (!scrim) {
      scrim = el('div', 'hero-scrim');
      scrim.addEventListener('click', closePicker);
      headline.append(scrim);
    }
    if (!pop) { pop = el('div', 'hero-pop'); headline.append(pop); }
    const viewY = calState ? calState.y : new Date().getFullYear();
    drawPicker(viewY);
    const btn = calEl.querySelector('.htr-pick').getBoundingClientRect();
    const host = headline.getBoundingClientRect();
    pop.style.top = (btn.bottom - host.top + 8) + 'px';
    pop.style.right = (host.right - btn.right) + 'px';
    pop.hidden = false;
    scrim.hidden = false;
  };
  const drawPicker = (viewY) => {
    const now = new Date();
    const curY = now.getFullYear();
    const curM = now.getMonth();
    pop.replaceChildren();
    const head = el('div', 'hero-pop-yr');
    const prev = el('button', '', '‹'); prev.type = 'button'; prev.setAttribute('aria-label', 'Previous year');
    const next = el('button', '', '›'); next.type = 'button'; next.setAttribute('aria-label', 'Next year'); next.disabled = viewY >= curY;
    const yrb = el('b', '', String(viewY));
    prev.addEventListener('click', () => drawPicker(viewY - 1));
    next.addEventListener('click', () => drawPicker(viewY + 1));
    head.append(prev, yrb, next);
    const grid = el('div', 'hero-pop-grid');
    MON3.forEach((name, k) => {
      const future = viewY > curY || (viewY === curY && k > curM);
      const b = el('button', (calState && calState.y === viewY && calState.m === k ? 'on' : ''), name);
      b.type = 'button';
      if (future) b.disabled = true;
      else b.addEventListener('click', () => { closePicker(); loadMonth(viewY, k); });
      grid.append(b);
    });
    const foot = el('div', 'hero-pop-foot');
    const tm = el('button', '', 'This month'); tm.type = 'button';
    tm.addEventListener('click', () => { closePicker(); loadMonth(curY, curM); });
    foot.append(tm);
    pop.append(head, grid, foot);
  };

  // ---- the pager: dots track which widget is showing; swipe (or a tap on a dot) moves between them -----------------
  let dotsEl = null;
  const buildDots = () => {
    dotsEl = el('div', 'hero-dots');
    const row = el('div');
    [0, 1].forEach((i) => { const d = el('i'); d.addEventListener('click', () => pager.scrollTo({ left: i * pager.clientWidth, behavior: 'smooth' })); row.append(d); });
    dotsEl.append(row);
    headline.append(dotsEl);
  };
  const onPagerScroll = () => {
    if (!dotsEl) return;
    const p = pager.scrollLeft / (pager.clientWidth || 1);
    [...dotsEl.querySelectorAll('i')].forEach((d, i) => { const o = Math.max(0, 1 - Math.abs(p - i)); d.style.opacity = (0.28 + 0.72 * o).toFixed(2); d.style.transform = 'scale(' + (1 + 0.2 * o).toFixed(2) + ')'; });
  };

  // ---- build, teardown (theme can change without a reload) --------------------------------------------------------
  // The switch, dots and empty skeleton are harmless to build right away. The actual numbers are not fetched until
  // the app has real data to show (i.e. signed in and loaded) - fetching before that only ever produced "Please sign
  // in", since there is no session yet at the moment this file first runs.
  let loaded = false;
  const build = () => {
    if (built) return;
    built = true;
    buildSwitch();
    buildTrend();
    buildCalSkeleton();
    buildDots();
    pager.addEventListener('scroll', onPagerScroll, { passive: true });
    onPagerScroll();
    syncTodayStrip();
    loadIfReady();
  };
  const teardown = () => {
    if (!built) return;
    built = false;
    loaded = false;
    [rngEl, trendEl, calEl, dotsEl, pop, scrim].forEach((n) => n && n.remove());
    rngEl = trendEl = calEl = dotsEl = pop = scrim = todayHost = null;
    pager.removeEventListener('scroll', onPagerScroll);
    pager.scrollLeft = 0;
    hero14.hidden = false;
  };
  // Once, the first time real data is on screen: load the active range and this month. After that, switching range
  // or picking another month fetches on its own; the numbers for whichever one is not showing are not kept live,
  // the same way the rest of the home screen does not redraw what is not on screen.
  const loadIfReady = () => {
    if (loaded || !built) return;
    const kpi = window.dash && window.dash.data('kpi');
    if (!kpi || kpi.status !== 'ok') return;
    loaded = true;
    loadTrend(range);
    loadMonth(new Date().getFullYear(), new Date().getMonth());
  };

  const sync = () => { if (cleanLook()) build(); else teardown(); };
  sync();
  window.addEventListener('spend:theme', sync);
  if (window.dash) window.dash.onData(() => { if (!built) return; queueMicrotask(syncTodayStrip); loadIfReady(); });
})();
