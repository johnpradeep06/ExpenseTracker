(function () {
  // Free to spend: the paycheck minus what was spent since payday. One calm card on the home screen
  // (tap it for the sums), a one-screen setup sheet, and a "Got paid" sheet that starts the next period.
  // The sums are done by the server (GET pay); this file only draws them and sends what the person types.
  // Works in all three looks: it only uses the app's own colours, and pay.css adds a little per look.
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const money = (n) => (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const P = window.spendPay;
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };
  const dayName = (s) => { const t = P.parse(s); return t === null ? s : new Date(t).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }); };
  const todayKey = () => { const d = new Date(); const p = (n) => (n < 10 ? '0' : '') + n; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); };
  const FREQ_LABEL = { week: 'Every week', '2 weeks': 'Every 2 weeks', month: 'Every month', year: 'Every year' };
  const PAY_LABEL = { week: 'Weekly', '2 weeks': 'Every 2 weeks', month: 'Monthly' };

  let plan = null;
  let state = null;
  let loaded = false;
  let open = false;
  let lastFetch = 0;
  let inflight = null;

  const card = $('#pay');
  if (!card || !P || !window.spendApi) return;

  const apply = (r) => { plan = r && r.plan ? r.plan : null; state = r && r.state ? r.state : null; loaded = true; draw(); };
  const refresh = async (force) => {
    if (inflight) return inflight;
    if (!force && Date.now() - lastFetch < 8000) return null;
    lastFetch = Date.now();
    inflight = window.spendApi('GET', 'pay').then(apply).catch(() => { /* not signed in yet, or offline: keep what is on screen */ }).then(() => { inflight = null; });
    return inflight;
  };

  // ---- the card ----
  const draw = () => {
    card.replaceChildren();
    card.className = 'card pay';
    if (!loaded) { card.hidden = true; return; }
    card.hidden = false;
    if (!plan || !state) {
      if (store.get('spend.payHide') === '1') { card.hidden = true; return; }
      card.classList.add('pay-cta');
      const t = el('div', 'pay-cta-text');
      t.append(el('b', '', 'See what is left until payday'), el('span', '', 'Add your paycheck and bills once.'));
      const go = el('button', 'pay-go', 'Set up'); go.type = 'button'; go.addEventListener('click', () => openSetup());
      const x = el('button', 'pay-x', '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Not now');
      x.addEventListener('click', () => { if (card.closest('#hero-pager') && window.spendHero) { window.spendHero.hide('pay'); return; } store.set('spend.payHide', '1'); draw(); });
      card.append(t, go, x);
      return;
    }
    const askedToday = store.get('spend.payAsk') === todayKey();
    if (state.due && !askedToday) { drawAsk(); return; }
    card.classList.add('pay-' + state.level);
    const lab = el('div', 'pay-lab');
    lab.append(el('span', '', 'Free to spend'), el('span', '', state.due ? 'Payday was ' + dayName(state.next) : state.daysLeft + (state.daysLeft === 1 ? ' day' : ' days') + ' to payday'));
    const big = el('div', 'pay-big', money(state.left));
    const line = el('div', 'pay-line');
    if (state.due) line.append(document.createTextNode('Tap "Got paid" when your paycheck arrives'));
    else if (state.left >= 0) { line.append(el('b', '', money(state.perDay) + ' a day'), document.createTextNode(' to make it to ' + dayName(state.next))); }
    else line.append(el('b', '', 'over'), document.createTextNode(' what you had free'));
    const bar = el('div', 'pay-bar'); const fill = el('i'); fill.style.width = state.pct + '%'; bar.append(fill);
    card.append(lab, big, line, bar);
    const note = noteText();
    if (note) card.append(el('div', 'pay-note', note));
    if (open) {
      const rows = el('div', 'pay-rows');
      const row = (a, b, cls) => { const d = el('div', cls || ''); d.append(el('span', '', a), el('span', '', b)); rows.append(d); };
      row('Paycheck', money(state.amount));
      if (state.billsPaid > 0) {
        row('Bills & utilities you paid', '−' + money(state.billsPaid));
        row('Other spending since ' + dayName(state.start), '−' + money(state.otherSpent));
      } else row('Spent since ' + dayName(state.start), '−' + money(state.spent));
      row('Free to spend', money(state.left), 'tot');
      const edit = el('button', 'btn-plain pay-edit', 'Edit paycheck & bills'); edit.type = 'button';
      edit.addEventListener('click', (e) => { e.stopPropagation(); openSetup(); });
      card.append(rows, edit);
      if (state.due) { const paid = el('button', 'primary pay-paid', 'Got paid'); paid.type = 'button'; paid.addEventListener('click', (e) => { e.stopPropagation(); openPaid(); }); card.append(paid); }
    } else if (state.due) {
      const paid = el('button', 'primary pay-paid', 'Got paid'); paid.type = 'button'; paid.addEventListener('click', (e) => { e.stopPropagation(); openPaid(); }); card.append(paid);
    }
    card.append(el('div', 'pay-chev', open ? 'Tap to close ⌃' : 'Tap for details ⌄'));
    card.tabIndex = 0; card.setAttribute('role', 'button'); card.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  const noteText = () => {
    if (state.level === 'bad') return state.free <= 0 ? 'Your bills are more than your paycheck. Check them in Edit.' : 'It will come out of your next paycheck.';
    if (state.level === 'warn' && state.runsOutIn !== null) return 'At your usual pace you run out in about ' + (state.runsOutIn < 1 ? 'a day' : Math.round(state.runsOutIn) + (Math.round(state.runsOutIn) === 1 ? ' day' : ' days')) + '.';
    return '';
  };
  const drawAsk = () => {
    card.classList.add('pay-good', 'pay-ask');
    const lab = el('div', 'pay-lab'); lab.append(el('span', '', 'Payday'), el('span', '', dayName(state.next)));
    const q = el('div', 'pay-q', 'Did you get paid?');
    card.append(lab, q);
    if (state.free > 0 || state.last) {
      const left = state.left;
      card.append(el('div', 'pay-line', 'This period you finished ' + money(Math.abs(left)) + (left >= 0 ? ' under.' : ' over.')));
    }
    const yes = el('button', 'primary pay-paid', 'Yes, I got paid'); yes.type = 'button'; yes.addEventListener('click', openPaid);
    const no = el('button', 'link pay-no', 'Not yet'); no.type = 'button';
    no.addEventListener('click', () => { store.set('spend.payAsk', todayKey()); draw(); });
    card.append(yes, no);
  };
  card.addEventListener('click', (e) => {
    if (!state || card.classList.contains('pay-cta') || card.classList.contains('pay-ask')) return;
    if (e.target.closest('button, a, input')) return;
    open = !open; draw();
  });
  card.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === card) { e.preventDefault(); card.click(); } });

  // ---- sheets ----
  const backdrop = el('div', 'backdrop'); backdrop.hidden = true;
  const mkSheet = (id, title) => {
    const sheet = el('div', 'sheet tall pay-sheet'); sheet.id = id; sheet.hidden = true;
    sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-label', title);
    const grab = el('div', 'grab'); grab.setAttribute('aria-hidden', 'true');
    const body = el('div', 'pay-body');
    sheet.append(grab, body);
    return { sheet, body };
  };
  const setup = mkSheet('pay-setup', 'Your paycheck');
  const paid = mkSheet('pay-paidsheet', 'Got paid');
  document.body.append(backdrop, setup.sheet, paid.sheet);
  let active = null;
  const show = (s) => { active = s; backdrop.hidden = false; s.sheet.hidden = false; document.body.classList.add('sheet-open'); s.sheet.scrollTop = 0; };
  const close = () => { [setup, paid].forEach((s) => { s.sheet.hidden = true; }); backdrop.hidden = true; document.body.classList.remove('sheet-open'); active = null; };
  backdrop.addEventListener('click', () => { if (active) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && active) close(); });

  const field = (label, child) => { const f = el('label', 'field'); f.append(el('span', '', label), child); return f; };
  const moneyInput = (value) => { const w = el('div', 'money-input'); w.append(el('span', '', '$')); const i = el('input'); i.inputMode = 'decimal'; i.autocomplete = 'off'; i.value = value; w.append(i); return { w, i }; };
  const num = (v) => P.money(v, 1000000);

  // ---- setup: one short screen (paycheck, last payday, how often) ----
  let draft = null;
  const openSetup = () => {
    draft = { amount: plan ? String(plan.amount) : '', every: plan ? plan.every : '2 weeks', start: plan ? plan.start : todayKey() };
    drawSetup(); show(setup);
  };
  const drawSetup = () => {
    const b = setup.body; b.replaceChildren();
    b.append(el('h2', '', 'Your paycheck'), el('p', 'sub', 'Only you can see this. It is stored encrypted.'));
    const err = el('p', 'pay-err'); err.hidden = true;
    const fail = (t) => { err.textContent = t; err.hidden = false; };
    const amt = moneyInput(draft.amount); amt.i.addEventListener('input', () => { draft.amount = amt.i.value; });
    b.append(field('How much each time?', amt.w));
    const date = el('input'); date.type = 'date'; date.value = draft.start; date.max = P.addDays(todayKey(), 1);
    const nextEl = el('p', 'pay-hint');
    const showNext = () => { nextEl.textContent = P.parse(draft.start) ? 'Next payday: ' + dayName(P.nextPayday(draft.start, draft.every)) + '. After that the app moves on by itself.' : ''; };
    date.addEventListener('change', () => { draft.start = date.value; showNext(); });
    b.append(field('Last payday', date));
    const seg = el('div', 'pay-seg');
    P.PAY_EVERY.forEach((k) => { const s = el('button', draft.every === k ? 'on' : '', PAY_LABEL[k]); s.type = 'button'; s.addEventListener('click', () => { draft.every = k; seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === s)); showNext(); }); seg.append(s); });
    const fq = el('div', 'field'); fq.append(el('span', '', 'How often?'), seg);
    b.append(fq, nextEl);
    b.append(el('p', 'pay-hint', 'Free to spend is your paycheck minus what you spend after payday. Bills you pay with Apple Pay (hydro, phone, internet) are already in your spending.'), err);
    showNext();
    const save = el('button', 'primary', 'Save'); save.type = 'button';
    save.addEventListener('click', async () => {
      const a = num(draft.amount);
      if (a === null || a <= 0) return fail('Enter what you get paid each time');
      if (!P.parse(draft.start)) return fail('Choose the day you were last paid');
      if (draft.start > P.addDays(todayKey(), 1)) return fail('The last payday cannot be in the future');
      save.disabled = true; save.textContent = 'Saving…';
      try {
        const r = await window.spendApi('PUT', 'pay', { amount: draft.amount, every: draft.every, start: draft.start, bills: [] });
        store.set('spend.payHide', '0'); apply(r); close();
        if (window.spendToast) window.spendToast('Saved. ' + money(r.state.left) + ' free to spend until payday', null);
      } catch (x) { save.disabled = false; save.textContent = 'Save'; fail(x && x.message ? x.message : 'Could not save. Check your connection.'); }
    });
    const cancel = el('button', 'link', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', close);
    b.append(save, cancel);
    if (plan) {
      const rm = el('button', 'danger-plain', 'Remove my paycheck plan'); rm.type = 'button'; let armed = false;
      rm.addEventListener('click', async () => {
        if (!armed) { armed = true; rm.textContent = 'Tap again to remove it'; return; }
        try { await window.spendApi('DELETE', 'pay'); apply({ plan: null, state: null }); store.set('spend.payHide', '0'); close(); } catch (x) { fail('Could not remove it. Try again.'); }
      });
      b.append(rm);
    }
  };

  // ---- got paid ----
  const openPaid = () => {
    const b = paid.body; b.replaceChildren();
    b.append(el('h2', '', 'Got paid'), el('p', 'sub', 'Check the amount and the day. A new period starts then.'));
    const amt = moneyInput(String(plan.amount));
    const date = el('input'); date.type = 'date'; date.value = todayKey(); date.min = P.addDays(plan.start, 1); date.max = P.addDays(todayKey(), 1);
    b.append(field('Amount', amt.w), field('Paid on', date));
    const err = el('p', 'pay-err'); err.hidden = true; b.append(err);
    const go = el('button', 'primary', 'Start new period'); go.type = 'button';
    go.addEventListener('click', async () => {
      const a = num(amt.i.value);
      if (a === null || a <= 0) { err.textContent = 'Enter what you got paid'; err.hidden = false; return; }
      go.disabled = true; go.textContent = 'Starting…';
      try {
        const r = await window.spendApi('POST', 'pay/paid', { date: date.value, amount: amt.i.value });
        open = false; store.set('spend.payAsk', ''); apply(r); close();
        if (window.spendToast) window.spendToast('New pay period: ' + money(r.state.left) + ' free to spend', null);
      } catch (x) { go.disabled = false; go.textContent = 'Start new period'; err.textContent = x && x.message ? x.message : 'Could not save. Check your connection.'; err.hidden = false; }
    });
    const cancel = el('button', 'link', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', close);
    b.append(go, cancel);
    show(paid);
  };

  if (window.dash && window.dash.onData) window.dash.onData(() => { refresh(false); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });
  window.spendPayRefresh = () => refresh(true);
})();
