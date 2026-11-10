/* The look of the app, chosen per phone in Settings: Clean (default), Candy or Arcade. It only sets a class on <html>.
   This file also runs the theme effects that plain CSS cannot do: reacting when a new purchase arrives (Penny the
   piggy wobbles and drops a coin in Candy, a damage number floats up in Arcade), a small celebration at streak
   milestones, and pausing the chart runner while the app is in the background. */
(function () {
  const KEY = 'spend.theme';
  const THEMES = ['clean', 'candy', 'retro'];
  const root = document.documentElement;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const get = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const set = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } };

  // Phones that turned on the earlier "Retro mode" switch keep that look.
  if (!get(KEY) && get('spend.retro') === '1') set(KEY, 'retro');
  set('spend.retro', null);

  const current = () => THEMES.find((t) => t !== 'clean' && root.classList.contains(t)) || 'clean';
  window.spendTheme = current;
  window.spendRetro = () => current() === 'retro';

  const apply = (theme) => {
    const t = THEMES.includes(theme) ? theme : 'clean';
    THEMES.forEach((x) => root.classList.toggle(x, x === t && x !== 'clean'));
    document.querySelectorAll('.theme-pick button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.theme === t)));
    window.dispatchEvent(new CustomEvent('spend:theme', { detail: t }));
  };
  apply(get(KEY) || 'clean');

  document.querySelectorAll('.theme-pick button').forEach((b) => {
    b.addEventListener('click', () => {
      set(KEY, b.dataset.theme === 'clean' ? null : b.dataset.theme);
      apply(b.dataset.theme);
      if (window.dash) window.dash.render();
    });
  });

  // The chart runner (Arcade) is an SVG animation: stop it while the app is not on screen, to save battery.
  document.addEventListener('visibilitychange', () => {
    document.querySelectorAll('svg.line-svg').forEach((s) => {
      try { if (document.hidden) s.pauseAnimations(); else s.unpauseAnimations(); } catch (e) { /* older browsers */ }
    });
  });

  const money = (v) => '$' + Math.abs(v).toFixed(2);
  const appShown = () => { const a = document.querySelector('#app'); return a && !a.hidden; };

  // Arcade: the amount floats up from the total like a hit in a game.
  const damage = (r) => {
    const hero = document.querySelector('#headline .hero-amt');
    if (!hero) return;
    const b = hero.getBoundingClientRect();
    if (b.bottom < 0 || b.top > window.innerHeight) return;
    const el = document.createElement('div');
    el.className = 'damage';
    el.textContent = '-' + money(r.amount);
    const who = document.createElement('small');
    who.textContent = String(r.merchant || '').slice(0, 18).toUpperCase();
    el.append(who);
    el.style.left = Math.min(window.innerWidth - 90, b.left + 230) + 'px';
    el.style.top = b.top + 'px';
    document.body.append(el);
    setTimeout(() => el.remove(), 1700);
  };

  // Candy: Penny wobbles, says the amount, and a coin drops out.
  const oink = (r) => {
    const pet = document.querySelector('#pet');
    if (!pet) return;
    pet.classList.remove('hit');
    void pet.offsetWidth;
    pet.classList.add('hit');
    const say = document.createElement('div');
    say.className = 'say';
    say.textContent = '-' + money(r.amount);
    pet.append(say);
    const b = pet.getBoundingClientRect();
    if (b.bottom > 0 && b.top < window.innerHeight) {
      const coin = document.createElement('div');
      coin.className = 'coin-drop';
      coin.style.left = (b.left + b.width / 2 - 12) + 'px';
      coin.style.top = (b.top + b.height * 0.55) + 'px';
      document.body.append(coin);
      setTimeout(() => coin.remove(), 1200);
    }
    setTimeout(() => { say.remove(); pet.classList.remove('hit'); }, 1900);
  };

  const seen = new Set();
  let ready = false;
  if (window.dash) {
    window.dash.onData(() => {
      const d = window.dash.data('spend');
      if (!d || d.status !== 'ok') return;
      const rows = (d.data || []).filter((r) => r.period === 'now');
      const fresh = rows.filter((r) => !seen.has(String(r.id)));
      rows.forEach((r) => seen.add(String(r.id)));
      if (!ready) { ready = true; return; }
      if (reduce.matches || !appShown()) return;
      const hits = fresh.filter((r) => r.amount > 0).slice(0, 3);
      const theme = current();
      if (theme === 'retro') hits.forEach((r, i) => setTimeout(() => damage(r), i * 450));
      if (theme === 'candy' && hits.length) {
        oink(hits[0]);
        setTimeout(() => {
          const jar = document.querySelector('.jar-glass');
          if (jar) { jar.classList.remove('shake'); void jar.offsetWidth; jar.classList.add('shake'); }
          fresh.forEach((r) => document.querySelectorAll('[data-key="' + String(r.id).replace(/"/g, '') + '"]').forEach((el) => {
            el.classList.remove('fresh-row'); void el.offsetWidth; el.classList.add('fresh-row');
          }));
        }, 80);
      }
    });
  }

  // A small celebration the first time a streak milestone is reached each day (Candy only).
  const MILESTONES = [3, 7, 14, 30, 60, 100];
  const COLORS = ['#58cc02', '#1cb0f6', '#ffc800', '#ff9600', '#ce82ff', '#ff4b4b', '#89e219'];
  const celebrate = (title, sub) => {
    const box = document.createElement('div');
    box.className = 'confetti';
    for (let i = 0; i < 46; i++) {
      const p = document.createElement('i');
      p.style.left = Math.round(Math.random() * 100) + '%';
      p.style.background = COLORS[i % COLORS.length];
      p.style.animationDuration = (1.6 + Math.random() * 1.4).toFixed(2) + 's';
      p.style.animationDelay = (Math.random() * 0.5).toFixed(2) + 's';
      p.style.transform = 'rotate(' + Math.round(Math.random() * 180) + 'deg)';
      box.append(p);
    }
    const cheer = document.createElement('div');
    cheer.className = 'cheer';
    const big = document.createElement('b');
    big.textContent = title;
    const small = document.createElement('span');
    small.textContent = sub;
    cheer.append(big, small);
    document.body.append(box, cheer);
    setTimeout(() => { box.remove(); cheer.remove(); }, 3200);
  };
  window.addEventListener('spend:streak', (e) => {
    const n = e.detail;
    if (current() !== 'candy' || reduce.matches || !appShown() || !MILESTONES.includes(n)) return;
    const mark = n + '@' + new Date().toDateString();
    if (get('spend.cheered') === mark) return;
    set('spend.cheered', mark);
    setTimeout(() => celebrate('🎉 ' + n + '-day streak!', ((window.spendHeroName ? window.spendHeroName() : 'Penny') + ' is so proud of you 💖')), 600);
  });
  // ---- Fresh: Penny's little life ----
  const fresh = () => current() === 'candy' && !reduce.matches;
  const act = (name, ms) => {
    const pet = document.querySelector('#pet');
    if (!pet || pet.classList.contains('hit')) return;
    pet.classList.remove('act-' + name);
    void pet.offsetWidth;
    pet.classList.add('act-' + name);
    setTimeout(() => pet.classList.remove('act-' + name), ms);
  };
  const say = (text, ms) => {
    const pet = document.querySelector('#pet');
    if (!pet) return;
    const b = document.createElement('div');
    b.className = 'say hello';
    b.textContent = text;
    b.style.animationDuration = ((ms || 1800) / 1000) + 's';
    pet.append(b);
    setTimeout(() => b.remove(), ms || 1800);
  };
  // Every few seconds she does one small thing, never while the app is in the background.
  const IDLE = [['look', 1400], ['wag', 1100], ['ear', 700], ['hop', 650]];
  const idle = () => {
    const pet = document.querySelector('#pet');
    if (fresh() && !document.hidden && appShown() && pet && pet.dataset.mood !== 'sleepy') {
      const [name, ms] = IDLE[Math.floor(Math.random() * IDLE.length)];
      act(name, ms);
    }
    setTimeout(idle, 6000 + Math.random() * 6000);
  };
  setTimeout(idle, 4000);
  // A hello when the app opens.
  let greeted = false;
  if (window.dash) {
    window.dash.onData(() => {
      if (greeted || !appShown() || !fresh()) return;
      const d = window.dash.data('spend');
      if (!d || d.status !== 'ok') return;
      greeted = true;
      const pet = document.querySelector('#pet');
      setTimeout(() => {
        if (pet && pet.dataset.mood === 'sleepy') say('zzz… 💤', 1600);
        else { act('hop', 650); say('Hi! 👋', 1500); }
      }, 500);
    });
  }

  window.spendPenny = { act, say };
  window.spendCelebrate = (title, sub) => { if (!reduce.matches) celebrate(title, sub); };

  // Swipe-to-delete ends in a little puff of colour.
  window.spendPoof = (el) => {
    if (!fresh() || !el) return;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width * 0.75;
    const cy = r.top + r.height / 2;
    for (let i = 0; i < 18; i++) {
      const p = document.createElement('div');
      p.className = 'poof';
      const a = (Math.PI * 2 * i) / 18;
      const dist = 46 + Math.random() * 40;
      p.style.left = cx + 'px';
      p.style.top = cy + 'px';
      p.style.background = COLORS[i % COLORS.length];
      p.style.setProperty('--dx', Math.round(Math.cos(a) * dist) + 'px');
      p.style.setProperty('--dy', Math.round(Math.sin(a) * dist) + 'px');
      document.body.append(p);
      setTimeout(() => p.remove(), 700);
    }
  };
})();
