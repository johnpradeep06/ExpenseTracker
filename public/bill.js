(function () {
  // Scan a bill (Clean look only, and only when the server has an AI reader switched on): take a photo, the server's AI
  // reader finds the items, the person checks them and taps any item to flip necessary / unnecessary, then saves.
  // The photo is shrunk and re-saved as a plain JPEG here (which also drops any location in it), sent once, and never kept.
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const money = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
  const clean = () => !document.documentElement.classList.contains('candy') && !document.documentElement.classList.contains('retro');

  let enabled = null;
  window.spendBillAvailable = async () => {
    if (!clean() || !window.spendApi) return false;
    if (enabled === null) {
      try { enabled = !!(await window.spendApi('GET', 'config')).billScan; } catch (e) { return false; }
    }
    return enabled;
  };

  const backdrop = el('div', 'backdrop'); backdrop.hidden = true;
  const sheet = el('div', 'sheet tall'); sheet.id = 'bill-sheet'; sheet.hidden = true;
  sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-labelledby', 'bill-title');
  const grab = el('div', 'grab'); grab.setAttribute('aria-hidden', 'true');
  const head = el('div', 'set-head');
  const title = el('h2', '', 'Scan the bill'); title.id = 'bill-title';
  const closeBtn = el('button', 'link', 'Close'); closeBtn.type = 'button';
  head.append(title, closeBtn);
  const body = el('div', 'bill-body');
  sheet.append(grab, head, body);
  document.body.append(backdrop, sheet);

  let row = null;      // the purchase being scanned
  let items = [];      // what is on screen
  let meta = null;     // the checks from the server
  let busy = false;

  const open = () => { backdrop.hidden = false; sheet.hidden = false; document.body.classList.add('sheet-open'); sheet.scrollTop = 0; };
  const close = () => { sheet.hidden = true; backdrop.hidden = true; document.body.classList.remove('sheet-open'); row = null; items = []; meta = null; busy = false; };
  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', () => { if (!busy) close(); });

  const message = (text, isError) => el('p', 'bill-msg' + (isError ? ' bad' : ''), text);

  // ---- the photo ----
  const shrink = (file) => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1700 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k));
      c.height = Math.max(1, Math.round(img.height * k));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('photo'))), 'image/jpeg', 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('photo')); };
    img.src = url;
  });
  const base64 = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error('photo'));
    r.readAsDataURL(blob);
  });

  // ---- screens ----
  const sums = () => {
    const price = items.reduce((s, i) => s + i.price, 0);
    const k = price > 0 && row.amount > 0 ? row.amount / price : 1;
    const part = (kind) => items.filter((i) => i.kind === kind).reduce((s, i) => s + i.price, 0) * k;
    return { need: part('need'), fun: part('fun'), unk: part('unk') };
  };

  const showStart = (existing) => {
    body.replaceChildren();
    const top = el('div', 'bill-top');
    top.append(el('b', '', row.merchant), el('span', '', money(row.amount)));
    body.append(top);
    if (existing && existing.length) {
      items = existing;
      meta = null;
      showItems(true);
      return;
    }
    body.append(message('Take a photo of the whole bill, flat and in good light. The photo is only read. It is never saved.'));
    const go = el('button', 'primary', '📷 Take a photo'); go.type = 'button';
    go.addEventListener('click', pick);
    body.append(go);
  };

  const pick = () => {
    const input = el('input'); input.type = 'file'; input.accept = 'image/*'; input.setAttribute('capture', 'environment'); input.hidden = true;
    input.addEventListener('change', () => { const f = input.files && input.files[0]; input.remove(); if (f) read(f); });
    document.body.append(input);
    input.click();
  };

  const showReading = () => {
    body.replaceChildren();
    const top = el('div', 'bill-top'); top.append(el('b', '', row.merchant), el('span', '', money(row.amount)));
    const wait = el('div', 'bill-wait'); wait.append(el('span', 'bill-spin'), el('span', '', 'Reading your bill…'));
    body.append(top, wait, message('This takes a few seconds.'));
  };

  const read = async (file) => {
    if (busy) return;
    busy = true;
    showReading();
    try {
      const jpeg = await shrink(file);
      const image = await base64(jpeg);
      const out = await window.spendApi('POST', 'bills/scan', { image, mime: 'image/jpeg', store: row.merchant, amount: row.amount });
      items = out.items.map((i) => ({ name: i.name, price: i.price, kind: i.kind }));
      meta = out;
      busy = false;
      showItems(false);
    } catch (x) {
      busy = false;
      body.replaceChildren();
      const top = el('div', 'bill-top'); top.append(el('b', '', row.merchant), el('span', '', money(row.amount)));
      const text = x && x.message && x.message !== 'photo' ? x.message : 'That photo could not be used. Try again.';
      const again = el('button', 'primary', 'Try again'); again.type = 'button';
      again.addEventListener('click', () => showStart(null));
      body.append(top, message(text, true), again);
    }
  };

  const showItems = (saved) => {
    // Always start from a clean screen, so nothing from the photo or reading steps is left behind.
    body.replaceChildren();
    const top = el('div', 'bill-top');
    top.append(el('b', '', row.merchant), el('span', '', money(row.amount)));
    body.append(top);
    if (saved) body.append(message('This bill was scanned before. Change any item, or scan it again.'));
    else body.append(message('Tap an item to switch it between necessary and unnecessary. Remove anything that is not an item.'));
    const list = el('div', 'bill-list');
    items.forEach((it, n) => {
      const line = el('div', 'bill-item k-' + it.kind);
      line.setAttribute('role', 'button');
      line.tabIndex = 0;
      const flip = () => { it.kind = it.kind === 'fun' ? 'need' : 'fun'; showItems(saved); };
      line.addEventListener('click', flip);
      line.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
      const mid = el('span', 'bill-mid');
      mid.append(el('b', '', it.name), el('span', '', it.kind === 'fun' ? 'Unnecessary' : it.kind === 'need' ? 'Necessary' : 'Not sure · tap to decide'));
      const rm = el('button', 'bill-x', '✕'); rm.type = 'button'; rm.setAttribute('aria-label', 'Remove ' + it.name);
      rm.addEventListener('click', (e) => { e.stopPropagation(); items.splice(n, 1); showItems(saved); });
      line.append(mid, el('span', 'bill-p', money(it.price)), rm);
      list.append(line);
    });
    body.append(list);
    if (meta && meta.matches !== null) {
      const add = Math.round(items.reduce((s, i) => s + i.price, 0) * 100) / 100;
      const ok = meta.matches;
      body.append(el('p', 'bill-check ' + (ok ? 'good' : 'warn'), ok ? '✓ The items and tax add up to this purchase.' : 'The items add up to ' + money(add) + (meta.tax ? ' plus ' + money(meta.tax) + ' tax' : '') + ', but the purchase is ' + money(row.amount) + '. A line may be missing or wrong. Check it before saving.'));
    }
    const s = sums();
    const total = Math.max(0.01, s.need + s.fun + s.unk);
    const bar = el('div', 'bill-split');
    const seg = (k, v) => { if (v <= 0) return; const i = el('i', 'k-' + k); i.style.width = (v / total * 100) + '%'; bar.append(i); };
    seg('need', s.need); seg('fun', s.fun); seg('unk', s.unk);
    const leg = el('p', 'bill-leg');
    const lab = (k, text, v) => { const sp = el('span'); sp.append(el('i', 'dot k-' + k), el('b', '', money(v)), document.createTextNode(' ' + text)); return sp; };
    leg.append(lab('need', 'necessary', s.need), lab('fun', 'unnecessary', s.fun));
    if (s.unk > 0.005) leg.append(lab('unk', 'not sure', s.unk));
    body.append(bar, leg);
    const acts = el('div', 'bill-actions');
    const save = el('button', 'primary', items.length ? 'Save ' + items.length + (items.length === 1 ? ' item' : ' items') : 'Remove the items'); save.type = 'button';
    save.addEventListener('click', () => store(save));
    const again = el('button', 'btn-plain', saved ? 'Scan it again' : 'Scan again'); again.type = 'button';
    again.addEventListener('click', () => showStart(null));
    acts.append(save, again);
    body.append(acts);
  };

  const store = async (btn) => {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await window.spendApi('PUT', 'purchases/' + row.id + '/items', { items: items.map((i) => ({ name: i.name, price: i.price, kind: i.kind })), amount: row.amount });
      const s = sums();
      const text = items.length ? 'Saved ' + items.length + ' items for ' + row.merchant + ' · ' + money(s.fun) + ' unnecessary' : 'Removed the items';
      close();
      if (window.spendToast) window.spendToast(text, null);
      if (window.dash) window.dash.reload();
    } catch (x) {
      busy = false;
      btn.disabled = false;
      btn.textContent = 'Try saving again';
      body.append(message(x && x.message ? x.message : 'Could not save. Check your connection.', true));
    }
  };

  window.spendScanBill = async (purchase) => {
    row = purchase;
    items = [];
    meta = null;
    busy = false;
    open();
    body.replaceChildren(message('One moment…'));
    let existing = null;
    try { existing = (await window.spendApi('GET', 'purchases/' + purchase.id + '/items')).items.map((i) => ({ name: i.name, price: i.price, kind: i.kind })); } catch (e) { /* no items yet is fine */ }
    if (row === purchase) showStart(existing);
  };
})();
