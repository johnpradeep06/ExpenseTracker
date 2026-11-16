(function () {
  // Add, edit and delete a payment. Deleting marks it closed, and the app ignores closed purchases,
  // so every change can be undone by reopening.
  const $ = (s) => document.querySelector(s);
  const sheet = $('#add-sheet');
  const backdrop = $('#add-backdrop');
  const openBtn = $('#add-open');
  if (!sheet || !backdrop || !openBtn) return;
  const heading = $('#add-title');
  const sub = sheet.querySelector('.sub');
  const merchant = $('#add-merchant');
  const amount = $('#add-amount');
  const category = $('#add-category');
  const when = $('#add-when');
  const err = $('#add-error');
  const save = $('#add-save');
  const del = $('#add-delete');
  const toast = $('#toast');
  const toastText = $('#toast-text');
  const toastUndo = $('#toast-undo');
  const scanBtn = $('#add-scan');
  let toastTimer = null;
  let undoOps = null;
  let editing = null;
  let armed = false;

  const p2 = (n) => (n < 10 ? '0' : '') + n;
  const localInput = (d) => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  // 2026-11-08T16:47:00-05:00, so the app reads the exact local time.
  const isoWithOffset = (d) => {
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const a = Math.abs(off);
    return localInput(d) + ':' + p2(d.getSeconds()) + sign + p2(Math.floor(a / 60)) + ':' + p2(a % 60);
  };
  const money = (v) => (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);

  const showError = (text) => {
    err.textContent = text;
    err.hidden = !text;
  };
  const resetDelete = () => {
    armed = false;
    del.textContent = 'Delete payment';
  };

  const openSheet = (row) => {
    editing = row || null;
    hideToast();
    heading.textContent = editing ? 'Edit payment' : 'Add a payment';
    sub.textContent = editing ? 'Change anything that is wrong, then save.' : 'For an Apple Pay payment your phone didn\'t send.';
    merchant.value = editing ? editing.merchant : '';
    amount.value = editing ? String(editing.amount) : '';
    const known = editing && Array.from(category.options).some((o) => o.value === editing.category);
    category.value = known ? editing.category : '';
    when.value = localInput(editing && editing.ts ? new Date(editing.ts) : new Date());
    // Scan this purchase's bill (the AI reader if the server has one, otherwise the Shortcut).
    if (scanBtn) {
      scanBtn.hidden = true;
      const mine = editing;
      scanBtn.textContent = mine && mine.draft ? '📷 Review the scanned bill' : mine && mine.bill ? '📷 Open the scanned bill' : '📷 Scan the bill';
      if (mine && window.spendBillAvailable && String(mine.id).indexOf('p-') !== 0) window.spendBillAvailable(mine).then((yes) => { if (yes && editing === mine) scanBtn.hidden = false; });
    }
    showError('');
    resetDelete();
    del.hidden = !editing;
    save.disabled = false;
    save.textContent = editing ? 'Save changes' : 'Add payment';
    backdrop.hidden = false;
    sheet.hidden = false;
    document.body.classList.add('sheet-open');
    sheet.scrollTop = 0;
    if (!editing) setTimeout(() => merchant.focus(), 60);
  };
  const closeSheet = () => {
    sheet.hidden = true;
    backdrop.hidden = true;
    document.body.classList.remove('sheet-open');
    editing = null;
    // Opened from the full list: save, delete or cancel all land back on that list.
    const back = window.spendListReturn;
    window.spendListReturn = false;
    if (back && window.spendOpenAll) window.spendOpenAll(true);
  };

  // Errors from the server carry a status; a missing connection does not.
  const friendly = (x) => {
    if (x && x.status === 401) return 'Your sign-in has run out. Close the app, open it again and sign in.';
    if (x && x.status) return x.message || 'The server said no (' + x.status + '). Try again in a moment.';
    return 'Could not reach the server. Check your connection and try again.';
  };
  // A mark you make teaches the app a habit; the server hands the updated habits back so they apply straight away.
  const takeHabits = (res) => { if (res && res.learn && window.spendCustom) window.spendCustom = { ...window.spendCustom, learn: res.learn }; };
  const patch = async (number, body) => { const res = await window.spendApi('PATCH', 'purchases/' + number, body); if (body && body.kind !== undefined) takeHabits(res); return res; };

  const hideToast = () => {
    toast.hidden = true;
    clearTimeout(toastTimer);
  };
  const showToast = (text, ops) => {
    undoOps = ops && ops.length ? ops : null;
    toastText.textContent = text;
    toastUndo.hidden = !undoOps;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 9000);
  };

  openBtn.addEventListener('click', () => { window.spendListReturn = false; openSheet(null); });
  window.spendEdit = (row) => {
    if (String(row.id).indexOf('p-') === 0) {
      showToast('Not sent yet. You can edit it once it has sent.', null);
      return;
    }
    openSheet(row);
  };
  if (scanBtn) scanBtn.addEventListener('click', () => {
    const row = editing;
    closeSheet();
    if (row && window.spendScanBill) window.spendScanBill(row);
  });
  window.spendToast = (text, ops) => showToast(text, ops);
  backdrop.addEventListener('click', closeSheet);
  $('#add-cancel').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !sheet.hidden) closeSheet();
  });

  sheet.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = merchant.value.replace(/\s+/g, ' ').trim().slice(0, 60);
    const raw = amount.value.replace(/[$,\s]/g, '');
    const value = Number(raw);
    if (!name) return showError('Type where you paid.');
    if (!raw || !isFinite(value) || value === 0 || Math.abs(value) > 100000) return showError('Type the amount as a number, like 12.50. Use a minus sign for a refund.');
    const date = when.value ? new Date(when.value) : new Date();
    if (isNaN(date.getTime())) return showError('Pick a valid date and time.');
    const picked = category.value === '__new__' ? '' : category.value;
    const cents = Math.round(value * 100) / 100;
    const iso = isoWithOffset(date);
    const title = 'Spending - ' + money(cents) + ' - ' + iso.slice(0, 10) + ' - ' + (picked || 'Other');
    const lines = [
      'Date: ' + iso,
      'Merchant: ' + name,
      'Amount: ' + money(cents),
      'Card: ' + ((editing && editing.card) || 'Added by hand'),
      'Category: ' + (picked || 'Other')
    ];
    if (picked) lines.push('Entry: manual');
    const body = lines.join('\n');
    showError('');
    save.disabled = true;
    save.textContent = editing ? 'Saving…' : 'Adding…';
    try {
      if (editing) {
        const number = editing.id;
        const dups = editing.dupIds || [];
        const old = await window.spendApi('GET', 'purchases/' + number);
        await patch(number, { title, body });
        for (const d of dups) await patch(d, { state: 'closed' });
        const ops = [{ n: number, body: { title: old.title, body: old.body || '' } }].concat(dups.map((d) => ({ n: d, body: { state: 'open' } })));
        closeSheet();
        showToast('Saved changes to ' + name, ops);
      } else {
        let made;
        try {
          made = await window.spendApi('POST', 'purchases', { title, body });
        } catch (net) {
          // No connection: keep it on this phone and send it when the connection is back.
          if ((net && net.status) || !window.spendQueue) throw net;
          window.spendQueue.add({ title, body });
          closeSheet();
          showToast('Saved on this phone. It will send when you\'re back online.', null);
          if (window.dash) dash.reload();
          return;
        }
        closeSheet();
        showToast('Added ' + money(cents) + ' at ' + name, made && made.number ? [{ n: made.number, body: { state: 'closed' } }] : null);
      }
      if (window.dash) dash.reload();
    } catch (x) {
      showError(friendly(x));
      save.disabled = false;
      save.textContent = editing ? 'Save changes' : 'Add payment';
    }
  });

  // Marks the purchase (and any duplicate it absorbed) closed, then offers Undo.
  const removeRow = async (row) => {
    const ids = [row.id].concat(row.dupIds || []);
    for (const n of ids) await patch(n, { state: 'closed' });
    showToast('Deleted ' + row.merchant, ids.map((n) => ({ n, body: { state: 'open' } })));
    if (window.dash) dash.reload();
  };
  // "Delete this?" for a swipe to the left: resolves true only when the person says yes.
  window.spendConfirmDelete = (row) => new Promise((resolve) => {
    if (String(row.id).indexOf('p-') === 0) { resolve(true); return; }  // spendDelete explains that one
    const back = document.createElement('div');
    back.className = 'confirm-back';
    const box = document.createElement('div');
    box.className = 'confirm-box';
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-modal', 'true');
    const h = document.createElement('h3');
    h.textContent = 'Delete this payment?';
    const p = document.createElement('p');
    p.textContent = row.merchant + ' · ' + money(row.amount);
    const acts = document.createElement('div');
    acts.className = 'confirm-acts';
    const no = document.createElement('button'); no.type = 'button'; no.className = 'confirm-no'; no.textContent = 'Keep it';
    const yes = document.createElement('button'); yes.type = 'button'; yes.className = 'confirm-yes'; yes.textContent = 'Delete';
    acts.append(no, yes);
    box.append(h, p, acts);
    back.append(box);
    const done = (v) => { document.removeEventListener('keydown', onKey, true); back.remove(); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } };
    no.addEventListener('click', () => done(false));
    yes.addEventListener('click', () => done(true));
    back.addEventListener('click', (e) => { if (e.target === back) done(false); });
    document.addEventListener('keydown', onKey, true);
    document.body.append(back);
    no.focus();
  });
  // Used when swiping a purchase to the left. Returns true when it was deleted.
  window.spendDelete = async (row) => {
    if (String(row.id).indexOf('p-') === 0) {
      showToast('Not sent yet. You can delete it once it has sent.', null);
      return false;
    }
    try {
      await removeRow(row);
      return true;
    } catch (x) {
      showToast(friendly(x), null);
      return false;
    }
  };

  // Used when swiping a purchase to the right (Clean look): switches it between necessary and unnecessary, with Undo.
  window.spendFlip = async (row) => {
    if (String(row.id).indexOf('p-') === 0) {
      showToast('Not sent yet. You can change it once it has sent.', null);
      return false;
    }
    const to = row.leak === 'fun' ? 'need' : 'fun';
    const ids = [row.id].concat(row.dupIds || []);
    try {
      for (const n of ids) await patch(n, { kind: to });
      const ops = ids.map((n) => ({ n, body: { kind: n === row.id ? (row.kind || '') : '' } }));
      showToast(row.merchant + ' is now ' + (to === 'fun' ? 'unnecessary' : 'necessary'), ops);
      if (window.dash) dash.reload();
      return true;
    } catch (x) {
      showToast(friendly(x), null);
      return false;
    }
  };

  // Delete asks twice: the first tap arms it, the second does it.
  del.addEventListener('click', async () => {
    if (!editing) return;
    if (!armed) {
      armed = true;
      del.textContent = 'Tap again to delete';
      return;
    }
    del.disabled = true;
    try {
      await removeRow(editing);
      closeSheet();
    } catch (x) {
      showError(friendly(x));
      resetDelete();
    }
    del.disabled = false;
  });

  // Undo replays the saved opposite of the last change.
  toastUndo.addEventListener('click', async () => {
    const ops = undoOps;
    if (!ops) return;
    undoOps = null;
    toastUndo.hidden = true;
    toastText.textContent = 'Undoing…';
    try {
      for (const op of ops) await patch(op.n, op.body);
      showToast('Undone', null);
      if (window.dash) dash.reload();
    } catch (x) {
      showToast('Could not undo. Check your connection and try again.', null);
    }
  });
})();
