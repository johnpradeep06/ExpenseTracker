/* People & invites: only the owner sees this. Create single-use invites, switch new signups on or off, and
   remove or restore a person's access. Everything is drawn with textContent, never innerHTML. */
(function () {
  const $ = (s) => document.querySelector(s);
  const sheet = $('#people-sheet');
  const backdrop = $('#people-backdrop');
  const openBtn = $('#people-open');
  if (!sheet || !backdrop || !openBtn) return;

  const day = new Intl.DateTimeFormat('en-CA', { month: 'short', day: 'numeric' });
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const showError = (msg) => {
    const e = $('#people-error');
    e.textContent = msg || '';
    e.hidden = !msg;
  };
  const friendly = (x) => (x && x.status ? x.message : 'Could not reach the server. Check your connection and try again.');

  let lastCode = '';
  let lastExpiry = '';
  const inviteMessage = () =>
    'You\'re invited to My spending, a private Apple Pay spending tracker.\n' +
    'Open ' + location.origin + '/?invite=' + lastCode + ' to create your account.\n' +
    'Your invite code is ' + lastCode + ' (it works once and expires ' + day.format(new Date(lastExpiry)) + ').';

  const copy = async (text, button, done) => {
    const label = button.textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = done;
    } catch (e) {
      const r = document.createRange();
      r.selectNodeContents($('#inv-code'));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      button.textContent = 'Selected, tap Copy';
    }
    setTimeout(() => { button.textContent = label; }, 2200);
  };

  const row = (main, sub, button, cls, extra) => {
    const r = el('div', 'person' + (cls ? ' ' + cls : ''));
    const m = el('div', 'person-main');
    m.append(el('b', '', main), el('span', '', sub));
    r.append(m);
    if (extra && button) {
      const box = el('div', 'person-actions');
      box.append(extra, button);
      r.append(box);
    } else if (button) r.append(button);
    return r;
  };

  // A reset code for someone who forgot their password: one tap, then send them the message.
  let resetCode = '';
  let resetExpiry = '';
  let resetEmail = '';
  const resetMessage = () =>
    'Reset your password for My spending.\n' +
    'Open ' + location.origin + '/?reset=' + resetCode + ' and enter your email (' + resetEmail + ') and a new password.\n' +
    'Your reset code is ' + resetCode + ' (it works once and expires ' + day.format(new Date(resetExpiry)) + ').';
  const copyReset = async (text, button, done) => {
    const label = button.textContent;
    try { await navigator.clipboard.writeText(text); button.textContent = done; }
    catch (e) {
      const rg = document.createRange();
      rg.selectNodeContents($('#reset-code'));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(rg);
      button.textContent = 'Selected, tap Copy';
    }
    setTimeout(() => { button.textContent = label; }, 2200);
  };

  const ago = (iso) => {
    if (!iso) return '';
    const m = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (m < 2) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + ' h ago';
    const d = Math.round(h / 24);
    return d === 1 ? 'yesterday' : d + ' days ago';
  };
  const usageLine = (u) => {
    if (!u) return '';
    const bits = [!u.connected ? 'Shortcut not set up yet' : !u.purchases ? 'Setup code made, no purchase yet' : 'Shortcut working'];
    if (u.purchases) bits.push(u.purchases + (u.purchases === 1 ? ' purchase' : ' purchases') + (u.lastPurchase ? ', last ' + ago(u.lastPurchase) : ''));
    bits.push(u.lastSeen ? 'opened ' + ago(u.lastSeen) : 'never opened');
    return bits.join(' · ');
  };
  const DOT = { active: '🟢 ', quiet: '🟡 ', waiting: '🟠 ', 'not-connected': '⚪ ' };

  const draw = (data) => {
    const toggle = $('#signups-state');
    toggle.textContent = data.signupsOpen ? 'On' : 'Off';
    $('#signups-toggle').dataset.open = data.signupsOpen ? '1' : '0';

    const inv = $('#invites-list');
    inv.replaceChildren();
    if (!data.invites.length) inv.append(el('p', 'empty-line', 'No unused invites.'));
    data.invites.forEach((i) => {
      const b = el('button', 'btn-plain mini', 'Cancel');
      b.type = 'button';
      b.addEventListener('click', async () => {
        b.disabled = true;
        try {
          await window.spendApi('DELETE', 'owner/invites/' + i.id);
          load();
        } catch (x) {
          showError(friendly(x));
          b.disabled = false;
        }
      });
      inv.append(row(i.note || 'Invite', 'Expires ' + day.format(new Date(i.expires_at)), b));
    });

    const list = $('#people-list');
    list.replaceChildren();
    data.people.forEach((p) => {
      let b = null;
      let rb = null;
      if (!p.owner && !p.disabled) {
        rb = el('button', 'btn-plain mini', 'Reset password');
        rb.type = 'button';
        rb.addEventListener('click', async () => {
          rb.disabled = true;
          showError('');
          try {
            const r = await window.spendApi('POST', 'owner/people/' + p.id + '/reset');
            resetCode = r.code; resetExpiry = r.expires_at; resetEmail = r.email;
            $('#reset-code').textContent = r.code;
            $('#reset-for').textContent = 'Reset code for ' + r.email + '. Send it to them. It works once and lasts 24 hours.';
            $('#reset-result').hidden = false;
            $('#reset-result').scrollIntoView({ block: 'nearest' });
          } catch (x) {
            showError(friendly(x));
          }
          rb.disabled = false;
        });
      }
      if (!p.owner) {
        const restoring = p.disabled;
        b = el('button', 'btn-plain mini' + (restoring ? '' : ' danger-mini'), restoring ? 'Restore' : 'Remove access');
        b.type = 'button';
        let armed = false;
        b.addEventListener('click', async () => {
          if (!restoring && !armed) {
            armed = true;
            b.textContent = 'Tap again to remove';
            setTimeout(() => { armed = false; if (b.isConnected) b.textContent = 'Remove access'; }, 5000);
            return;
          }
          b.disabled = true;
          try {
            await window.spendApi('POST', 'owner/people/' + p.id + '/' + (restoring ? 'restore' : 'remove'));
            load();
          } catch (x) {
            showError(friendly(x));
            b.disabled = false;
          }
        });
      }
      const sub = p.owner ? 'You (owner)' : p.disabled ? 'Access removed' : 'Joined ' + day.format(new Date(p.joined));
      const r = row(p.email, sub, b, p.disabled ? 'off' : '', rb);
      if (!p.disabled && p.usage) r.querySelector('.person-main').append(el('span', 'usage ' + p.usage.status, (DOT[p.usage.status] || '') + usageLine(p.usage)));
      list.append(r);
    });
  };

  const load = async () => {
    showError('');
    try {
      draw(await window.spendApi('GET', 'owner/people'));
    } catch (x) {
      showError(friendly(x));
    }
  };

  const open = () => {
    if (window.spendCloseSettings) window.spendCloseSettings();
    $('#inv-result').hidden = true;
    $('#reset-result').hidden = true;
    $('#inv-note').value = '';
    backdrop.hidden = false;
    sheet.hidden = false;
    document.body.classList.add('sheet-open');
    sheet.scrollTop = 0;
    load();
  };
  const close = () => {
    sheet.hidden = true;
    backdrop.hidden = true;
    document.body.classList.remove('sheet-open');
    $('#inv-result').hidden = true;
    $('#reset-result').hidden = true;
    lastCode = '';
    resetCode = '';
  };

  $('#inv-create').addEventListener('click', async () => {
    const btn = $('#inv-create');
    btn.disabled = true;
    showError('');
    try {
      const r = await window.spendApi('POST', 'owner/invites', { note: $('#inv-note').value, days: Number($('#inv-days').value) });
      lastCode = r.code;
      lastExpiry = r.expires_at;
      $('#inv-code').textContent = r.code;
      $('#inv-result').hidden = false;
      $('#inv-note').value = '';
      load();
    } catch (x) {
      showError(friendly(x));
    }
    btn.disabled = false;
  });
  $('#inv-copy-code').addEventListener('click', (e) => copy(lastCode, e.currentTarget, 'Copied'));
  $('#inv-share').addEventListener('click', (e) => copy(inviteMessage(), e.currentTarget, 'Copied'));

  $('#reset-copy-code').addEventListener('click', (e) => copyReset(resetCode, e.currentTarget, 'Copied'));
  $('#reset-share').addEventListener('click', (e) => copyReset(resetMessage(), e.currentTarget, 'Copied'));

  $('#signups-toggle').addEventListener('click', async () => {
    const turnOn = $('#signups-toggle').dataset.open !== '1';
    showError('');
    try {
      await window.spendApi('PUT', 'owner/signups', { open: turnOn });
      load();
    } catch (x) {
      showError(friendly(x));
    }
  });

  openBtn.addEventListener('click', open);
  $('#people-close').addEventListener('click', close);
  backdrop.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) close(); });
  if (window.spendSwipeToClose) window.spendSwipeToClose(sheet, close);
  // Signing out closes it too.
  window.spendClosePeople = close;
})();
