(function () {
  // "Stay conscious" card, in all three looks: a battery that drains as you spend today, and a streak of days under your limit.
  // Everything is worked out on this phone from the purchases the app already has (no extra server call). The streak rules
  // live in streak.js and are tested there; this file only draws them.
  const dash = window.dash;
  const S = window.spendStreak;
  const sec = document.querySelector('#stay');
  if (!dash || !S || !sec) return;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const money = (n) => (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };
  const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const todayKey = () => { const d = new Date(); const p = (n) => (n < 10 ? '0' : '') + n; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
  const weekday = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString('en-US', { weekday: 'long' }) : s; };
  const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const dowOf = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); return m ? DOW[(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getDay() + 6) % 7] : ''; };
  const MARK = { ok: '✓', skip: '⏸', bad: '✕', today: '', none: '' };

  // What you spent each day: both halves of the app's 28 days of purchases added up by day.
  const byDayOf = () => {
    const d = dash.data('spend');
    if (!d || d.status !== 'ok') return null;
    const out = {};
    (d.data || []).forEach((r) => { if (r.day) out[r.day] = Math.round(((out[r.day] || 0) + r.amount) * 100) / 100; });
    return out;
  };
  const dailyLine = () => {
    const limit = typeof window.spendLimit === 'number' && window.spendLimit > 0 ? window.spendLimit : 0;
    if (limit) return { line: limit, limit: true };
    const k = dash.data('kpi');
    const avg = k && k.status === 'ok' && k.data && k.data[0] && k.data[0].per_day > 0 ? k.data[0].per_day : 0;
    return { line: avg, limit: false };
  };

  let lastSeen = null;
  const draw = (host) => {
    host.replaceChildren();
    const days = byDayOf();
    const { line, limit } = dailyLine();
    if (!days || !(line > 0)) { sec.hidden = true; return; }
    sec.hidden = false;
    const today = todayKey();
    const spent = Math.round((days[today] || 0) * 100) / 100;
    const left = Math.round((line - spent) * 100) / 100;
    const pct = Math.max(0, left / line);
    const level = left < 0 ? 'bad' : pct < 0.15 ? 'bad' : pct < 0.4 ? 'warn' : 'ok';
    sec.dataset.level = level;

    // ---- the draining battery ----
    const head = el('div', 'st-lab');
    head.append(el('span', '', 'Left to spend today'), el('span', 'st-of', 'of ' + money(line) + (limit ? ' limit' : ' daily average')));
    const big = el('div', 'st-big', money(left));
    const bat = el('div', 'st-bat' + (level === 'bad' && left >= 0 && !calm() ? ' low' : ''));
    bat.setAttribute('role', 'img');
    bat.setAttribute('aria-label', left >= 0 ? Math.round(pct * 100) + ' percent of today\'s money left' : 'Over today\'s limit by ' + money(-left));
    const fill = el('i');
    fill.style.width = (pct * 100) + '%';
    bat.append(fill, el('span', '', left >= 0 ? Math.round(pct * 100) + '%' : 'over'));
    const say = left < 0 ? 'You are ' + money(-left) + ' over today. Tomorrow starts fresh.'
      : level === 'bad' ? 'Almost empty. Anything more now is borrowed from tomorrow.'
        : level === 'warn' ? 'Getting low. Choose the next one carefully.'
          : spent === 0 ? 'Nothing spent yet today. A quiet day counts.' : 'Plenty left. Enjoy it, you earned it.';
    host.append(head, big, bat, el('p', 'st-say', say));

    // ---- the streak ----
    const r = S.compute(days, limit ? line : 0, today);
    const box = el('div', 'st-streak');
    if (!limit) {
      const row = el('div', 'st-cta');
      row.append(el('span', '', 'Set a daily limit to start a streak of days under it.'));
      const b = el('button', 'st-go', 'Set limit');
      b.type = 'button';
      b.addEventListener('click', () => window.spendOpenLimit && window.spendOpenLimit());
      row.append(b);
      box.append(row);
      host.append(box);
      return;
    }
    const best = Math.max(r.count, Number(store.get('spend.streakBest')) || 0);
    store.set('spend.streakBest', String(best));
    const top = el('div', 'st-top');
    const flame = el('div', 'st-flame', r.count > 0 ? '🔥' : '🪨');
    if (lastSeen !== null && r.count > lastSeen && !calm()) { flame.classList.add('pop'); if (navigator.vibrate) { try { navigator.vibrate(40); } catch (e) { /* not allowed */ } } }
    lastSeen = r.count;
    const num = el('div', 'st-num');
    num.append(el('b', '', String(r.count) + (r.capped ? '+' : '')), el('span', '', r.count === 1 ? 'day under your limit' : 'days under your limit'));
    top.append(flame, num);
    const week = el('div', 'st-week');
    r.week.forEach((w) => {
      const c = el('div', 'st-d ' + w.status);
      c.append(el('span', '', dowOf(w.day)), el('i', '', MARK[w.status]));
      week.append(c);
    });
    box.append(top, week);
    box.append(el('p', 'st-note', r.skipLeft ? '1 skip left this week: one day over the limit is forgiven.' : 'No skip left this week. Another day over the limit would end the streak.'));
    if (r.broke && r.broke.was >= 2) {
      const lost = el('div', 'st-lost');
      lost.append(el('b', '', 'Streak broken at ' + r.broke.was + ' days.'), document.createTextNode(' You went ' + money(r.broke.over) + ' over on ' + weekday(r.broke.day) + '. ' + (r.count ? 'Rebuilding: ' + r.count + (r.count === 1 ? ' day' : ' days') + ' so far.' : 'Day 1 starts the next day you finish under.')));
      box.append(lost);
    }
    const next = S.MILESTONES.find((m) => m > r.count);
    box.append(el('p', 'st-next', (next ? 'Next milestone: ' + next + ' days (' + (next - r.count) + ' to go).' : 'Every milestone reached.') + (best > r.count ? ' Best: ' + best + ' days.' : '')));
    host.append(box);
  };
  dash.draw('stay', draw);
})();
