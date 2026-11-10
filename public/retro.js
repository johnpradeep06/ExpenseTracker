/* Retro mode switch (per phone) and the game effects that are not plain CSS:
   damage numbers when a new purchase arrives, and pausing the chart runner while the app is in the background. */
(function () {
  const KEY = 'spend.retro';
  const root = document.documentElement;
  const saved = () => { try { return localStorage.getItem(KEY) === '1'; } catch (e) { return false; } };
  const save = (on) => { try { if (on) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY); } catch (e) { /* storage unavailable */ } };
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  window.spendRetro = () => root.classList.contains('retro');

  const apply = (on) => {
    root.classList.toggle('retro', on);
    const st = document.querySelector('#retro-state');
    if (st) st.textContent = on ? 'On' : 'Off';
  };
  apply(saved());

  const btn = document.querySelector('#retro-toggle');
  if (btn) {
    btn.addEventListener('click', () => {
      const on = !window.spendRetro();
      save(on);
      apply(on);
      if (window.dash) window.dash.render();
    });
  }

  // The chart runner is an SVG animation: stop it while the app is not on screen, to save battery.
  document.addEventListener('visibilitychange', () => {
    document.querySelectorAll('svg.line-svg').forEach((s) => {
      try { if (document.hidden) s.pauseAnimations(); else s.unpauseAnimations(); } catch (e) { /* older browsers */ }
    });
  });

  // Damage numbers: a purchase that was not there before floats up from the total, like a hit in a game.
  const seen = new Set();
  let ready = false;
  const pop = (r) => {
    const hero = document.querySelector('#headline .hero-amt');
    if (!hero) return;
    const b = hero.getBoundingClientRect();
    if (b.bottom < 0 || b.top > window.innerHeight) return;
    const el = document.createElement('div');
    el.className = 'damage';
    el.textContent = '-$' + Math.abs(r.amount).toFixed(2);
    const who = document.createElement('small');
    who.textContent = String(r.merchant || '').slice(0, 18).toUpperCase();
    el.append(who);
    el.style.left = Math.min(window.innerWidth - 90, b.left + 230) + 'px';
    el.style.top = b.top + 'px';
    document.body.append(el);
    setTimeout(() => el.remove(), 1700);
  };
  if (window.dash) {
    window.dash.onData(() => {
      const d = window.dash.data('spend');
      if (!d || d.status !== 'ok') return;
      const rows = (d.data || []).filter((r) => r.period === 'now');
      const fresh = rows.filter((r) => !seen.has(String(r.id)));
      rows.forEach((r) => seen.add(String(r.id)));
      if (!ready) { ready = true; return; }
      const app = document.querySelector('#app');
      if (!window.spendRetro() || reduce.matches || !app || app.hidden) return;
      fresh.filter((r) => r.amount > 0).slice(0, 3).forEach((r, i) => setTimeout(() => pop(r), i * 450));
    });
  }
})();
