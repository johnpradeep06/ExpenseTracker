/* Heroes: pig versions of the big movie heroes. Pick one in Settings; friends unlock with your best under-the-line streak.
   Your hero shows up with a power when a new purchase arrives, and the Doom pig appears the day you go over your line.
   Everything is drawn with textContent / createElement, never innerHTML. Reduce Motion turns the animations off. */
(function () {
  const $ = (s) => document.querySelector(s);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const get = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } };
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

  // need = best streak (days) to unlock. power = which animation plays.
  const HEROES = [
    { id: 'captain-penny', name: 'Captain Penny', power: 'shield', say: 'Shield up!', need: 0 },
    { id: 'loki-pig', name: 'Loki Pig', power: 'illusion', say: 'Which one is real?', need: 2 },
    { id: 'gadget-penny', name: 'Gadget Penny', power: 'repulsor', say: 'Calculating…', need: 3 },
    { id: 'widow-sow', name: 'Widow Sow', power: 'stealth', say: 'Sneaky saver', need: 5 },
    { id: 'panther-pig', name: 'Panther Pig', power: 'pounce', say: 'Pounce!', need: 7 },
    { id: 'doctor-swine', name: 'Doctor Swine', power: 'magic', say: 'Time to rewind', need: 10 },
    { id: 'thunder-pork', name: 'Thunder Pork', power: 'lightning', say: 'Thunder!', need: 14 },
    { id: 'hulk-hog', name: 'Hulk Hog', power: 'smash', say: 'SMASH!', need: 21 },
  ];
  const DOOM = { id: 'doctor-doom-pig', name: 'Doom Pig', power: 'doom', say: 'DOOMSDAY' };
  const img = (h) => { const i = el('img', 'hx-img'); i.src = 'heroes/' + h.id + '.webp'; i.alt = ''; i.decoding = 'async'; return i; };

  // ---- real frame animation: 8 frames x 5 moves per hero (idle, power, hit, cheer, sleep) ----
  const ROW = { idle: 0, power: 1, hit: 2, cheer: 3, sleep: 4 };
  const sprites = new Set();
  const setFrame = (d) => { d.style.backgroundPosition = (d._f / 7 * 100) + '% ' + (d._row / 4 * 100) + '%'; };
  const sprite = (h, cls) => {
    const d = el('div', 'hx-sp ' + (cls || ''));
    d.style.backgroundImage = 'url(heroes/' + h.id + '-sprite.webp)';
    d._row = 0; d._base = 0; d._f = 0; d._loop = true; d._done = null;
    setFrame(d); sprites.add(d);
    return d;
  };
  const anim = (d, name, done) => { if (!d) return; d._row = ROW[name]; d._f = 0; d._loop = false; d._done = done || null; setFrame(d); };
  const base = (d, name) => { d._base = ROW[name]; if (d._loop) { d._row = ROW[name]; setFrame(d); } };
  const tick = () => {
    if (document.hidden || reduce.matches) return;
    sprites.forEach((d) => {
      if (!d.isConnected) { if (!d._keep) sprites.delete(d); return; }
      if (d.offsetParent === null && getComputedStyle(d).position !== 'fixed') return;
      d._f++;
      if (d._f > 7) {
        if (d._loop) d._f = 0;
        else { const cb = d._done; d._f = 0; d._loop = true; d._row = d._base; d._done = null; if (cb) cb(); }
      }
      setFrame(d);
    });
  };
  setInterval(tick, 1000 / 12);

  const best = () => Math.max(0, Number(get('spend.best')) || 0);
  // The owner has every hero unlocked from the start.
  const allOpen = () => get('spend.owner') === '1';
  const open_ = (h) => allOpen() || best() >= h.need;
  const chosen = () => { const h = HEROES.find((x) => x.id === get('spend.hero')); return h && open_(h) ? h : HEROES[0]; };
  const appShown = () => { const a = $('#app'); return a && !a.hidden; };

  // ---- your hero lives where Penny used to: on the total card (Fresh look) ----
  const pet = $('#pet');
  let petSp = null;
  const moodRow = () => (pet && pet.dataset.mood === 'sleepy' ? 'sleep' : pet && pet.dataset.mood === 'dizzy' ? 'hit' : 'idle');
  const showPet = () => {
    if (!pet) return;
    const h = chosen();
    if (petSp && petSp.dataset.id === h.id) return;
    if (petSp) { sprites.delete(petSp); petSp.remove(); }
    petSp = sprite(h, 'body hx-pet'); petSp._keep = true; petSp.dataset.id = h.id;
    base(petSp, moodRow());
    pet.append(petSp);
    pet.dataset.hero = h.id;
  };
  window.spendHeroName = () => chosen().name;
  showPet();
  if (pet) {
    new MutationObserver(() => { if (petSp) base(petSp, moodRow()); }).observe(pet, { attributes: true, attributeFilter: ['data-mood'] });
    // Tap your hero on the total card to see their power.
    pet.addEventListener('click', () => { anim(petSp, 'power'); play(chosen()); });
    // Every few seconds they do a little trick of their own.
    const trick = () => {
      if (petSp && !document.hidden && appShown() && moodRow() === 'idle' && petSp._loop) anim(petSp, Math.random() < .5 ? 'cheer' : 'power');
      setTimeout(trick, 7000 + Math.random() * 6000);
    };
    setTimeout(trick, 5000);
  }

  // ---- the power show ----
  let busy = false;
  const play = (h, label) => {
    if (busy || reduce.matches || !appShown() || document.hidden) return;
    busy = true;
    const stage = el('div', 'hx-stage hx-' + h.power);
    let hero;
    if (h.power === 'doom') { hero = img(h); hero.classList.add('hx-hero'); } else { hero = sprite(h, 'hx-hero'); anim(hero, 'power'); }
    const fx = el('div', 'hx-fx');
    if (h.power === 'shield') { const d = el('div', 'hx-disk', '$'); fx.append(d); }
    if (h.power === 'illusion') { [1, 2].forEach((n) => { const c = sprite(h, 'hx-clone c' + n); anim(c, 'power'); fx.append(c); }); }
    if (h.power === 'repulsor') { fx.append(el('div', 'hx-beam'), el('div', 'hx-core')); }
    if (h.power === 'stealth') { for (let i = 0; i < 4; i++) fx.append(el('div', 'hx-slash s' + i)); }
    if (h.power === 'pounce') { for (let i = 0; i < 3; i++) fx.append(el('div', 'hx-claw k' + i)); }
    if (h.power === 'magic') { fx.append(el('div', 'hx-ring r1'), el('div', 'hx-ring r2'), el('div', 'hx-ring r3')); }
    if (h.power === 'smash') { fx.append(el('div', 'hx-wave')); }
    if (h.power === 'lightning') { fx.append(el('div', 'hx-flash'), el('div', 'hx-bolt b1', '⚡'), el('div', 'hx-bolt b2', '⚡'), el('div', 'hx-bolt b3', '⚡')); }
    if (h.power === 'doom') { fx.append(el('div', 'hx-glow'), el('div', 'hx-wave')); }
    const text = el('div', 'hx-say', label || h.say);
    stage.append(fx, hero, text);
    document.body.append(stage);
    setTimeout(() => { stage.remove(); busy = false; }, h.power === 'doom' ? 3200 : 2300);
  };
  window.spendHeroPlay = (id) => play(HEROES.concat(DOOM).find((x) => x.id === id) || chosen());

  // ---- when to show them ----
  const seen = new Set();
  let ready = false;
  if (window.dash) {
    window.dash.onData(() => {
      const d = window.dash.data('spend');
      if (!d || d.status !== 'ok') return;
      const rows = (d.data || []).filter((r) => r.period === 'now');
      const fresh = rows.filter((r) => !seen.has(String(r.id)) && r.amount > 0);
      rows.forEach((r) => seen.add(String(r.id)));
      if (!ready) { ready = true; return; }
      if (fresh.length) { anim(petSp, 'hit', () => anim(petSp, 'cheer')); play(chosen()); }
    });
  }
  window.addEventListener('spend:streak', (e) => {
    const n = Number(e.detail) || 0;
    if (n > best()) { set('spend.best', String(n)); const was = HEROES.filter((h) => h.need > 0 && h.need <= n && h.need > Number(get('spend.bestSeen') || 0)); if (was.length) { set('spend.bestSeen', String(n)); if (window.spendCelebrate) window.spendCelebrate('🔓 ' + was[was.length - 1].name + ' joined!', 'New hero unlocked in Settings'); } }
  });
  // The day you go over your line, Doom Pig shows up once.
  window.addEventListener('spend:over', () => {
    const mark = new Date().toDateString();
    if (get('spend.doom') === mark) return;
    set('spend.doom', mark);
    setTimeout(() => play(DOOM, 'DOOMSDAY'), 900);
  });

  // ---- the Heroes screen ----
  const backdrop = el('div', 'backdrop'); backdrop.id = 'heroes-backdrop'; backdrop.hidden = true;
  const sheet = el('div', 'sheet tall'); sheet.id = 'heroes-sheet'; sheet.hidden = true;
  sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-labelledby', 'heroes-title');
  const grab = el('div', 'grab'); grab.setAttribute('aria-hidden', 'true');
  const head = el('div', 'set-head');
  const title = el('h2', '', 'Heroes'); title.id = 'heroes-title';
  const done = el('button', 'link', 'Done'); done.type = 'button';
  head.append(title, done);
  const sub = el('p', 'sub');
  const grid = el('div', 'hx-grid');
  const demo = el('button', 'btn-plain', 'Show me their power'); demo.type = 'button';
  const boss = el('p', 'fine', 'Go over your daily line and Doom Pig shows up. Keep your streak and your friends keep joining.');
  sheet.append(grab, head, sub, grid, demo, boss);
  document.body.append(backdrop, sheet);

  const draw = () => {
    const b = best(), cur = chosen();
    sub.textContent = allOpen() ? 'All heroes are unlocked for you. Pick who shows up when you spend.' : 'Your best streak: ' + b + (b === 1 ? ' day' : ' days') + '. Pick who shows up when you spend.';
    grid.replaceChildren();
    HEROES.forEach((h) => {
      const locked = !open_(h);
      const c = el('button', 'hx-card' + (h.id === cur.id ? ' on' : '') + (locked ? ' locked' : ''));
      c.type = 'button';
      c.setAttribute('aria-pressed', String(h.id === cur.id));
      const i = sprite(h, 'hx-card-sp');
      if (h.id === cur.id) base(i, 'cheer');
      c.append(i, el('b', '', h.name), el('span', '', locked ? '🔒 ' + h.need + '-day streak' : h.say));
      c.addEventListener('click', () => {
        if (locked) return;
        set('spend.hero', h.id);
        showPet();
        draw();
        close();
        setTimeout(() => play(h), 350);
      });
      grid.append(c);
    });
  };
  const open = () => {
    if (window.spendCloseSettings) window.spendCloseSettings();
    draw();
    backdrop.hidden = false; sheet.hidden = false;
    document.body.classList.add('sheet-open');
    sheet.scrollTop = 0;
  };
  const close = () => { sheet.hidden = true; backdrop.hidden = true; document.body.classList.remove('sheet-open'); };
  done.addEventListener('click', close);
  backdrop.addEventListener('click', close);
  demo.addEventListener('click', () => { close(); setTimeout(() => play(chosen()), 350); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) close(); });
  const btn = $('#heroes-open');
  if (btn) btn.addEventListener('click', open);
  if (window.spendSwipeToClose) window.spendSwipeToClose(sheet, close);
  window.spendCloseHeroes = close;
})();
