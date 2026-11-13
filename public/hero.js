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
  const dayShortDate = (d) => (d ? d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) : '');
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
    const chart = el('div', 'htr-chart sp-js-full');
    const read = el('p', 'scrub');
    read.setAttribute('aria-live', 'polite');
    const note = el('p', 'htr-note');
    trendEl.append(label, amt, sub, todayHost, chart, read, note);
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

  // One line-chart renderer for every range, built the same way as the original "Last 14 days" chart (same classes,
  // so it reads as the same chart, not a different one): a gradient-filled monotone line, a dashed reference line
  // with its label in the margin to the right, a dot per point (bigger for "today", red if over the reference,
  // faint if zero), and touch-and-hold to read a point — exactly the interaction the 14-day chart already has.
  const lineChart = (container, vals, opts) => {
    container.replaceChildren();
    const d3 = window.d3;
    const W = Math.max(container.clientWidth, 260);
    const H = 150, top = 14, bottom = 20, plotEnd = W - 54;
    const maxV = Math.max(d3.max(vals) || 0, opts.line || 0) || 1;
    const y = d3.scaleLinear([0, maxV * 1.12], [H - bottom, top]);
    const idx = vals.map((v, i) => i);
    const x = d3.scalePoint(idx, [10, plotEnd - 4]);
    const px = (i) => x(i);
    const gradId = 'htr-area-' + (opts.gradId || '1');
    const svg = d3.select(container).append('svg').attr('class', 'line-svg').attr('width', '100%').attr('viewBox', '0 0 ' + W + ' ' + H).attr('role', 'img').attr('aria-label', opts.ariaLabel || '');
    const grad = svg.append('defs').append('linearGradient').attr('id', gradId).attr('x1', 0).attr('x2', 0).attr('y1', 0).attr('y2', 1);
    grad.append('stop').attr('offset', '0%').attr('class', 'grad-top');
    grad.append('stop').attr('offset', '100%').attr('class', 'grad-bot');
    svg.append('line').attr('class', 'base').attr('x1', 0).attr('x2', plotEnd).attr('y1', y(0)).attr('y2', y(0));
    svg.append('path').attr('class', 'area').attr('fill', 'url(#' + gradId + ')').attr('d', d3.area().x(px).y0(y(0)).y1((i) => y(vals[i])).curve(d3.curveMonotoneX)(idx));
    svg.append('path').attr('class', 'line').attr('d', d3.line().x(px).y((i) => y(vals[i])).curve(d3.curveMonotoneX)(idx));
    if (opts.line > 0) {
      const ay = y(opts.line);
      svg.append('line').attr('class', 'avg-line').attr('x1', 0).attr('x2', plotEnd).attr('y1', ay).attr('y2', ay);
      const ly = Math.min(ay, y(0) - 12);
      svg.append('text').attr('class', 'avg-label').attr('x', plotEnd + 5).attr('y', ly - 3).text(opts.lineLabel);
      svg.append('text').attr('class', 'avg-label avg-amt').attr('x', plotEnd + 5).attr('y', ly + 11).text(opts.lineText);
    }
    const guide = svg.append('line').attr('class', 'guide').attr('y1', top - 4).attr('y2', y(0)).attr('visibility', 'hidden');
    const radius = (i) => (i === opts.today ? 5.5 : vals[i] > 0 ? 3.8 : 2.6);
    const dots = svg.append('g').selectAll('circle').data(idx).join('circle')
      .attr('class', (i) => 'dot' + (vals[i] === 0 ? ' zero' : '') + (opts.over && vals[i] > opts.over ? ' over' : '') + (i === opts.today ? ' today' : ''))
      .attr('cx', px).attr('cy', (i) => y(vals[i])).attr('r', radius);
    const axis = svg.append('g').attr('class', 'bars-axis');
    axis.append('text').attr('x', 2).attr('y', H - 4).attr('text-anchor', 'start').text(opts.axisStart);
    axis.append('text').attr('x', plotEnd + 6).attr('y', H - 4).attr('text-anchor', 'end').text(opts.axisEnd);
    if (opts.read) {
      const read = trendEl.querySelector('.scrub');
      const rest = opts.readHint;
      read.textContent = rest;
      const show = (event, i) => { read.textContent = opts.read(i); guide.attr('x1', px(i)).attr('x2', px(i)).attr('visibility', 'visible'); dots.attr('r', (p) => (p === i ? radius(p) + 2 : radius(p))); };
      const hide = () => { read.textContent = rest; guide.attr('visibility', 'hidden'); dots.attr('r', radius); };
      svg.append('g').selectAll('rect').data(idx).join('rect')
        .attr('x', (i) => px(i) - x.step() / 2).attr('width', x.step()).attr('y', 0).attr('height', H - bottom).attr('fill', 'transparent')
        .on('pointerenter', show).on('pointermove', show).on('pointerdown', show).on('pointerleave', hide).on('pointercancel', hide);
    }
  };

  const renderTrendDailyLine = (days, data) => {
    const limit = data.limit > 0 ? data.limit : 0;
    const today = dayDate(data.today);
    const keys = [];
    for (let i = days - 1; i >= 0; i--) keys.push(keyOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)));
    const byDay = data.daily || {};
    const vals = keys.map((k) => byDay[k] || 0);
    const line = limit || data.perDay || 0;
    lineChart(trendEl.querySelector('.htr-chart'), vals, {
      gradId: 'd' + days, line, over: line, today: keys.length - 1,
      lineLabel: limit ? 'Your limit' : 'Daily avg', lineText: whole(line),
      ariaLabel: 'Spending for each of the last ' + days + ' days' + (line ? ', with the ' + (limit ? 'limit' : 'average') + ' of ' + money(line) : ''),
      axisStart: dayShortDate(dayDate(keys[0])), axisEnd: 'Today',
      read: (i) => longDay(keys[i]) + ' · ' + money(vals[i]), readHint: 'Touch and hold the line to see a day'
    });
  };

  const renderTrendMonthlyLine = (data) => {
    const today = dayDate(data.today);
    const map = new Map((data.months || []).map((m) => [m.key, m.total]));
    const keys = [];
    for (let i = 11; i >= 0; i--) { const d = new Date(today.getFullYear(), today.getMonth() - i, 1); keys.push(d.getFullYear() + '-' + (d.getMonth() < 9 ? '0' : '') + (d.getMonth() + 1)); }
    const vals = keys.map((k) => map.get(k) || 0);
    const line = vals.reduce((a, b) => a + b, 0) / 12 || 0;
    lineChart(trendEl.querySelector('.htr-chart'), vals, {
      gradId: 'y', line, over: 0, today: 11,
      lineLabel: 'Average', lineText: whole(line),
      ariaLabel: 'Spending for each of the last 12 months' + (line ? ', averaging ' + money(line) : ''),
      axisStart: MON3[Number(keys[0].slice(5, 7)) - 1], axisEnd: 'Now',
      read: (i) => MONTHS[Number(keys[i].slice(5, 7)) - 1] + ' ' + keys[i].slice(0, 4) + ' · ' + money(vals[i]), readHint: 'Touch and hold the line to see a month'
    });
  };

  const renderTrendFor = (days, data) => {
    trendEl.querySelector('.hero-label').textContent = 'Last ' + (days === 365 ? '12 months' : days + ' days');
    trendEl.querySelector('.hero-amt').replaceChildren(moneyBig(data.total));
    trendEl.querySelector('.hero-sub').textContent = (data.total > 0 ? money(data.perDay) + ' a day · ' : '') + data.count + (data.count === 1 ? ' purchase' : ' purchases');
    trendEl.querySelector('.htr-note').textContent = '';
    if (days === 365) renderTrendMonthlyLine(data); else renderTrendDailyLine(days, data);
  };

  const moneyBig = (v) => {
    const t = money(v);
    const i = t.lastIndexOf('.');
    const w = el('span', '', t.slice(0, i));
    w.append(el('span', 'cents', t.slice(i)));
    return w;
  };

  // Every range but 14D is fetched once, in the background, as soon as there is real data to fetch for (see
  // loadIfReady below) and kept in memory: switching ranges afterwards is just re-drawing numbers already on the
  // phone, not a new round trip, so it is instant. A range tapped before its own fetch has landed (rare - normally
  // the prefetch wins the race) waits for that one fetch and then draws, without blanking what was already showing.
  const trendCache = {};
  const trendPromises = {};
  const fetchTrend = (days, force) => {
    if (!force && trendCache[days]) return Promise.resolve(trendCache[days]);
    if (!force && trendPromises[days]) return trendPromises[days];
    const p = window.spendApi('GET', 'trend?days=' + days)
      .then((r) => { trendCache[days] = r; delete trendPromises[days]; return r; })
      .catch((e) => { delete trendPromises[days]; throw e; });
    trendPromises[days] = p;
    return p;
  };
  const showRange = async (d) => {
    if (d === 14) { hero14.hidden = false; trendEl.hidden = true; return; }
    hero14.hidden = true;
    trendEl.hidden = false;
    if (trendCache[d]) { renderTrendFor(d, trendCache[d]); return; }
    const mine = ++trendToken;
    try {
      const r = await fetchTrend(d);
      if (mine !== trendToken || range !== d) return;
      renderTrendFor(d, r);
    } catch (e) {
      if (mine !== trendToken || range !== d) return;
      trendEl.querySelector('.htr-note').textContent = errLine(e);
    }
  };
  // Quietly redraw whichever range just finished prefetching, but only if it is still the one on screen.
  const prefetchAll = (force) => { [7, 30, 365].forEach((d) => fetchTrend(d, force).then((r) => { if (range === d && built && !trendEl.hidden) renderTrendFor(d, r); }).catch(() => {})); };

  const setRange = (d) => {
    if (d === range) return;
    range = d;
    writeRange(d);
    positionThumb();
    showRange(d);
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
    showRange(range);
    prefetchAll();
    loadMonth(new Date().getFullYear(), new Date().getMonth());
  };
  // After that first load, each normal refresh (a pull, a new purchase, the periodic poll) quietly replaces the
  // cache in the background, same as the rest of the home screen - so a range you switch to is never more than one
  // refresh cycle stale, while switching itself still never waits on the network. At most once every 10 seconds,
  // so a burst of refreshes does not turn into a burst of requests.
  let lastRefresh = 0;
  const refreshTrendCache = () => {
    if (!loaded || Date.now() - lastRefresh < 10000) return;
    lastRefresh = Date.now();
    prefetchAll(true);
  };

  const sync = () => { if (cleanLook()) build(); else teardown(); };
  sync();
  window.addEventListener('spend:theme', sync);
  if (window.dash) window.dash.onData(() => { if (!built) return; queueMicrotask(syncTodayStrip); loadIfReady(); refreshTrendCache(); });
})();
