(function () {
  // Drawing code for the spending app. The numbers come from calcs.js through the dash shim in runtime.js.
  const h = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const cad = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });
  const money = (v) => (typeof v === 'number' && isFinite(v) ? cad.format(v) : '—');
  const whole = (v) => (typeof v === 'number' ? d3.format(',')(v) : '—');
  const share = (v) => (typeof v === 'number' ? (v > 0 && v < 0.005 ? '<1%' : d3.format('.0%')(v)) : '—');
  const pct = (v) => (typeof v === 'number' ? d3.format(',.0%')(Math.abs(v)) : '—');
  const clock = d3.timeFormat('%-I:%M %p');
  const dayShort = d3.timeFormat('%b %-d');
  const dayLong = d3.timeFormat('%a, %b %-d');
  const dayKey = d3.timeFormat('%Y-%m-%d');
  const parseDay = d3.timeParse('%Y-%m-%d');

  // Icon and colour for each category. Anything unknown falls back to Other.
  const CAT = {
    'Dining & Coffee': ['☕', '#E8833A'],
    'Subscriptions & Software': ['💻', '#5B6CE0'],
    'Groceries': ['🛒', '#3BA776'],
    'Transport': ['🚌', '#3B82C4'],
    'Travel': ['✈️', '#14A3B8'],
    'Health & Personal Care': ['🩺', '#D9567A'],
    'Bills & Utilities': ['⚡', '#C9A227'],
    'Entertainment': ['🎬', '#C2528B'],
    'Shopping': ['🛍️', '#A855C7'],
    'Other': ['🧾', '#8C8C8C']
  };
  // Fresh theme: bright accent colours, one per category.
  const CANDY = {
    'Dining & Coffee': '#ff9600', 'Subscriptions & Software': '#ce82ff', 'Groceries': '#58cc02', 'Transport': '#1cb0f6', 'Travel': '#00cd9c',
    'Health & Personal Care': '#ff4b4b', 'Bills & Utilities': '#ffc800', 'Entertainment': '#ff86d0', 'Shopping': '#2b70c9', 'Other': '#afafaf'
  };
  const freshOn = () => document.documentElement.classList.contains('candy');
  const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let firstLists = true;
  const catMeta = (c) => {
    const m = CAT[c] || CAT.Other;
    return document.documentElement.classList.contains('candy') ? [m[0], CANDY[c] || CANDY.Other] : m;
  };
  const MERCHANT_COLORS = ['#E8833A', '#5B6CE0', '#3BA776', '#3B82C4', '#14A3B8', '#D9567A', '#C9A227', '#C2528B', '#A855C7'];
  const colorFor = (s) => {
    let n = 0;
    for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0;
    return MERCHANT_COLORS[n % MERCHANT_COLORS.length];
  };

  const chip = (icon, color, cls) => {
    const c = h('span', 'chip' + (cls ? ' ' + cls : ''), icon);
    c.style.setProperty('--c', color);
    c.setAttribute('aria-hidden', 'true');
    return c;
  };

  const stateOf = (ids) => {
    let wait = false;
    for (const id of ids) {
      const s = dash.data(id).status;
      if (s === 'loading') wait = true;
      else if (s !== 'ok') return 'error';
    }
    return wait ? 'loading' : 'ok';
  };
  const rowsOf = (id) => dash.data(id).data || [];
  const failLine = () => {
    const w = h('div', 'sp-fail');
    w.append(h('span', 'sp-dot'), h('span', 'sp-fail-text', 'Failed to load'));
    return w;
  };
  const kpiRow = () => (stateOf(['kpi']) === 'ok' ? rowsOf('kpi')[0] : null);

  let activeCat = null;
  let showAll = false;
  const TX_LIMIT = 6;

  // Headline: total, change pill, per-day line.
  let shownTotal = null;
  let countRun = 0;
  dash.draw('h_amt', (el) => {
    const st = stateOf(['kpi']);
    const row = kpiRow();
    el.classList.toggle('is-loading', st === 'loading');
    const write = (v) => {
      el.replaceChildren();
      const text = v === null ? '—' : money(v);
      const dot = text.lastIndexOf('.');
      if (dot > 0) {
        el.append(document.createTextNode(text.slice(0, dot)), h('span', 'cents', text.slice(dot)));
      } else {
        el.append(document.createTextNode(text));
      }
    };
    const target = row ? row.cur_total : null;
    // Fresh: the total counts up to its new value, like a score.
    if (target !== null && freshOn() && !calm() && target !== shownTotal) {
      const from = shownTotal === null ? 0 : shownTotal;
      const run = ++countRun;
      const t0 = performance.now();
      const step = (t) => {
        if (run !== countRun) return;
        const k = Math.min(1, (t - t0) / 900);
        const eased = 1 - Math.pow(1 - k, 3);
        write(Math.round((from + (target - from) * eased) * 100) / 100);
        if (k < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    } else {
      countRun++;
      write(target);
    }
    shownTotal = target;
  });

  dash.draw('h_sub', (el) => {
    const st = stateOf(['kpi']);
    const row = kpiRow();
    el.classList.toggle('is-loading', st === 'loading');
    el.textContent = row ? money(row.per_day) + ' a day · ' + whole(row.cur_count) + (row.cur_count === 1 ? ' purchase' : ' purchases') : '—';
  });

  dash.draw('h_pill', (el) => {
    const st = stateOf(['kpi']);
    const row = kpiRow();
    el.className = 'pill';
    el.replaceChildren();
    if (!row) {
      el.hidden = st !== 'loading';
      if (st === 'loading') el.classList.add('is-loading');
      return;
    }
    el.hidden = false;
    const c = row.change;
    if (typeof c !== 'number') {
      el.classList.add('flat');
      el.textContent = 'No earlier two weeks to compare';
      return;
    }
    if (c === 0) {
      el.classList.add('flat');
      el.textContent = 'Same as the two weeks before';
      return;
    }
    el.classList.add(c > 0 ? 'up' : 'down');
    el.append(h('span', 'arrow', c > 0 ? '▲' : '▼'), document.createTextNode(' ' + pct(c) + ' vs ' + money(row.prev_total) + ' before'));
  });

  // 14-day line graph with the daily average drawn as a dashed line. Touch or hover a day to read it.
  // The note above the graph says how much is left to spend today to stay at or under the average.
  let lastLineD = null;
  dash.draw('days', (el) => {
    const st = stateOf(['by_day']);
    el.replaceChildren();
    el.classList.toggle('is-loading', st === 'loading');
    const scrub = el.parentElement.querySelector('.scrub');
    const rest = 'Touch the line to see a day';
    if (scrub) scrub.textContent = rest;
    if (st === 'error') {
      el.append(failLine());
      return;
    }
    if (st !== 'ok') return;
    const data = rowsOf('by_day');
    const byDay = new Map(data.map((r) => [r.day, r]));
    const kpi = kpiRow();
    // The line to stay under: the limit set in Settings, or else the 14-day daily average.
    const limit = typeof window.spendLimit === 'number' && window.spendLimit > 0 ? window.spendLimit : 0;
    const average = kpi && typeof kpi.per_day === 'number' && kpi.per_day > 0 ? kpi.per_day : 0;
    const avg = limit || average;
    const word = limit ? 'daily limit' : 'daily average';
    const today = d3.timeDay.floor(new Date());
    let first = d3.timeDay.offset(today, -14);
    let last = today;
    data.forEach((r) => {
      const d = parseDay(r.day);
      if (!d) return;
      if (d < first) first = d;
      if (d > last) last = d;
    });
    const days = d3.timeDay.range(first, d3.timeDay.offset(last, 1));
    const amountOf = (d) => Math.max(0, (byDay.get(dayKey(d)) || {}).amount || 0);

    const pet = document.querySelector('#pet');
    if (pet) {
      const leftNow = avg > 0 ? avg - amountOf(today) : 1;
      const hour = new Date().getHours();
      pet.dataset.mood = leftNow < 0 ? 'dizzy' : (hour >= 22 || hour < 6) ? 'sleepy' : avg > 0 && leftNow / avg < 0.35 ? 'worried' : 'happy';
    }
    if (avg > 0) {
      const spent = amountOf(today);
      const left = Math.round((avg - spent) * 100) / 100;
      const note = h('div', 'avg-note ' + (left >= 0 ? 'under' : 'over'));
      note.append(
        h('span', 'avg-big', left >= 0 ? money(left) + ' left today' : money(-left) + ' over today'),
        h('span', 'avg-small', (spent > 0 ? money(spent) + ' spent so far' : 'Nothing spent yet') + ' · ' + money(avg) + ' ' + word)
      );
      const ratio = Math.max(0, Math.min(1, left / avg));
      const hp = h('div', 'hp' + (left < 0 ? ' ko crit' : ratio < 0.25 ? ' crit' : ratio < 0.5 ? ' low' : ''));
      const track = h('div', 'hp-track');
      const fill = h('div', 'hp-fill');
      fill.style.width = (ratio * 100) + '%';
      track.append(fill);
      hp.append(h('span', 'hp-label', 'HP'), track, h('span', 'hp-num', left < 0 ? 'K.O.' : money(left)));
      note.append(hp);
      // Days in a row at or under the line, counting back from yesterday (today is still being played).
      const firstDay = data.length ? parseDay(data[0].day) : null;
      let streak = 0;
      if (firstDay) {
        for (let d = d3.timeDay.offset(today, -1); d >= firstDay; d = d3.timeDay.offset(d, -1)) {
          if (amountOf(d) <= avg) streak++;
          else break;
        }
      }
      if (streak > 0) {
        const badge = h('span', 'streak');
        badge.append(h('span', 'flame', '🔥'), document.createTextNode(freshOn() ? ' ' + streak + '-day streak' : ' ' + streak + '-DAY STREAK'));
        note.append(badge);
      }
      if (streak > 0) window.dispatchEvent(new CustomEvent('spend:streak', { detail: streak }));
      if (left < 0) window.dispatchEvent(new CustomEvent('spend:over', { detail: -left }));

      // Candy theme: a jar of candies that empties as you spend, and today's candies by category.
      const jar = h('div', 'jar' + (ratio < 0.3 ? ' low' : ''));
      const glass = h('div', 'jar-glass');
      const jfill = h('div', 'jar-fill');
      jfill.style.height = 'calc(' + Math.round(ratio * 100) + '% - 6px)';
      glass.append(jfill);
      const side = h('div', 'jar-side');
      side.append(h('span', 'jar-left', left >= 0 ? money(left) + ' of candy left today' : 'The candy jar is empty'));
      const todayKey = dayKey(today);
      const byCatToday = {};
      rowsOf('spend').filter((r) => r.period === 'now' && r.day === todayKey && r.amount > 0)
        .forEach((r) => { byCatToday[r.category] = (byCatToday[r.category] || 0) + r.amount; });
      const candies = h('div', 'candies');
      Object.entries(byCatToday).sort((a, b) => b[1] - a[1]).slice(0, 4).forEach(([c, v]) => {
        const [icon, color] = catMeta(c);
        const pill = h('span', 'candy', icon + ' ' + money(Math.round(v * 100) / 100));
        pill.style.setProperty('--c', color);
        pill.title = c;
        candies.append(pill);
      });
      if (!candies.childElementCount) candies.append(h('span', 'candy', '✨ nothing eaten yet'));
      side.append(candies);
      jar.append(glass, side);
      note.append(jar);
      const edit = h('button', 'link set-limit', limit ? 'Change limit' : 'Set your own limit');
      edit.type = 'button';
      edit.addEventListener('click', () => window.spendOpenLimit && window.spendOpenLimit());
      note.append(edit);
      el.append(note);
    }

    const W = Math.max(el.clientWidth, 260);
    const H = 150;
    const top = 14;
    const bottom = 20;
    const plotEnd = W - 54; // the strip to the right of this holds the average label
    const maxV = Math.max(d3.max(days, amountOf) || 0, avg) || 1;
    const y = d3.scaleLinear([0, maxV * 1.12], [H - bottom, top]);
    const x = d3.scalePoint(days.map(dayKey), [10, plotEnd - 4]);
    const px = (d) => x(dayKey(d));
    const svg = d3.select(el).append('svg').attr('class', 'line-svg').attr('width', '100%').attr('viewBox', '0 0 ' + W + ' ' + H).attr('role', 'img')
      .attr('aria-label', 'Spending for each of the last two weeks' + (avg > 0 ? ', with the ' + word + ' of ' + money(avg) : ''));

    const grad = svg.append('defs').append('linearGradient').attr('id', 'sp-area').attr('x1', 0).attr('x2', 0).attr('y1', 0).attr('y2', 1);
    grad.append('stop').attr('offset', '0%').attr('class', 'grad-top');
    grad.append('stop').attr('offset', '100%').attr('class', 'grad-bot');

    svg.append('line').attr('class', 'base').attr('x1', 0).attr('x2', plotEnd).attr('y1', y(0)).attr('y2', y(0));
    const retro = !!(window.spendRetro && window.spendRetro());
    const curve = retro ? d3.curveStep : d3.curveMonotoneX;
    svg.append('path').attr('class', 'area').attr('fill', 'url(#sp-area)')
      .attr('d', d3.area().x(px).y0(y(0)).y1((d) => y(amountOf(d))).curve(curve)(days));
    const lineD = d3.line().x(px).y((d) => y(amountOf(d))).curve(curve)(days);
    const linePath = svg.append('path').attr('class', 'line').attr('id', 'sp-line-path').attr('d', lineD);
    const drawIn = freshOn() && !calm() && lineD !== lastLineD;
    lastLineD = lineD;
    if (drawIn) {
      const node = linePath.node();
      const len = node.getTotalLength ? node.getTotalLength() : 0;
      if (len > 0) {
        node.style.strokeDasharray = len;
        node.style.strokeDashoffset = len;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          node.style.transition = 'stroke-dashoffset 1.1s cubic-bezier(.4, 0, .2, 1)';
          node.style.strokeDashoffset = '0';
        }));
        setTimeout(() => { node.style.strokeDasharray = ''; node.style.transition = ''; }, 1300);
      }
      svg.select('.area').classed('fade-in', true);
    }

    if (avg > 0) {
      const ay = y(avg);
      svg.append('line').attr('class', 'avg-line').attr('x1', 0).attr('x2', plotEnd).attr('y1', ay).attr('y2', ay);
      // The label sits in the strip at the end of the dashed line, clear of the data.
      const ly = Math.min(ay, y(0) - 12);
      svg.append('text').attr('class', 'avg-label').attr('x', plotEnd + 5).attr('y', ly - 3).text(limit ? 'Your limit' : 'Daily avg');
      svg.append('text').attr('class', 'avg-label avg-amt').attr('x', plotEnd + 5).attr('y', ly + 11).text(money(avg));
    }

    const guide = svg.append('line').attr('class', 'guide').attr('y1', top - 4).attr('y2', y(0)).attr('visibility', 'hidden');
    const radius = (d) => (d.getTime() === today.getTime() ? 5.5 : amountOf(d) > 0 ? 3.8 : 2.6);
    const dots = svg.append('g').selectAll('circle').data(days).join('circle')
      .attr('class', (d) => 'dot' + (amountOf(d) === 0 ? ' zero' : '') + (avg > 0 && amountOf(d) > avg ? ' over' : '') + (d.getTime() === today.getTime() ? ' today' : ''))
      .attr('cx', px)
      .attr('cy', (d) => y(amountOf(d)))
      .attr('r', radius);
    if (drawIn) dots.classed('pop', true).style('animation-delay', (d, i) => (0.25 + i * 0.06).toFixed(2) + 's');

    if (retro) {
      const NS = 'http://www.w3.org/2000/svg';
      const runner = svg.append('g').attr('class', 'runner').attr('aria-hidden', 'true');
      const art = runner.append('g').attr('class', 'bob').attr('transform', 'translate(-9,-17)');
      const paint = (g, rows) => rows.forEach((row, ry) => [...row].forEach((c, rx) => {
        const fillOf = { G: '#ffd23f', K: '#120d26', W: '#fff3b0' }[c];
        if (fillOf) g.append('rect').attr('x', rx * 2).attr('y', ry * 2).attr('width', 2).attr('height', 2).attr('fill', fillOf);
      }));
      paint(art, ['..GGGGG..', '.GGGGGGG.', '.GKGGGKG.', '.GGGGGGG.', 'GGGWWWGGG', '.GGGGGGG.']);
      paint(art.append('g').attr('class', 'legs-a').attr('transform', 'translate(0,12)'), ['.GG...GG.', 'GG.....GG']);
      paint(art.append('g').attr('class', 'legs-b').attr('transform', 'translate(0,12)'), ['..GG.GG..', '..GG.GG..']);
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        runner.attr('transform', 'translate(' + px(today) + ',' + y(amountOf(today)) + ')');
      } else {
        const move = document.createElementNS(NS, 'animateMotion');
        move.setAttribute('dur', Math.max(6, days.length * 0.6) + 's');
        move.setAttribute('repeatCount', 'indefinite');
        const mp = document.createElementNS(NS, 'mpath');
        mp.setAttribute('href', '#sp-line-path');
        mp.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', '#sp-line-path');
        move.append(mp);
        runner.node().append(move);
      }
    }

    const axis = svg.append('g').attr('class', 'bars-axis');
    axis.append('text').attr('x', 2).attr('y', H - 4).attr('text-anchor', 'start').text(dayShort(days[0]));
    axis.append('text').attr('x', plotEnd + 6).attr('y', H - 4).attr('text-anchor', 'end').text('Today');

    const show = (event, d) => {
      const rec = byDay.get(dayKey(d));
      if (scrub) {
        const diff = avg > 0 ? amountOf(d) - avg : 0;
        scrub.textContent = dayLong(d) + ' · ' + (rec ? money(rec.amount) + ' · ' + rec.count + (rec.count === 1 ? ' purchase' : ' purchases') : 'no spending') +
          (avg > 0 ? ' · ' + money(Math.abs(diff)) + (diff <= 0 ? ' under' : ' over') + (limit ? ' limit' : ' avg') : '');
      }
      guide.attr('x1', px(d)).attr('x2', px(d)).attr('visibility', 'visible');
      dots.attr('r', (p) => (p === d ? radius(p) + 2 : radius(p)));
    };
    const hide = () => {
      if (scrub) scrub.textContent = rest;
      guide.attr('visibility', 'hidden');
      dots.attr('r', radius);
    };
    svg.append('g').selectAll('rect').data(days).join('rect')
      .attr('x', (d) => px(d) - x.step() / 2)
      .attr('width', x.step())
      .attr('y', 0)
      .attr('height', H - bottom)
      .attr('fill', 'transparent')
      .on('pointerenter', show)
      .on('pointermove', show)
      .on('pointerdown', show)
      .on('pointerleave', hide)
      .on('pointercancel', hide);
  });

  // Categories: a stacked bar, then one row per category. Tap a row to filter the purchases below.
  dash.draw('seg', (el) => {
    const st = stateOf(['by_cat']);
    el.replaceChildren();
    el.classList.toggle('is-loading', st === 'loading');
    if (st !== 'ok') return;
    rowsOf('by_cat').forEach((r) => {
      const s = h('span', 'seg-part');
      s.style.flexGrow = String(Math.max(r.share, 0.02));
      s.style.setProperty('--c', catMeta(r.category)[1]);
      s.title = r.category;
      s.classList.toggle('dim', !!activeCat && activeCat !== r.category);
      el.append(s);
    });
  });

  dash.draw('cats', (el) => {
    const st = stateOf(['by_cat']);
    el.replaceChildren();
    el.classList.toggle('is-loading', st === 'loading');
    if (st === 'error') {
      el.append(failLine());
      return;
    }
    if (st !== 'ok') return;
    rowsOf('by_cat').forEach((r) => {
      const [icon, color] = catMeta(r.category);
      const row = h('button', 'cat' + (activeCat === r.category ? ' on' : ''));
      row.type = 'button';
      row.setAttribute('aria-pressed', activeCat === r.category ? 'true' : 'false');
      const mid = h('span', 'cat-mid');
      mid.append(h('span', 'cat-name', r.category));
      const sub = h('span', 'cat-sub');
      sub.append(document.createTextNode(share(r.share) + ' of spending'));
      if (typeof r.change === 'number' && r.change !== 0) {
        sub.append(document.createTextNode(' · '), h('span', r.change > 0 ? 'up-text' : 'down-text', (r.change > 0 ? '▲ ' : '▼ ') + pct(r.change)));
      } else if (typeof r.change !== 'number') {
        sub.append(document.createTextNode(' · new'));
      }
      mid.append(sub);
      row.append(chip(icon, color), mid, h('span', 'cat-amt', money(r.amount)));
      if (firstLists && freshOn() && !calm()) {
        row.classList.add('enter');
        row.style.setProperty('--i', String(el.childElementCount));
      }
      row.addEventListener('click', () => {
        activeCat = activeCat === r.category ? null : r.category;
        showAll = false;
        dash.render();
        if (activeCat) {
          const card = document.querySelector('#latest');
          if (card) card.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
        }
      });
      el.append(row);
    });
  });

  dash.draw('merch', (el) => {
    const st = stateOf(['top_merchants']);
    el.replaceChildren();
    el.classList.toggle('is-loading', st === 'loading');
    if (st === 'error') {
      el.append(failLine());
      return;
    }
    if (st !== 'ok') return;
    const rows = rowsOf('top_merchants');
    const max = d3.max(rows, (r) => r.amount) || 1;
    rows.forEach((r) => {
      const row = h('div', 'merch');
      const letter = (r.merchant.trim()[0] || '?').toUpperCase();
      const mid = h('span', 'cat-mid');
      mid.append(h('span', 'cat-name', r.merchant), h('span', 'cat-sub', r.count + (r.count === 1 ? ' purchase' : ' purchases')));
      const track = h('span', 'merch-track');
      const fill = h('span', 'merch-fill');
      fill.style.width = Math.max(4, (r.amount / max) * 100) + '%';
      fill.style.setProperty('--c', colorFor(r.merchant));
      track.append(fill);
      mid.append(track);
      row.append(chip(letter, colorFor(r.merchant), 'letter'), mid, h('span', 'cat-amt', money(r.amount)));
      el.append(row);
    });
  });

  // Swipe a purchase to the left: a red Delete button slides in. Tap it, or keep swiping to delete at once.
  // (Undo stays on screen afterwards.) Tapping a row that is open just closes it.
  let openSwipe = null;
  const REVEAL = 88;
  document.addEventListener('touchstart', (e) => {
    if (openSwipe && !openSwipe.wrap.contains(e.target)) openSwipe.close();
  }, { passive: true });
  const makeSwipe = (wrap, row, del, onOpenRow, onDelete) => {
    let x0 = 0;
    let y0 = 0;
    let base = 0;
    let offset = 0;
    let mode = null;
    let moved = false;
    let busy = false;
    const api = {
      wrap,
      close: () => {
        row.style.transition = '';
        row.style.transform = '';
        offset = 0;
        if (openSwipe === api) openSwipe = null;
        setTimeout(() => { if (offset === 0) wrap.classList.remove('swiping'); }, 250);
      }
    };
    const setOffset = (v) => {
      offset = v;
      if (v < 0) wrap.classList.add('swiping');
      row.style.transform = 'translateX(' + v + 'px)';
    };
    const remove = async () => {
      if (busy) return;
      busy = true;
      if (window.spendPoof) window.spendPoof(wrap);
      row.style.transition = 'transform .18s ease-out';
      setOffset(-wrap.clientWidth);
      const done = await onDelete();
      if (!done) {
        api.close();
        busy = false;
      }
    };
    wrap.addEventListener('touchstart', (e) => {
      if (busy || !e.touches || e.touches.length !== 1) return;
      if (openSwipe && openSwipe !== api) openSwipe.close();
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
      base = openSwipe === api ? -REVEAL : 0;
      mode = null;
      moved = false;
      row.style.transition = 'none';
    }, { passive: true });
    wrap.addEventListener('touchmove', (e) => {
      if (busy || !e.touches || !e.touches.length) return;
      const dx = e.touches[0].clientX - x0;
      const dy = e.touches[0].clientY - y0;
      if (mode === null && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) mode = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      if (mode !== 'h') return;
      moved = true;
      setOffset(Math.max(-wrap.clientWidth, Math.min(0, base + dx)));
    }, { passive: true });
    const finish = () => {
      if (busy) return;
      row.style.transition = 'transform .2s ease';
      if (mode !== 'h') return;
      if (offset < -Math.min(wrap.clientWidth * 0.6, 240)) {
        remove();
      } else if (offset < -REVEAL / 2) {
        setOffset(-REVEAL);
        openSwipe = api;
      } else {
        api.close();
      }
    };
    // A drag is followed by a stray click on some phones; ignore that click, but never longer than a moment.
    wrap.addEventListener('touchend', () => { finish(); setTimeout(() => { moved = false; }, 350); });
    wrap.addEventListener('touchcancel', () => { row.style.transition = 'transform .2s ease'; if (mode === 'h') api.close(); });
    row.addEventListener('click', () => {
      if (moved) { moved = false; return; }
      if (openSwipe === api) { api.close(); return; }
      onOpenRow();
    });
    del.addEventListener('click', remove);
  };

  if (window.dash) window.dash.onData(() => { if (stateOf(['by_cat']) === 'ok' && firstLists) setTimeout(() => { firstLists = false; }, 0); });

  // Purchases grouped by day with a total per day. Used by the Purchases card and the full list.
  const drawTxRows = (el, rows, shown, onPick) => {
    const todayKey = dayKey(new Date());
    const yesterdayKey = dayKey(d3.timeDay.offset(d3.timeDay.floor(new Date()), -1));
    const label = (key) => (key === todayKey ? 'Today' : key === yesterdayKey ? 'Yesterday' : parseDay(key) ? dayLong(parseDay(key)) : key);
    const groups = [];
    shown.forEach((r) => {
      const g = groups[groups.length - 1];
      if (g && g.day === r.day) g.rows.push(r);
      else groups.push({ day: r.day, rows: [r] });
    });
    groups.forEach((g) => {
      const total = rows.filter((r) => r.day === g.day).reduce((s, r) => s + r.amount, 0);
      const head = h('div', 'day-head');
      head.append(h('span', '', label(g.day)), h('span', 'day-total', money(Math.round(total * 100) / 100)));
      el.append(head);
      g.rows.forEach((r) => {
        const [icon, color] = catMeta(r.category);
        const row = h('button', 'tx');
        row.type = 'button';
        row.dataset.key = r.id;
        row.setAttribute('aria-label', 'Edit ' + r.merchant);
        const mid = h('span', 'cat-mid');
        mid.append(h('span', 'cat-name', r.merchant), h('span', 'cat-sub', (r.ts ? clock(new Date(r.ts)) + ' · ' : '') + r.category + (String(r.id).indexOf('p-') === 0 ? ' · not sent yet' : '')));
        const amt = h('span', 'cat-amt' + (r.amount < 0 ? ' in' : ''), r.amount < 0 ? '+' + money(-r.amount) : money(r.amount));
        row.append(chip(icon, color), mid, amt);
        if (String(r.id).indexOf('p-') === 0) {
          row.addEventListener('click', () => onPick(r));
          el.append(row);
          return;
        }
        const wrap = h('div', 'tx-swipe');
        const del = h('button', 'tx-del', 'Delete');
        del.type = 'button';
        del.setAttribute('aria-label', 'Delete ' + r.merchant);
        wrap.append(del, row);
        makeSwipe(wrap, row, del, () => onPick(r), () => (window.spendDelete ? window.spendDelete(r) : Promise.resolve(false)));
        el.append(wrap);
      });
    });
  };

  // Purchases, grouped by day, newest first.
  dash.draw('tx', (el) => {
    const st = stateOf(['spend']);
    el.replaceChildren();
    el.classList.toggle('is-loading', st === 'loading');
    if (st === 'error') {
      el.append(failLine());
      return;
    }
    if (st !== 'ok') return;
    const all = rowsOf('spend').filter((r) => r.period === 'now');
    const rows = activeCat ? all.filter((r) => r.category === activeCat) : all;
    if (activeCat) {
      const bar = h('div', 'filter');
      bar.append(h('span', '', 'Showing ' + activeCat));
      const clear = h('button', 'link', 'Show all');
      clear.type = 'button';
      clear.addEventListener('click', () => {
        activeCat = null;
        showAll = false;
        dash.render();
      });
      bar.append(clear);
      el.append(bar);
    }
    drawTxRows(el, rows, showAll ? rows : rows.slice(0, TX_LIMIT), (r) => { if (window.spendEdit) window.spendEdit(r); });
    if (!rows.length) el.append(h('p', 'empty-line', 'Nothing here for the last two weeks.'));
    if (rows.length > TX_LIMIT && !showAll) {
      const more = h('button', 'more', 'Show all ' + rows.length + ' purchases');
      more.type = 'button';
      more.addEventListener('click', () => {
        if (!activeCat && window.spendOpenAll) { window.spendOpenAll(false); return; }
        showAll = true;
        dash.render();
      });
      el.append(more);
    }
  });

  // The expand button next to "Purchases": every purchase from the last four weeks, in a scrollable panel.
  dash.draw('all_tx', (el) => {
    const st = stateOf(['spend']);
    el.replaceChildren();
    if (st === 'error') {
      el.append(failLine());
      return;
    }
    if (st !== 'ok') return;
    const rows = rowsOf('spend');
    const total = Math.round(rows.reduce((sum, r) => sum + r.amount, 0) * 100) / 100;
    const sum = document.querySelector('#all-summary');
    if (sum) sum.textContent = rows.length ? rows.length + (rows.length === 1 ? ' purchase' : ' purchases') + ' · ' + money(total) + ' in the last 4 weeks' : '';
    if (!rows.length) {
      el.append(h('p', 'empty-line', 'No purchases in the last four weeks.'));
      return;
    }
    drawTxRows(el, rows, rows, (r) => {
      // Purchases not sent yet only show a note, so the list stays open for those.
      if (String(r.id).indexOf('p-') !== 0 && window.spendCloseAll) {
        window.spendCloseAll();
        window.spendListReturn = true;
      }
      if (window.spendEdit) window.spendEdit(r);
    });
  });

  document.querySelectorAll('.sp-refresh').forEach((b) => {
    b.addEventListener('click', () => {
      dash.refresh('mail_now');
      dash.refresh('mail_prev');
    });
  });

  dash.onData(() => {
    const k = dash.data('kpi');
    const m = dash.data('mail_now');
    const p = dash.data('mail_prev');
    const row = k.status === 'ok' ? (k.data || [])[0] : null;
    const empty = !!row && row.cur_count === 0;
    const connect = m.status === 'connect' || m.status === 'declined' || p.status === 'connect' || p.status === 'declined';
    const busy = !!(m.refreshing || p.refreshing || m.status === 'loading');
    document.querySelectorAll('.sp-js-connect').forEach((e) => { e.hidden = !connect; });
    document.querySelectorAll('.sp-js-empty').forEach((e) => { e.hidden = !empty; });
    document.querySelectorAll('.sp-js-full').forEach((e) => { e.hidden = empty; });
    document.querySelectorAll('.sp-refresh').forEach((b) => {
      b.disabled = busy;
      b.classList.toggle('spin', busy);
    });
  });
})();
