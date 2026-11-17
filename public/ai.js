(function () {
  // AI categories: for a person the owner has switched it on for, the stores the app's own rules cannot place are sent
  // (store NAMES only, a few at a time) to Gemini through the server, and its answers are remembered, so a store is asked
  // about once. The answers feed the same category calculation as everything else (window.spendCustom.ai).
  // Nothing happens at all for anyone who does not have it.
  const $ = (s) => document.querySelector(s);
  if (!window.spendApi || !window.dash) return;

  let enabled = false;
  let busy = false;
  let lastTry = 0;
  let backoffUntil = 0;

  const guesses = () => (window.spendCustom && window.spendCustom.ai) || {};
  const keyOf = (name) => (window.spendMerchant ? window.spendMerchant.keyOf(name) : String(name || ''));

  const note = () => {
    const box = $('#ai-note');
    if (!box) return;
    box.hidden = !enabled;
    if (!enabled) return;
    const n = Object.keys(guesses()).filter((k) => guesses()[k] && guesses()[k] !== 'Other').length;
    const c = $('#ai-count');
    if (c) c.textContent = n ? n + (n === 1 ? ' store has' : ' stores have') + ' been sorted by AI so far.' : 'No store has needed it yet.';
  };

  const unplaced = () => {
    const d = window.dash.data('spend');
    if (!d || d.status !== 'ok') return [];
    const have = guesses();
    const names = [];
    const seen = new Set();
    (d.data || []).forEach((r) => {
      if (r.how !== 'none' || !r.merchant) return;
      const k = keyOf(r.merchant);
      if (seen.has(k) || k in have) return;
      seen.add(k); names.push(r.merchant);
    });
    return names;
  };

  const run = async () => {
    if (!enabled || busy || document.hidden) return;
    if (Date.now() < backoffUntil || Date.now() - lastTry < 20000) return;
    const names = unplaced().slice(0, 12);
    if (!names.length) return;
    busy = true; lastTry = Date.now();
    try {
      const r = await window.spendApi('POST', 'ai/categorize', { stores: names });
      if (r && r.guesses) {
        const before = JSON.stringify(guesses());
        window.spendCustom = { ...(window.spendCustom || { cats: [], rules: {} }), ai: r.guesses };
        if (JSON.stringify(r.guesses) !== before && window.dash.reload) window.dash.reload();
        note();
      }
    } catch (x) {
      backoffUntil = Date.now() + 10 * 60 * 1000;        // out of allowance or the helper is down: try again later, quietly
    }
    busy = false;
  };

  // "Sort my stores now": asks about every store the rules cannot place (a few at a time, up to the daily allowance) and
  // shows each answer, or the plain reason it could not.
  const runNow = async () => {
    const out = $('#ai-result'); const btn = $('#ai-run');
    if (!out || !btn || busy) return;
    busy = true; btn.disabled = true; btn.textContent = 'Asking…';
    out.replaceChildren();
    const line = (text, cls) => { const p = document.createElement('p'); p.className = 'ai-line' + (cls ? ' ' + cls : ''); p.textContent = text; out.append(p); };
    let asked = 0; let failed = '';
    try {
      for (let round = 0; round < 6; round++) {
        const names = unplaced().slice(0, 12);
        if (!names.length) break;
        const r = await window.spendApi('POST', 'ai/categorize', { stores: names });
        if (!r || !r.asked) break;
        asked += r.asked;
        Object.keys(r.answers || {}).forEach((n) => line(n + '  →  ' + r.answers[n], r.answers[n] === 'Other' ? 'dim' : 'ok'));
        window.spendCustom = { ...(window.spendCustom || { cats: [], rules: {} }), ai: r.guesses };
      }
    } catch (x) { failed = (x && x.message) || 'It could not be reached.'; }
    if (failed) line('✗ ' + failed, 'bad');
    else if (!asked) line('Nothing to sort: every store is already placed.', 'dim');
    else line('✓ Gemini answered for ' + asked + (asked === 1 ? ' store.' : ' stores.'), 'ok');
    if (asked && window.dash && window.dash.reload) window.dash.reload();
    note(); busy = false; btn.disabled = false; btn.textContent = 'Sort my stores now';
  };
  const runBtn = $('#ai-run');
  if (runBtn) runBtn.addEventListener('click', runNow);

  window.addEventListener('spend:me', (e) => {
    enabled = !!(e.detail && e.detail.ai && e.detail.ai.enabled);
    note();
    if (enabled) setTimeout(run, 900);      // the purchases may already be on screen: do not wait for the next refresh
  });
  window.dash.onData(() => { note(); if (enabled) setTimeout(run, 400); });
  window.spendAiRun = run;
})();
