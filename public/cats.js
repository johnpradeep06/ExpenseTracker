(function () {
  // Your own categories (Rent, Phone, Daycare...): a name, an icon and whether it is necessary. They are saved on the
  // server (GET / PUT categories, stored encrypted), read by the calculations through window.spendCustom, and show up
  // in the category picker, the purchases list and the cards like the built-in ones.
  // Creating one: the picker on the Edit payment sheet ("+ New category..") or Settings > My categories.
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  if (!window.spendApi) return;

  const ICONS = ['🏠', '📱', '💡', '🧸', '🚗', '💊', '🎓', '🐶', '🛒', '🍽️', '🎁', '💼', '✈️', '🏋️', '🎮', '🔧'];
  const KINDS = [['need', 'Necessary'], ['unk', 'Not sure'], ['fun', 'Unnecessary']];
  const KIND_COLOR = { need: '#3BA776', fun: '#E8833A', unk: '#8C8C8C' };
  const MAX = 20;
  let custom = { cats: [], rules: {} };
  let loaded = false;
  let lastFetch = 0;
  let inflight = null;
  window.spendCustom = custom;
  window.spendCustomMeta = (name) => { const c = custom.cats.find((x) => x.name === name); return c ? [c.icon, KIND_COLOR[c.kind] || KIND_COLOR.unk] : null; };
  window.spendCustomNames = () => custom.cats.map((c) => c.name);

  // ---- loading and saving ----
  const sameAs = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const apply = (r) => {
    const next = { cats: (r && r.cats) || [], rules: (r && r.rules) || {} };
    const changed = !sameAs(next, custom) || !loaded;
    custom = next; window.spendCustom = custom;
    const first = !loaded; loaded = true;
    fillSelect(); drawList();
    // The numbers were worked out before the list was known (or it changed): work them out again.
    if (changed && (next.cats.length || !first) && window.dash && window.dash.reload) window.dash.reload();
  };
  const refresh = (force) => {
    if (inflight) return inflight;
    if (!force && Date.now() - lastFetch < 30000) return null;
    lastFetch = Date.now();
    inflight = window.spendApi('GET', 'categories').then(apply).catch(() => { /* not signed in yet, or offline */ }).then(() => { inflight = null; });
    return inflight;
  };
  const save = async (cats, rules) => {
    const r = await window.spendApi('PUT', 'categories', { cats, rules });
    apply(r); lastFetch = Date.now();
    return r;
  };

  // ---- the picker on the Edit payment sheet ----
  const select = $('#add-category');
  let before = '';
  const fillSelect = () => {
    if (!select) return;
    const keep = select.value && select.value !== '__new__' ? select.value : '';
    select.querySelectorAll('[data-custom]').forEach((o) => o.remove());
    const other = Array.from(select.options).find((o) => o.value === 'Other' || o.textContent.trim() === 'Other');
    custom.cats.forEach((c) => { const o = el('option', '', c.icon + ' ' + c.name); o.value = c.name; o.dataset.custom = '1'; select.insertBefore(o, other || null); });
    const add = el('option', '', '＋ New category…'); add.value = '__new__'; add.dataset.custom = '1'; select.append(add);
    if (keep && Array.from(select.options).some((o) => o.value === keep)) select.value = keep;
  };
  if (select) {
    select.addEventListener('focus', () => { before = select.value === '__new__' ? before : select.value; });
    select.addEventListener('change', () => {
      if (select.value !== '__new__') { before = select.value; return; }
      const store = ($('#add-merchant') && $('#add-merchant').value || '').trim();
      select.value = before;                       // until a category is really made
      openSheet({ store, onDone: (name) => { fillSelect(); select.value = name; before = name; } });
    });
  }

  // ---- the new / change category sheet ----
  const backdrop = el('div', 'backdrop cat-back'); backdrop.hidden = true;
  const sheet = el('div', 'sheet tall cat-sheet'); sheet.id = 'cat-sheet'; sheet.hidden = true;
  sheet.setAttribute('role', 'dialog'); sheet.setAttribute('aria-modal', 'true'); sheet.setAttribute('aria-label', 'Category');
  const sbody = el('div', 'cat-body');
  const grab = el('div', 'grab'); grab.setAttribute('aria-hidden', 'true');
  sheet.append(grab, sbody);
  const list = el('div', 'sheet tall cat-sheet'); list.id = 'cat-list'; list.hidden = true;
  list.setAttribute('role', 'dialog'); list.setAttribute('aria-modal', 'true'); list.setAttribute('aria-label', 'My categories');
  const lbody = el('div', 'cat-body');
  list.append(el('div', 'grab'), lbody);
  document.body.append(backdrop, sheet, list);

  const openCount = () => [sheet, list].filter((s) => !s.hidden).length;
  const showBackdrop = () => { backdrop.hidden = openCount() === 0; };
  const closeSheet = () => { sheet.hidden = true; showBackdrop(); };
  const closeList = () => { list.hidden = true; showBackdrop(); };
  backdrop.addEventListener('click', () => { if (!sheet.hidden) closeSheet(); else closeList(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!sheet.hidden) { e.stopPropagation(); closeSheet(); } else if (!list.hidden) { e.stopPropagation(); closeList(); } } }, true);

  // opts: { name (change an existing one), store (offer to always use it for this store), onDone(name) }
  const openSheet = (opts) => {
    const o = opts || {};
    const existing = o.name ? custom.cats.find((c) => c.name === o.name) : null;
    const d = { name: existing ? existing.name : '', icon: existing ? existing.icon : ICONS[0], kind: existing ? existing.kind : 'need', always: false };
    const b = sbody; b.replaceChildren();
    b.append(el('h2', '', existing ? 'Change ' + existing.name : 'New category'), el('p', 'sub', 'Only you see your categories.'));
    const err = el('p', 'cat-err'); err.hidden = true;
    const fail = (t) => { err.textContent = t; err.hidden = false; };
    if (!existing) {
      const nm = el('input'); nm.type = 'text'; nm.maxLength = 24; nm.placeholder = 'Name, like Rent or Phone'; nm.autocomplete = 'off';
      nm.addEventListener('input', () => { d.name = nm.value; });
      const f = el('label', 'field'); f.append(el('span', '', 'Name'), nm); b.append(f);
      setTimeout(() => nm.focus(), 80);
    }
    const icons = el('div', 'cat-icons');
    ICONS.forEach((ic) => { const x = el('button', '', ic); x.type = 'button'; x.setAttribute('aria-label', 'Icon ' + ic); x.setAttribute('aria-pressed', String(d.icon === ic)); x.addEventListener('click', () => { d.icon = ic; icons.querySelectorAll('button').forEach((y) => y.setAttribute('aria-pressed', String(y === x))); }); icons.append(x); });
    const fi = el('div', 'field'); fi.append(el('span', '', 'Icon'), icons); b.append(fi);
    const seg = el('div', 'cat-seg');
    KINDS.forEach(([k, label]) => { const x = el('button', 'k-' + k, label); x.type = 'button'; x.setAttribute('aria-pressed', String(d.kind === k)); x.addEventListener('click', () => { d.kind = k; seg.querySelectorAll('button').forEach((y) => y.setAttribute('aria-pressed', String(y === x))); }); seg.append(x); });
    const fk = el('div', 'field'); fk.append(el('span', '', 'Is it necessary?'), seg); b.append(fk);
    if (!existing && o.store) {
      const row = el('label', 'cat-always'); const cb = el('input'); cb.type = 'checkbox'; cb.addEventListener('change', () => { d.always = cb.checked; });
      const t = el('span'); t.append(document.createTextNode('Use it for '), el('b', '', o.store), document.createTextNode(' every time'));
      row.append(t, cb); b.append(row, el('p', 'cat-hint', 'So the next payment there goes into this category by itself.'));
    }
    if (existing) {
      const n = Object.keys(custom.rules).filter((k) => custom.rules[k] === existing.name).length;
      if (n) b.append(el('p', 'cat-hint', n === 1 ? 'One store always goes here.' : n + ' stores always go here.'));
    }
    b.append(err);
    const go = el('button', 'primary', existing ? 'Save' : 'Create'); go.type = 'button';
    go.addEventListener('click', async () => {
      const name = existing ? existing.name : d.name.replace(/\s+/g, ' ').trim();
      if (!name) return fail('Give it a name');
      if (!existing && custom.cats.length >= MAX) return fail('You can have up to ' + MAX + ' categories');
      const lower = name.toLowerCase();
      const builtIn = Array.from((select ? select.options : [])).some((x) => !x.dataset.custom && x.value && x.value.toLowerCase() === lower);
      if (!existing && (builtIn || custom.cats.some((c) => c.name.toLowerCase() === lower))) return fail('"' + name + '" is already a category. Choose a different name');
      go.disabled = true; go.textContent = 'Saving…';
      const cats = existing ? custom.cats.map((c) => (c.name === name ? { name, icon: d.icon, kind: d.kind } : c)) : custom.cats.concat([{ name, icon: d.icon, kind: d.kind }]);
      const rules = { ...custom.rules };
      if (d.always && o.store && window.spendMerchant) rules[window.spendMerchant.keyOf(o.store)] = name;
      try { await save(cats, rules); closeSheet(); if (o.onDone) o.onDone(name); if (window.spendToast) window.spendToast(existing ? 'Saved ' + name : 'Made the category ' + name, null); }
      catch (x) { go.disabled = false; go.textContent = existing ? 'Save' : 'Create'; fail(x && x.message ? x.message : 'Could not save. Check your connection.'); }
    });
    const cancel = el('button', 'link', 'Cancel'); cancel.type = 'button'; cancel.addEventListener('click', closeSheet);
    b.append(go, cancel);
    if (existing) {
      const del = el('button', 'danger-plain', 'Delete this category'); del.type = 'button'; let armed = false;
      del.addEventListener('click', async () => {
        if (!armed) { armed = true; del.textContent = 'Tap again. Its payments go back to the app\'s usual guess'; return; }
        const cats = custom.cats.filter((c) => c.name !== existing.name);
        const rules = {}; Object.keys(custom.rules).forEach((k) => { if (custom.rules[k] !== existing.name) rules[k] = custom.rules[k]; });
        try { await save(cats, rules); closeSheet(); if (window.spendToast) window.spendToast('Deleted ' + existing.name + '. No payment was lost', null); } catch (x) { fail('Could not delete it. Try again.'); }
      });
      b.append(del);
    }
    sheet.hidden = false; backdrop.hidden = false; sheet.scrollTop = 0;
  };

  // ---- Settings > My categories ----
  const drawList = () => {
    const b = lbody; b.replaceChildren();
    const head = el('div', 'set-head'); head.append(el('h2', '', 'My categories'));
    const done = el('button', 'link', 'Done'); done.type = 'button'; done.addEventListener('click', closeList); head.append(done);
    b.append(head);
    if (!custom.cats.length) b.append(el('p', 'sub', 'Make your own, like Rent, Phone or Daycare. Put any payment in them, and say whether they are necessary.'));
    const rows = el('div', 'cat-rows');
    custom.cats.forEach((c) => {
      const r = el('button', 'cat-row'); r.type = 'button';
      const ic = el('span', 'cat-ic', c.icon);
      const mid = el('span', 'cat-mid'); mid.append(el('b', '', c.name));
      const n = Object.keys(custom.rules).filter((k) => custom.rules[k] === c.name).length;
      const sub = el('span', '', KINDS.find((k) => k[0] === c.kind)[1] + (n ? ' · ' + n + (n === 1 ? ' store' : ' stores') + ' always' : ''));
      const dot = el('i', 'cat-dot'); dot.style.background = KIND_COLOR[c.kind]; sub.prepend(dot);
      mid.append(sub);
      r.append(ic, mid, el('span', 'cat-go', '›')); r.addEventListener('click', () => openSheet({ name: c.name })); rows.append(r);
    });
    b.append(rows);
    const add = el('button', 'btn-plain', '＋ New category'); add.type = 'button'; add.disabled = custom.cats.length >= MAX;
    add.addEventListener('click', () => openSheet({}));
    b.append(add);
    if (custom.cats.length >= MAX) b.append(el('p', 'sub', 'That is the most (' + MAX + ').'));
    b.append(el('p', 'cat-hint', 'Tap one to change its icon, whether it is necessary, or to delete it. Deleting never deletes a payment.'));
  };
  const openBtn = $('#cats-open');
  if (openBtn) openBtn.addEventListener('click', () => { drawList(); list.hidden = false; backdrop.hidden = false; list.scrollTop = 0; refresh(true); });

  drawList();
  if (window.dash && window.dash.onData) window.dash.onData(() => { refresh(false); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(true); });
  window.spendCatsRefresh = () => refresh(true);
})();
