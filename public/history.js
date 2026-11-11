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

  RANGES.forEach(([id, label]) => {
    const b = el('button', '', label); b.type = 'button'; b.dataset.range = id;
    b.addEventListener('click', () => { range = id; anchor = null; openCats.clear(); load(); });
    seg.append(b);
  });
  const syncSeg = () => seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === range)));

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
      const r = await window.spendApi('GET', 'summary?range=' + range + (anchor ? '&anchor=' + anchor : ''));
      if (mine !== token) return;
      data = r;
      draw();
    } catch (e) {
      if (mine !== token) return;
      note(e && e.status ? e.message : 'Could not reach the server. Check your connection and try again.');
    }
  };

  prevBtn.addEventListener('click', () => { if (data && data.prevAnchor) { anchor = data.prevAnchor; openCats.clear(); load(); } });
  nextBtn.addEventListener('click', () => { if (data && data.nextAnchor) { anchor = data.nextAnchor; openCats.clear(); load(); } });

  const open = () => {
    backdrop.hidden = false; sheet.hidden = false;
    document.body.classList.add('sheet-open');
    sheet.scrollTop = 0;
    range = 'month'; anchor = null; openCats.clear();
    load();
  };
  const close = () => { sheet.hidden = true; backdrop.hidden = true; document.body.classList.remove('sheet-open'); token++; };
  done.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) close(); });
  const btn = $('#history-open');
  if (btn) btn.addEventListener('click', open);
  if (window.spendSwipeToClose) window.spendSwipeToClose(sheet, close);
  window.spendCloseHistory = close;
})();
