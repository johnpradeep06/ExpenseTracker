/* Spending history: one period at a time (week, month, 3 months, year or all time) with the total, how it compares
   with the period before, the categories, the cards and the biggest merchants. The server adds it all up.
   Everything is drawn with textContent / createElement, never innerHTML. */
(function () {
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const money = (v) => '$' + Math.abs(v).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const whole = (v) => '$' + Math.round(Math.abs(v)).toLocaleString('en-CA');
  const pct = (v) => Math.round(Math.abs(v) * 100) + '%';
  const RANGES = [['week', 'Week'], ['month', 'Month'], ['3m', '3 Mo'], ['year', 'Year'], ['all', 'All']];
  const MON = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
  const meta = (c) => (window.spendCatMeta ? window.spendCatMeta(c) : ['🧾', '#8C8C8C']);
  const cardNames = () => { try { return JSON.parse(localStorage.getItem('spend.cardNames') || '{}') || {}; } catch (e) { return {}; } };
  const cardName = (raw) => cardNames()[raw] || raw || 'No card';

  const backdrop = el('div', 'backdrop'); backdrop.id = 'history-backdrop'; backdrop.hidden = true;
  const sheet = el('div', 'sheet tall hist'); sheet.id = 'history-sheet'; sheet.hidden = true;
  sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-labelledby', 'history-title');
  const grab = el('div', 'grab'); grab.setAttribute('aria-hidden', 'true');
  const head = el('div', 'set-head');
  const title = el('h2', '', 'Spending history'); title.id = 'history-title';
  const done = el('button', 'link', 'Done'); done.type = 'button';
  head.append(title, done);
  const seg = el('div', 'hist-seg'); seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Period');
  const nav = el('div', 'hist-nav');
  const prevBtn = el('button', 'hist-arrow', '‹'); prevBtn.type = 'button'; prevBtn.setAttribute('aria-label', 'Earlier');
  const navTitle = el('div', 'hist-title');
  const nextBtn = el('button', 'hist-arrow', '›'); nextBtn.type = 'button'; nextBtn.setAttribute('aria-label', 'Later');
  nav.append(prevBtn, navTitle, nextBtn);
  const body = el('div', 'hist-body');
  sheet.append(grab, head, seg, nav, body);
  document.body.append(backdrop, sheet);

  let range = 'month';
  let anchor = null;
  let data = null;
  let token = 0;
  const openCats = new Set();
  const getLS = (k, d) => { try { return localStorage.getItem(k) || d; } catch (e) { return d; } };
  let view = getLS('spend.histView', 'calendar'); // calendar | chart | list
  let selDay = null;
  let listCat = null;
  let query = '';

  RANGES.forEach(([id, label]) => {
    const b = el('button', '', label); b.type = 'button'; b.dataset.range = id;
    b.addEventListener('click', () => { range = id; anchor = null; selDay = null; openCats.clear(); load(); });
    seg.append(b);
  });
  const syncSeg = () => seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === range)));

  const clock = (ts) => (ts ? new Date(ts).toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' }) : '');
  const dayDate = (k) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || ''); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null; };
  const keyOf = (d) => { const p = (n) => (n < 10 ? '0' : '') + n; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
  const longDay = (k) => { const d = dayDate(k); return d ? d.toLocaleDateString('en-CA', { weekday: 'short', month: 'short', day: 'numeric' }) : k; };
  const edit = (r) => {
    if (!window.spendEdit) return;
    window.spendListReturn = false;
    window.spendEdit({ id: r.id, merchant: r.merchant, amount: r.amount, category: r.category, ts: r.ts, card: r.card, dupIds: r.dupIds || [] });
  };

  // One purchase as a tappable row.
  const txRow = (r) => {
    const [icon, color] = meta(r.category);
    const b = el('button', 'hist-tx'); b.type = 'button';
    const chip = el('span', 'hist-chip', icon); chip.style.setProperty('--c', color);
    const mid = el('span', 'hist-mid');
    const bits = [clock(r.ts), r.category];
    if (r.card && (data.cards || []).length > 1) bits.push(cardName(r.card));
    mid.append(el('b', '', r.merchant), el('span', 'hist-rsub', bits.filter(Boolean).join(' · ')));
    b.append(chip, mid, el('span', 'hist-amt' + (r.amount < 0 ? ' in' : ''), r.amount < 0 ? '+' + money(-r.amount) : money(r.amount)));
    b.addEventListener('click', () => edit(r));
    return b;
  };

  // Everything for a week or a month: totals per day, then the calendar, the chart or the list.
  const buildViews = () => {
    const rows = data.rows || [];
    const byDay = new Map();
    rows.forEach((r) => { const g = byDay.get(r.day) || { total: 0, rows: [] }; g.total += r.amount; g.rows.push(r); byDay.set(r.day, g); });
    const limit = data.limit > 0 ? data.limit : 0;
    const line = limit || data.perDay || 0;
    const first = dayDate(data.startDay);
    const lastShown = dayDate(data.endDay) || first;
    // The last day of the period itself (a month still in progress shows its remaining days as empty tiles).
    const periodEnd = range === 'month' ? new Date(first.getFullYear(), first.getMonth() + 1, 0) : new Date(first.getFullYear(), first.getMonth(), first.getDate() + 6);
    const days = [];
    for (let d = new Date(first); d <= periodEnd; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) days.push(keyOf(d));
    if (!selDay || days.indexOf(selDay) < 0) selDay = days.indexOf(data.today) >= 0 && data.today <= data.endDay ? data.today : data.endDay;
    const wrap = el('div', 'hist-views');

    const sw = el('div', 'hist-view');
    [['calendar', '📅 Calendar'], ['chart', '📊 Chart'], ['list', '🧾 List']].forEach(([id, label]) => {
      const b = el('button', '', label); b.type = 'button'; b.setAttribute('aria-pressed', String(view === id));
      b.addEventListener('click', () => { view = id; try { localStorage.setItem('spend.histView', id); } catch (e) { /* storage unavailable */ } draw(); });
      sw.append(b);
    });
    wrap.append(sw);

    const dayCard = (k) => {
      const g = byDay.get(k) || { total: 0, rows: [] };
      const card = el('section', 'card hist-card');
      const head = el('div', 'hist-dayhead');
      head.append(el('h3', '', longDay(k)));
      const right = el('span', 'hist-dayright');
      right.append(el('b', '', money(g.total)));
      if (limit && g.total > limit) right.append(el('span', 'hist-pill up', money(g.total - limit) + ' over'));
      head.append(right);
      card.append(head);
      if (!g.rows.length) card.append(el('p', 'hist-sub', 'No purchases this day.'));
      g.rows.slice().sort((a, b) => a.ts - b.ts).reverse().forEach((r) => card.append(txRow(r)));
      return card;
    };

    if (view === 'calendar') {
      const cal = el('section', 'card hist-card');
      const dow = el('div', 'hist-dow'); ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach((x) => dow.append(el('span', '', x)));
      const grid = el('div', 'hist-cal');
      if (range === 'month') for (let i = 0; i < (first.getDay() + 6) % 7; i++) grid.append(el('div', 'hist-cd empty'));
      days.forEach((k) => {
        const d = dayDate(k);
        const g = byDay.get(k);
        const isFuture = k > data.endDay;
        const t = el(isFuture ? 'div' : 'button', 'hist-cd');
        if (!isFuture) t.type = 'button';
        const total = g ? g.total : 0;
        t.classList.add(isFuture ? 'future' : total <= 0 ? 'zero' : line && total > line ? 'over' : 'ok');
        if (k === data.today) t.classList.add('today');
        if (k === selDay) t.classList.add('sel');
        t.append(el('span', '', String(d.getDate())));
        if (!isFuture && total > 0) t.append(el('small', '', '$' + Math.round(total)));
        if (!isFuture) t.addEventListener('click', () => { selDay = k; draw(); });
        grid.append(t);
      });
      const legend = el('div', 'hist-legend');
      [['ok', line ? 'Under ' + whole(line) + (limit ? ' limit' : ' average') : 'Spending'], ['over', 'Over'], ['zero', 'No spend']].forEach(([c, t]) => { const sp = el('span', '', t); sp.prepend(el('i', 'lg-' + c)); legend.append(sp); });
      cal.append(dow, grid, legend);
      wrap.append(cal, dayCard(selDay));
      return wrap;
    }

    if (view === 'chart') {
      const card = el('section', 'card hist-card');
      const over = days.filter((k) => k <= data.endDay && line && (byDay.get(k) || { total: 0 }).total > line).length;
      card.append(el('h3', '', 'Day by day'), el('p', 'hist-sub', line ? 'Red bars are days over ' + (limit ? 'your ' + whole(limit) + ' limit' : 'your average') + ' · ' + over + ' of ' + days.filter((k) => k <= data.endDay).length + ' days over' : 'Each bar is one day'));
      const max = Math.max(line * 1.15, ...days.map((k) => (byDay.get(k) || { total: 0 }).total), 1);
      const chart = el('div', 'hist-days');
      if (line) { const lim = el('div', 'hist-lim'); lim.style.bottom = (line / max * 110 + 0) + 'px'; lim.append(el('span', '', whole(line))); chart.append(lim); }
      days.forEach((k) => {
        const g = byDay.get(k);
        const total = g ? Math.max(g.total, 0) : 0;
        const col = el(k > data.endDay ? 'div' : 'button', 'hist-dc'); if (k <= data.endDay) col.type = 'button';
        const bar = el('i', k > data.endDay ? 'fut' : line && total > line ? 'over' : ''); bar.style.height = (k > data.endDay ? 3 : Math.max(3, Math.round(total / max * 110))) + 'px';
        col.append(bar);
        col.setAttribute('aria-label', longDay(k) + ' ' + money(total));
        if (k <= data.endDay) col.addEventListener('click', () => { const t = body.querySelector('[data-day="' + k + '"]'); if (t) t.scrollIntoView({ block: 'center', behavior: 'smooth' }); });
        chart.append(col);
      });
      const axis = el('div', 'hist-axis'); axis.append(el('span', '', String(dayDate(days[0]).getDate())), el('span', '', String(dayDate(days[days.length - 1]).getDate())));
      card.append(chart, axis);
      wrap.append(card, buildList(rows));
      return wrap;
    }

    wrap.append(buildList(rows));
    return wrap;
  };

  // Category chips, a search box and the purchases grouped by day.
  const buildList = (rows) => {
    const box = el('div', 'hist-listbox');
    const totals = new Map();
    rows.forEach((r) => totals.set(r.category, (totals.get(r.category) || 0) + Math.max(r.amount, 0)));
    const cats = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
    const chips = el('div', 'hist-chips');
    const search = el('input', 'hist-search'); search.type = 'search'; search.placeholder = 'Search purchases'; search.value = query; search.setAttribute('aria-label', 'Search purchases');
    search.autocomplete = 'off';
    const list = el('section', 'card hist-card hist-list');
    const drawChips = () => {
      chips.replaceChildren();
      [[null, 'All']].concat(cats.map((c) => [c, meta(c)[0] + ' ' + c])).forEach(([c, label]) => {
        const b = el('button', '', label); b.type = 'button'; b.setAttribute('aria-pressed', String(listCat === c));
        b.addEventListener('click', () => { listCat = c; drawChips(); drawRows(); });
        chips.append(b);
      });
    };
    const drawRows = () => {
      list.replaceChildren();
      const q = query.trim().toLowerCase();
      const shown = rows.filter((r) => (!listCat || r.category === listCat) && (!q || (r.merchant + ' ' + r.category + ' ' + cardName(r.card)).toLowerCase().indexOf(q) >= 0));
      if (!shown.length) { list.append(el('p', 'hist-note', 'No purchases match.')); return; }
      const groups = new Map();
      shown.forEach((r) => { const g = groups.get(r.day) || []; g.push(r); groups.set(r.day, g); });
      [...groups.keys()].sort().reverse().forEach((k) => {
        const g = groups.get(k);
        const head = el('div', 'hist-dh'); head.dataset.day = k;
        head.append(el('span', '', longDay(k).toUpperCase()), el('span', '', money(g.reduce((s, r) => s + r.amount, 0))));
        list.append(head);
        g.forEach((r) => list.append(txRow(r)));
      });
    };
    search.addEventListener('input', () => { query = search.value; drawRows(); });
    drawChips(); drawRows();
    box.append(chips, search, list);
    return box;
  };

  const note = (text) => { body.replaceChildren(el('p', 'hist-note', text)); };

  const draw = () => {
    body.replaceChildren();
    navTitle.textContent = data.title;
    prevBtn.disabled = !data.prevAnchor;
    nextBtn.disabled = !data.nextAnchor;
    prevBtn.hidden = nextBtn.hidden = range === 'all';

    // total + comparison
    const tot = el('section', 'card hist-card');
    const dollars = Math.floor(Math.abs(data.total));
    const cents = Math.round((Math.abs(data.total) - dollars) * 100);
    const big = el('div', 'hist-big', (data.total < 0 ? '-' : '') + '$' + dollars.toLocaleString('en-CA'));
    big.append(el('small', '', '.' + (cents < 10 ? '0' : '') + cents));
    tot.append(el('span', 'hist-cap', (data.inProgress ? 'SPENT · ' + data.days + (data.days === 1 ? ' day in' : ' days in') : 'TOTAL SPENT')), big);
    const line = el('p', 'hist-sub', data.count + (data.count === 1 ? ' purchase' : ' purchases') + (data.days > 0 ? ' · ' + money(data.perDay) + ' a day' : ''));
    tot.append(line);
    if (range !== 'all') {
      let pill;
      if (data.prevTotal > 0 && data.total >= 0) {
        const c = (data.total - data.prevTotal) / data.prevTotal;
        if (Math.abs(c) < 0.005) pill = el('span', 'hist-pill flat', 'Same as ' + data.prevLabel + (data.inProgress ? ' (same days)' : ''));
        else pill = el('span', 'hist-pill ' + (c > 0 ? 'up' : 'down'), (c > 0 ? '▲ ' : '▼ ') + pct(c) + ' vs ' + data.prevLabel + (data.inProgress ? ' (same days)' : ''));
      } else {
        pill = el('span', 'hist-pill flat', 'Nothing earlier to compare with yet');
      }
      tot.append(pill);
    }
    if (data.categories.length) {
      const stack = el('div', 'hist-stack');
      data.categories.forEach((c) => {
        const i = el('i'); i.style.flexGrow = String(Math.max(c.share, 0.02)); i.style.background = meta(c.category)[1]; i.title = c.category;
        stack.append(i);
      });
      tot.append(stack);
    }
    body.append(tot);

    if ((range === 'week' || range === 'month') && data.rows && data.count) body.append(buildViews());

    if (!data.count) { body.append(el('p', 'hist-note', 'No spending in this period.')); return; }

    // month by month bars (3 months, year, all time)
    if (data.months.length > 1) {
      const card = el('section', 'card hist-card');
      card.append(el('h3', '', 'Month by month'), el('p', 'hist-sub', 'Each bar is split by category'));
      const max = Math.max(...data.months.map((m) => Math.max(m.total, 0)), 1);
      const chart = el('div', 'hist-chart');
      data.months.forEach((m) => {
        const col = el('div', 'hist-col');
        const s = el('div', 'hist-bar'); s.style.height = Math.max(4, Math.round((Math.max(m.total, 0) / max) * 120)) + 'px';
        s.title = m.key + ': ' + money(m.total);
        Object.entries(m.byCat).sort((a, b) => b[1] - a[1]).forEach(([cat, v]) => {
          const i = el('i'); i.style.height = (v / Math.max(m.total, 1) * 100) + '%'; i.style.background = meta(cat)[1];
          s.append(i);
        });
        const mo = Number(m.key.slice(5, 7)) - 1;
        col.append(s, el('em', '', data.months.length > 12 ? (mo === 0 ? m.key.slice(2, 4) : '') : MON[mo]));
        chart.append(col);
      });
      card.append(chart);
      body.append(card);
    }

    // categories
    const cats = el('section', 'card hist-card');
    cats.append(el('h3', '', 'By category'), el('p', 'hist-sub', 'Tap one to see where it went'));
    const top = data.categories[0] ? data.categories[0].amount : 1;
    data.categories.forEach((c) => {
      const [icon, color] = meta(c.category);
      const row = el('button', 'hist-row'); row.type = 'button';
      const chip = el('span', 'hist-chip', icon); chip.style.setProperty('--c', color);
      const mid = el('span', 'hist-mid');
      const sub = el('span', 'hist-rsub');
      sub.append(document.createTextNode(c.count + (c.count === 1 ? ' purchase' : ' purchases') + ' · ' + pct(c.share)));
      if (range !== 'all' && typeof c.change === 'number' && Math.abs(c.change) >= 0.005) {
        sub.append(document.createTextNode(' · '), el('span', c.change > 0 ? 'hist-up' : 'hist-down', (c.change > 0 ? '▲ ' : '▼ ') + pct(c.change)));
      } else if (range !== 'all' && c.change === null && data.prevTotal > 0) sub.append(document.createTextNode(' · new'));
      const bar = el('span', 'hist-meter'); const fill = el('i'); fill.style.width = Math.max(3, Math.round(c.amount / top * 100)) + '%'; fill.style.background = color; bar.append(fill);
      mid.append(el('b', '', c.category), sub, bar);
      row.append(chip, mid, el('span', 'hist-amt', whole(c.amount)));
      row.setAttribute('aria-expanded', String(openCats.has(c.category)));
      const more = el('div', 'hist-more'); more.hidden = !openCats.has(c.category);
      c.merchants.forEach((m) => {
        const r = el('div', 'hist-mrow'); r.append(el('span', '', m.merchant + (m.count > 1 ? ' · ' + m.count + '×' : '')), el('b', '', money(m.amount)));
        more.append(r);
      });
      row.addEventListener('click', () => {
        if (openCats.has(c.category)) openCats.delete(c.category); else openCats.add(c.category);
        more.hidden = !openCats.has(c.category);
        row.setAttribute('aria-expanded', String(openCats.has(c.category)));
      });
      cats.append(row, more);
    });
    body.append(cats);

    // cards
    if (data.cards.length > 1 || (data.cards.length === 1 && data.cards[0].card)) {
      const cc = el('section', 'card hist-card');
      cc.append(el('h3', '', 'Cards'));
      data.cards.forEach((c) => {
        const row = el('div', 'hist-row static');
        const chip = el('span', 'hist-chip', '💳'); chip.style.setProperty('--c', '#5B6CE0');
        const mid = el('span', 'hist-mid'); mid.append(el('b', '', cardName(c.card)), el('span', 'hist-rsub', c.count + (c.count === 1 ? ' purchase' : ' purchases') + ' · ' + pct(c.share)));
        row.append(chip, mid, el('span', 'hist-amt', whole(c.amount)));
        cc.append(row);
      });
      body.append(cc);
    }

    // merchants
    if (data.merchants.length) {
      const mc = el('section', 'card hist-card');
      mc.append(el('h3', '', 'Biggest merchants'));
      const topM = data.merchants[0].amount || 1;
      data.merchants.forEach((m) => {
        const row = el('div', 'hist-row static');
        const mid = el('span', 'hist-mid'); const bar = el('span', 'hist-meter'); const fill = el('i'); fill.style.width = Math.max(3, Math.round(m.amount / topM * 100)) + '%'; fill.style.background = 'var(--accent, #1f6f55)'; bar.append(fill);
        mid.append(el('b', '', m.merchant), el('span', 'hist-rsub', m.count + (m.count === 1 ? ' purchase' : ' purchases')), bar);
        row.append(mid, el('span', 'hist-amt', whole(m.amount)));
        mc.append(row);
      });
      body.append(mc);
    }
  };

  const load = async () => {
    syncSeg();
    const mine = ++token;
    note('Loading…');
    try {
      const r = await window.spendApi('GET', 'summary?range=' + range + (anchor ? '&anchor=' + anchor : '') + (range === 'week' || range === 'month' ? '&rows=1' : ''));
      if (mine !== token) return;
      data = r;
      draw();
    } catch (e) {
      if (mine !== token) return;
      note(e && e.status ? e.message : 'Could not reach the server. Check your connection and try again.');
    }
  };

  prevBtn.addEventListener('click', () => { if (data && data.prevAnchor) { anchor = data.prevAnchor; selDay = null; openCats.clear(); load(); } });
  nextBtn.addEventListener('click', () => { if (data && data.nextAnchor) { anchor = data.nextAnchor; selDay = null; openCats.clear(); load(); } });

  const open = () => {
    backdrop.hidden = false; sheet.hidden = false;
    document.body.classList.add('sheet-open');
    sheet.scrollTop = 0;
    range = 'month'; anchor = null; selDay = null; listCat = null; query = ''; openCats.clear();
    load();
  };
  const close = () => { sheet.hidden = true; backdrop.hidden = true; document.body.classList.remove('sheet-open'); token++; };
  done.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) close(); });
  // After a purchase is edited or deleted the app reloads its data: refresh this screen quietly, and keep the page locked behind it.
  let refreshTimer = null;
  const quiet = async () => {
    if (sheet.hidden) return;
    const mine = ++token;
    try {
      const r = await window.spendApi('GET', 'summary?range=' + range + (anchor ? '&anchor=' + anchor : '') + (range === 'week' || range === 'month' ? '&rows=1' : ''));
      if (mine !== token || sheet.hidden) return;
      const keep = sheet.scrollTop;
      data = r; draw(); sheet.scrollTop = keep;
    } catch (e) { /* keep what is showing */ }
  };
  if (window.dash && window.dash.onData) window.dash.onData(() => { if (sheet.hidden) return; clearTimeout(refreshTimer); refreshTimer = setTimeout(quiet, 400); });
  const addSheet = $('#add-sheet');
  if (addSheet && window.MutationObserver) new MutationObserver(() => { if (addSheet.hidden && !sheet.hidden) document.body.classList.add('sheet-open'); }).observe(addSheet, { attributes: true, attributeFilter: ['hidden'] });
  const btn = $('#history-open');
  if (btn) btn.addEventListener('click', open);
  if (window.spendSwipeToClose) window.spendSwipeToClose(sheet, close);
  window.spendCloseHistory = close;
})();
