/* The saving game (Fresh theme). Every dollar you don't spend under your daily limit becomes coins you feed to Penny:
   they fill a goal you name and earn XP, and levels unlock outfits for Penny. Moving the money to savings for real
   earns a golden coin. Game data lives on the server (/api/game); this file draws it and runs the playful bits:
   coins flying into Penny, her dances, and her reactions when you tap, double-tap or hold her. */
(function () {
  const $ = (s) => document.querySelector(s);
  const zone = $('#game');
  if (!zone || !window.spendApi) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const fresh = () => document.documentElement.classList.contains('candy');
  const appShown = () => { const a = $('#app'); return a && !a.hidden; };
  const read = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } };
  const clear = (k) => { try { localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } };
  const cad = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });
  const money = (v) => cad.format(Math.round(v * 100) / 100).replace('CA', '');
  const short = (v) => (Math.round(v) === v ? '$' + v.toLocaleString('en-CA') : money(v));
  const penny = () => window.spendPenny || { act() {}, say() {} };
  const pet = () => $('#pet');

  const OUTFITS = { hat: 'a party hat 🎉', shades: 'cool sunglasses 😎', bow: 'a pink bow 🎀', crown: 'a royal crown 👑', gold: 'a golden glow ✨' };
  const EMOJI = ['✈️', '🏖️', '🎮', '📱', '💻', '🚗', '🏠', '🎓', '💍', '🎸', '🐶', '🎁', '👟', '🎧', '📷', '💰'];
  const OFFER = 'spend.realOffer';
  let state = null;

  // ---- drawing ----
  const goalLine = (st) => {
    const g = st.goal;
    const left = Math.max(0, g.amount - g.saved);
    if (left <= 0) return 'Goal reached! 🎉 Penny is so proud of you';
    let line = money(g.saved) + ' of ' + short(g.amount);
    const since = st.started ? Math.max(1, Math.round((Date.now() - Date.parse(st.started)) / 86400e3)) : 0;
    const days = Math.max(st.daysCollected, since);
    if (st.daysCollected >= 3 && g.saved > 0) {
      // Future you: where this pace gets you.
      const eta = new Date(Date.now() + Math.ceil(left / (g.saved / days)) * 86400e3);
      line += ' · at this pace by ' + eta.toLocaleDateString('en-CA', { month: 'short', year: 'numeric' });
    } else {
      // Goal gradient: the next milestone is always close.
      const step = g.amount / 10;
      line += ' · ' + money(Math.min(left, step - (g.saved % step))) + ' to the next milestone';
    }
    return line;
  };

  const renderOffer = () => {
    let o = null;
    try { o = JSON.parse(read(OFFER) || 'null'); } catch (e) { o = null; }
    const box = $('#real-offer');
    if (!o || !o.coins || Date.now() - o.at > 3 * 86400e3) {
      box.hidden = true;
      return null;
    }
    box.hidden = false;
    $('#real-text').textContent = 'Move ' + money(o.coins) + ' to your savings account for real, then tap for a golden coin (+' + Math.floor(o.coins) + ' XP).';
    return o;
  };

  const render = (st) => {
    state = st;
    zone.hidden = false;
    const g = st.goal;
    const has = !!(g.name && g.amount > 0);
    $('#goal-emoji').textContent = has ? (g.emoji || '🎯') : '🎯';
    $('#goal-name').textContent = has ? g.name : 'Pick something to save for';
    $('#goal-fill').style.width = (has ? Math.min(100, (g.saved / g.amount) * 100) : 0) + '%';
    $('#goal-sub').textContent = !st.limit
      ? 'Set a daily limit (the target button at the top) to start earning coins 🪙'
      : has ? goalLine(st) : 'Penny saves every dollar you don\'t spend';
    $('#lvl-badge').textContent = 'Lv ' + st.level;
    const span = Math.max(1, st.nextXp - st.levelXp);
    $('#xp-fill').style.width = Math.min(100, ((st.xp - st.levelXp) / span) * 100) + '%';
    $('#xp-num').textContent = (st.xp - st.levelXp) + ' / ' + span + ' XP';
    const p = pet();
    if (p) p.dataset.outfit = st.outfit || '';
    const btn = $('#collect-btn');
    btn.hidden = !(st.coins > 0);
    btn.disabled = false;
    $('#collect-amt').textContent = st.coins > 0 ? money(st.coins) + (st.collectible.length > 1 ? ' · ' + st.collectible.length + ' days' : '') : '';
    renderOffer();
  };

  // ---- loading ----
  let lastLoad = 0;
  let busy = false;
  let greeted = false;
  const load = async (force) => {
    if (!fresh() || !appShown() || !window.spendSession.get() || busy) return;
    if (!force && Date.now() - lastLoad < 5000) return;
    lastLoad = Date.now();
    try {
      render(await window.spendApi('GET', 'game'));
      if (!greeted) {
        greeted = true;
        // Coins waiting: Penny lets you know, after her hello.
        if (state.coins > 0 && !reduce.matches) setTimeout(() => { penny().act('shimmy', 950); penny().say('Coins waiting! 🪙', 1700); }, 2400);
      }
    } catch (e) { /* offline: keep what is shown */ }
  };
  if (window.dash) window.dash.onData(() => { const d = window.dash.data('spend'); if (d && d.status === 'ok') load(false); });
  window.addEventListener('spend:theme', () => { zone.hidden = true; load(true); });

  // ---- coins flying into Penny ----
  const slot = () => {
    const p = pet();
    if (!p) return null;
    const r = p.getBoundingClientRect();
    return r.width ? { x: r.left + r.width * 0.5, y: r.top + r.height * 0.2 } : null;
  };
  const fly = (from, to, count, gold, onLand) => new Promise((resolve) => {
    if (reduce.matches || !to || !document.body.animate) {
      for (let i = 1; i <= count; i++) onLand(i);
      resolve();
      return;
    }
    let landed = 0;
    for (let i = 0; i < count; i++) {
      const c = document.createElement('div');
      c.className = 'fly-coin' + (gold ? ' gold' : '');
      c.textContent = '🪙';
      const sx = from.x + (gold ? 0 : Math.random() * 40 - 20);
      c.style.left = (sx - 12) + 'px';
      c.style.top = (from.y - 12) + 'px';
      document.body.append(c);
      const dx = to.x - sx;
      const dy = to.y - from.y;
      const a = c.animate([
        { transform: 'translate(0, 0) scale(.5) rotate(0deg)', opacity: 0 },
        { transform: 'translate(' + dx * 0.35 + 'px, ' + (dy * 0.35 - 80) + 'px) scale(1.15) rotate(200deg)', opacity: 1, offset: 0.45 },
        { transform: 'translate(' + dx + 'px, ' + dy + 'px) scale(.45) rotate(400deg)', opacity: 0.9 }
      ], { duration: gold ? 1000 : 760, delay: i * 115, easing: 'cubic-bezier(.3, .6, .4, 1)', fill: 'forwards' });
      a.onfinish = () => {
        c.remove();
        landed++;
        onLand(landed);
        if (landed === count) resolve();
      };
    }
  });

  const levelUp = (st) => {
    const gift = OUTFITS[st.outfit];
    penny().act('victory', 1450);
    if (window.spendCelebrate) window.spendCelebrate('⭐ Level ' + st.level + '!', gift ? 'Penny unlocked ' + gift : 'Penny is getting stronger 💪');
  };

  const collectBtn = $('#collect-btn');
  collectBtn.addEventListener('click', async () => {
    if (!state || collectBtn.disabled) return;
    collectBtn.disabled = true;
    busy = true;
    let res;
    try {
      res = await window.spendApi('POST', 'game/collect');
    } catch (e) {
      busy = false;
      collectBtn.disabled = false;
      penny().say('Oops, try again 🙈', 1500);
      return;
    }
    const g = res.gained;
    const b = collectBtn.getBoundingClientRect();
    const p = pet();
    const count = Math.max(4, Math.min(14, g.days.length * 3));
    let bubble = null;
    if (p) {
      p.classList.add('act-eat');
      bubble = document.createElement('div');
      bubble.className = 'say count';
      bubble.textContent = '+$0.00';
      p.append(bubble);
    }
    await fly({ x: b.left + b.width / 2, y: b.top + b.height / 2 }, slot(), count, false, (n) => {
      if (bubble) bubble.textContent = '+' + money((g.coins * n) / count) + ' 🪙';
    });
    if (bubble) bubble.remove();
    if (p) p.classList.remove('act-eat');
    busy = false;
    penny().act('dance', 1650);
    penny().say(g.coins > 0 ? 'Yum! +' + money(g.coins) + ' saved 💖' : 'Nothing new yet 🐷', 2000);
    render(res);
    if (g.levelUp) setTimeout(() => levelUp(res), 1700);
    if (g.coins > 0) {
      write(OFFER, JSON.stringify({ days: g.days.map((d) => d.day), coins: g.coins, at: Date.now() }));
      renderOffer();
    }
  });

  // ---- the golden coin: moved to savings for real ----
  $('#real-btn').addEventListener('click', async () => {
    const o = renderOffer();
    if (!o) return;
    const btn = $('#real-btn');
    btn.disabled = true;
    try {
      const res = await window.spendApi('POST', 'game/real', { days: o.days });
      clear(OFFER);
      const b = btn.getBoundingClientRect();
      await fly({ x: b.left + b.width / 2, y: b.top + b.height / 2 }, slot(), 1, true, () => {});
      penny().act('victory', 1450);
      penny().say('Real savings! +' + res.gained.xp + ' XP 🌟', 2200);
      render(res);
      if (res.gained.levelUp) setTimeout(() => levelUp(res), 1600);
    } catch (e) {
      penny().say('Oops, try again 🙈', 1500);
    }
    btn.disabled = false;
  });
  $('#real-skip').addEventListener('click', () => { clear(OFFER); renderOffer(); });

  // ---- the goal sheet ----
  const sheet = $('#goal-sheet');
  const backdrop = $('#goal-backdrop');
  const pick = $('#emoji-pick');
  let chosen = '';
  EMOJI.forEach((e) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = e;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => {
      chosen = e;
      pick.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    });
    pick.append(b);
  });
  const goalError = (m) => { const el = $('#goal-error'); el.textContent = m || ''; el.hidden = !m; };
  const openGoal = () => {
    const g = (state && state.goal) || {};
    chosen = g.emoji || EMOJI[0];
    pick.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x.textContent === chosen)));
    $('#goal-name-input').value = g.name || '';
    $('#goal-amount-input').value = g.amount ? String(g.amount) : '';
    goalError('');
    const started = !!(state && (state.goal.name || state.xp > 0 || state.daysCollected > 0));
    $('#goal-reset').hidden = !started;
    $('#goal-reset-note').hidden = true;
    resetArmed = false;
    $('#goal-reset').textContent = 'Start over';
    backdrop.hidden = false;
    sheet.hidden = false;
    document.body.classList.add('sheet-open');
  };
  const closeGoal = () => {
    sheet.hidden = true;
    backdrop.hidden = true;
    document.body.classList.remove('sheet-open');
  };
  let resetArmed = false;
  $('#goal-reset').addEventListener('click', async () => {
    const btn = $('#goal-reset');
    if (!resetArmed) {
      resetArmed = true;
      btn.textContent = 'Tap again to clear everything';
      $('#goal-reset-note').hidden = false;
      setTimeout(() => { if (resetArmed) { resetArmed = false; btn.textContent = 'Start over'; } }, 6000);
      return;
    }
    btn.disabled = true;
    try {
      const st = await window.spendApi('DELETE', 'game');
      clear(OFFER);
      closeGoal();
      render(st);
      penny().act('hop', 650);
      penny().say('Fresh start! 🌱', 2000);
    } catch (x) {
      goalError(x && x.status ? x.message : 'Could not reset. Check your connection and try again.');
    }
    resetArmed = false;
    btn.disabled = false;
  });
  $('#goal-open').addEventListener('click', openGoal);
  $('#goal-cancel').addEventListener('click', closeGoal);
  backdrop.addEventListener('click', closeGoal);
  if (window.spendSwipeToClose) window.spendSwipeToClose(sheet, closeGoal);
  sheet.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#goal-name-input').value.trim();
    const amount = Number($('#goal-amount-input').value);
    if (!name) return goalError('Give your goal a name, like "Japan trip".');
    if (!(amount >= 1)) return goalError('Type how much it costs, like 1000.');
    const save = $('#goal-save');
    save.disabled = true;
    try {
      const st = await window.spendApi('PUT', 'game/goal', { name, emoji: chosen, amount });
      closeGoal();
      render(st);
      penny().act('hop', 650);
      penny().say("Let's do this! 💪", 1800);
    } catch (x) {
      goalError(x && x.status ? x.message : 'Could not save. Check your connection and try again.');
    }
    save.disabled = false;
  });

  // ---- Penny: tap to giggle, double-tap to spin, hold for a tip ----
  const tips = () => {
    const out = ['Every dollar you don\'t spend feeds me 🐷', 'Tiny wins add up ✨', 'Coins come at the end of each day 🪙'];
    if (state && state.coins > 0) out.unshift('I smell coins! Tap Collect 🪙');
    if (state && state.goal.name && state.goal.amount > state.goal.saved) out.push(short(Math.ceil(state.goal.amount - state.goal.saved)) + ' to go for ' + state.goal.name + ' ' + (state.goal.emoji || ''));
    const cats = window.dash && window.dash.data('by_cat');
    const top = cats && cats.status === 'ok' && cats.data && cats.data[0];
    if (top) out.push('Most of your money went to ' + top.category + ' lately (' + money(top.amount) + ') 👀');
    return out[Math.floor(Math.random() * out.length)];
  };
  const heart = () => {
    const p = pet();
    if (!p || reduce.matches) return;
    const h = document.createElement('span');
    h.className = 'heart';
    h.textContent = ['💖', '💕', '✨', '😊'][Math.floor(Math.random() * 4)];
    p.append(h);
    setTimeout(() => h.remove(), 1000);
  };
  const p0 = pet();
  if (p0) {
    let holdTimer = null;
    let lastTap = 0;
    p0.addEventListener('pointerdown', () => {
      if (!fresh()) return;
      holdTimer = setTimeout(() => { holdTimer = null; penny().act('look', 1400); penny().say(tips(), 3200); }, 550);
    });
    const cancel = () => { clearTimeout(holdTimer); holdTimer = null; };
    p0.addEventListener('pointerleave', cancel);
    p0.addEventListener('pointercancel', cancel);
    p0.addEventListener('pointerup', () => {
      if (!fresh() || !holdTimer) return;
      cancel();
      const now = Date.now();
      if (now - lastTap < 320) {
        lastTap = 0;
        penny().act('spin', 760);
        penny().say('Wheee! 🌀', 1200);
      } else {
        lastTap = now;
        setTimeout(() => {
          if (lastTap !== now) return;
          penny().act('giggle', 620);
          heart();
        }, 330);
      }
    });
    p0.addEventListener('contextmenu', (e) => e.preventDefault());
  }
})();
