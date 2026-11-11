(function () {
  // Sign in with email and password, connect the Shortcut, then show the spending. The session is kept only on this phone.
  // The iCloud links for the two shared Shortcuts. An empty one shows "ask for the link" instead.
  const TAP_URL = 'https://www.icloud.com/shortcuts/500cbb0903604c33a92973012fe0b1ed';
  const NOTIF_URL = 'https://www.icloud.com/shortcuts/b7315a1815c944479b2022f220bb2e3d';
  const $ = (s) => document.querySelector(s);
  const read = (k) => { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } };
  const write = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } };
  const clear = (k) => { try { localStorage.removeItem(k); } catch (e) { /* storage unavailable */ } };
  const session = window.spendSession;
  const onIOS = /iPad|iPhone|iPod/.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const installed = () => navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

  const show = (which) => {
    ['#signin', '#tour', '#onboard', '#app'].forEach((id) => { $(id).hidden = id !== which; });
    if (which !== '#onboard') stopWatch();
    window.scrollTo(0, 0);
  };
  const note = (sel, text) => {
    const el = $(sel);
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || '';
  };

  // Everything this app keeps on the phone for one person, removed on sign-out.
  const forgetPhone = () => ['spend.cache', 'spend.pending', 'spend.limit', 'spend.device', 'spend.email', 'spend.onboarded', 'spend.owner', 'spend.realOffer', 'spend.alertsAsk'].forEach(clear);

  // ---- sign-in ----------------------------------------------------------------------------------------------
  let signingUp = false;
  let resetting = false;
  const setMode = (up, reset) => {
    signingUp = !!up && !reset;
    resetting = !!reset;
    $('#auth-submit').textContent = resetting ? 'Set new password' : up ? 'Create account' : 'Sign in';
    $('#auth-toggle').textContent = resetting ? 'Back to sign in' : up ? 'Already have an account? Sign in' : 'New here? Create an account';
    $('#auth-password').autocomplete = up || resetting ? 'new-password' : 'current-password';
    $('#auth-password').setAttribute('aria-label', resetting ? 'New password' : 'Password');
    $('#auth-hint').hidden = !signingUp;
    $('#invite-field').hidden = !signingUp;
    $('#reset-field').hidden = !resetting;
    $('#reset-hint').hidden = !resetting;
    $('#auth-forgot').hidden = signingUp || resetting;
    note('#signin-error', '');
  };
  $('#auth-toggle').addEventListener('click', () => setMode(resetting ? false : !signingUp));
  $('#auth-forgot').addEventListener('click', () => setMode(false, true));

  $('#auth-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    note('#signin-error', '');
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    if (!email || !password) { note('#signin-error', resetting ? 'Enter your email and a new password.' : 'Enter your email and password.'); return; }
    if (resetting && !$('#auth-reset').value.trim()) { note('#signin-error', 'Enter the reset code you were given.'); return; }
    const btn = $('#auth-submit');
    btn.disabled = true;
    try {
      const body = { email, password };
      if (signingUp) {
        body.invite = $('#auth-invite').value.trim();
        if (!body.invite) { note('#signin-error', 'Enter the invite code you were given.'); btn.disabled = false; return; }
      }
      if (resetting) body.code = $('#auth-reset').value.trim();
      const r = await window.spendApi('POST', resetting ? 'auth/reset' : signingUp ? 'auth/signup' : 'auth/login', body);
      session.set(r.session);
      write('spend.email', r.email || '');
      $('#auth-password').value = '';
      $('#auth-invite').value = '';
      $('#auth-reset').value = '';
      try { await window.spendApi('PUT', 'me', { tz: Intl.DateTimeFormat().resolvedOptions().timeZone }); } catch (e) { /* stays on the default */ }
      // First time: connect the Shortcut. Coming back on a new phone: straight to the spending.
      if (r.isNew) showTour(false);
      else {
        write('spend.onboarded', '1');
        startApp();
      }
    } catch (e) {
      note('#signin-error', e && e.status ? e.message : 'Could not reach the server. Check your connection and try again.');
    } finally {
      btn.disabled = false;
    }
  });

  const showSignIn = (message) => {
    dash.stop();
    show('#signin');
    setMode(false);
    note('#signin-error', message || '');
    $('#install-tip').hidden = !(onIOS && !installed());
  };

  // ---- connecting the Shortcut ------------------------------------------------------------------------------
  // Watches for the first purchase while the setup page is open, so a new person sees it work.
  let watchTimer = null;
  function stopWatch() {
    clearInterval(watchTimer);
    watchTimer = null;
  }
  const watchFirst = async () => {
    stopWatch();
    const box = $('#first-status');
    box.className = 'first-status waiting';
    $('#first-text').textContent = 'Waiting for your first purchase…';
    let base = null;
    const check = async () => {
      try {
        const list = await window.spendApi('GET', 'purchases');
        if (base === null) { base = list.length; return; }
        if (list.length > base) {
          const body = String((list[0] && list[0].body) || '');
          const merchant = /Merchant: (.+)/.exec(body);
          const amount = /Amount: (.+)/.exec(body);
          box.className = 'first-status done';
          $('#first-text').textContent = '✓ It works! Got ' + (merchant && amount ? merchant[1].trim() + ' ' + amount[1].trim() : 'a Wallet notification') + '.';
          stopWatch();
        }
      } catch (e) {
        if (e && e.kind === 'auth') stopWatch();
      }
    };
    await check();
    if (document.querySelector('#onboard').hidden === false) watchTimer = setInterval(check, 5000);
  };

  let code = '';
  const setLink = (a, missing, url) => {
    a.hidden = !url;
    missing.hidden = !!url;
    if (url) a.href = url;
  };
  const showOnboard = async () => {
    dash.stop();
    show('#onboard');
    note('#onboard-error', '');
    setLink($('#tap-link'), $('#tap-missing'), TAP_URL);
    setLink($('#notif-link'), $('#notif-missing'), NOTIF_URL);
    $('#step-home').hidden = installed();
    $('#copy-code').disabled = true;
    $('#setup-code').textContent = 'Loading…';
    try {
      code = (await window.spendApi('GET', 'setup-code')).code;
      $('#setup-code').textContent = code;
      $('#copy-code').disabled = false;
      watchFirst();
    } catch (e) {
      if (e && e.kind === 'auth') return signOut('Please sign in again.');
      $('#setup-code').textContent = '—';
      note('#onboard-error', 'Could not load your setup code. Check your connection and try again.');
    }
  };

  // ---- the first-time tour ----
  const SLIDES = [
    ['📊', 'Your spending at a glance', 'The big number is what you spent in the last 14 days. Below it, a chart shows each day against your daily average.'],
    ['🎯', 'Set a daily limit', 'Tap the target button at the top to pick how much you want to spend a day. The chart then shows what is left today.'],
    ['👆', 'Tap, swipe and expand', 'Tap a category to see only those purchases. Tap a purchase to edit it, or swipe it left to delete it (Undo is always there). The expand button by Purchases shows the last four weeks.'],
    ['🔔', 'Alerts that keep you on track', 'Get a note each morning with what you can spend, an alert right after a purchase that puts you over your limit, and a reminder each night at 9. Turn them on in Settings, the gear at the top.']
  ];
  let slide = 0;
  let tourReturnsToApp = false;
  const drawSlide = () => {
    const [icon, title, text] = SLIDES[slide];
    $('#tour-icon').textContent = icon;
    $('#tour-title').textContent = title;
    $('#tour-text').textContent = text;
    $('#tour-count').textContent = (slide + 1) + ' of ' + SLIDES.length;
    $('#tour-back').style.visibility = slide === 0 ? 'hidden' : 'visible';
    $('#tour-next').textContent = slide === SLIDES.length - 1 ? (tourReturnsToApp ? 'Done' : 'Set up my Shortcuts') : 'Next';
    const dots = $('#tour-dots');
    dots.replaceChildren();
    SLIDES.forEach((_, i) => {
      const d = document.createElement('span');
      if (i === slide) d.className = 'on';
      dots.append(d);
    });
  };
  const finishTour = () => {
    if (tourReturnsToApp) startApp();
    else showOnboard();
  };
  const showTour = (fromSettings) => {
    tourReturnsToApp = !!fromSettings;
    slide = 0;
    dash.stop();
    show('#tour');
    drawSlide();
  };
  $('#tour-next').addEventListener('click', () => {
    if (slide < SLIDES.length - 1) { slide++; drawSlide(); } else finishTour();
  });
  $('#tour-back').addEventListener('click', () => { if (slide > 0) { slide--; drawSlide(); } });
  $('#tour-skip').addEventListener('click', finishTour);
  $('#copy-code').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(code);
      $('#copy-code').textContent = 'Copied';
    } catch (e) {
      // Older browsers: select the code so it can be copied by hand.
      const r = document.createRange();
      r.selectNodeContents($('#setup-code'));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      $('#copy-code').textContent = 'Selected, tap Copy';
    }
    setTimeout(() => { $('#copy-code').textContent = 'Copy setup code'; }, 2500);
  });
  $('#onboard-done').addEventListener('click', () => {
    write('spend.onboarded', '1');
    startApp();
  });

  // ---- settings panel (the gear at the top) ----
  const settingsSheet = $('#settings-sheet');
  const settingsBackdrop = $('#settings-backdrop');
  const closeSettings = () => {
    settingsSheet.hidden = true;
    settingsBackdrop.hidden = true;
    document.body.classList.remove('sheet-open');
  };
  const openSettings = () => {
    const lim = window.spendLimit;
    $('#settings-limit-val').textContent = lim > 0 ? '$' + (Math.round(lim) === lim ? lim : lim.toFixed(2)) + ' a day' : 'Not set';
    const t = $('#toast');
    if (t) t.hidden = true;
    settingsBackdrop.hidden = false;
    settingsSheet.hidden = false;
    document.body.classList.add('sheet-open');
    settingsSheet.scrollTop = 0;
    if (window.spendAlertsRender) window.spendAlertsRender();
    // Only the owner sees "People & invites". Shown straight away from the last answer, then checked again.
    $('#people-open').hidden = read('spend.owner') !== '1';
    window.spendApi('GET', 'me').then((me) => {
      const owner = !!(me && me.isOwner);
      if (owner) write('spend.owner', '1'); else clear('spend.owner');
      if ($('#people-open').hidden === owner) $('#people-open').hidden = !owner;
    }).catch(() => {});
  };
  $('#settings-open').addEventListener('click', openSettings);
  $('#settings-close').addEventListener('click', closeSettings);
  settingsBackdrop.addEventListener('click', closeSettings);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !settingsSheet.hidden) closeSettings(); });
  $('#settings-limit').addEventListener('click', () => {
    closeSettings();
    if (window.spendOpenLimit) window.spendOpenLimit();
  });

  // Swipe down on a panel to minimise it. The gesture is decided once, after the finger has moved 10px:
  // a clear downward pull that starts on the handle or title, or with the panel already at its very top, drags the
  // panel (and stops the page's own scroll so the two never fight). Anything else is left to normal scrolling.
  const swipeToClose = (sheet, close) => {
    let x0 = 0;
    let y0 = 0;
    let dy = 0;
    let mode = 'off';
    let fromHandle = false;
    const settle = () => {
      sheet.style.transition = 'transform .2s ease';
      sheet.style.transform = '';
      setTimeout(() => { sheet.style.transition = ''; }, 220);
    };
    sheet.addEventListener('touchstart', (e) => {
      dy = 0;
      if (!e.touches || e.touches.length !== 1) { mode = 'off'; return; }
      fromHandle = !!(e.target.closest && e.target.closest('.grab, .set-head'));
      x0 = e.touches[0].clientX;
      y0 = e.touches[0].clientY;
      mode = fromHandle || sheet.scrollTop <= 0 ? 'maybe' : 'off';
    }, { passive: true });
    sheet.addEventListener('touchmove', (e) => {
      if (mode === 'off' || !e.touches || !e.touches.length) return;
      const ddx = e.touches[0].clientX - x0;
      const ddy = e.touches[0].clientY - y0;
      if (mode === 'maybe') {
        if (Math.abs(ddx) < 10 && Math.abs(ddy) < 10) return;
        mode = ddy > 0 && Math.abs(ddy) > Math.abs(ddx) && (fromHandle || sheet.scrollTop <= 0) ? 'drag' : 'off';
        if (mode === 'off') return;
      }
      if (e.cancelable) e.preventDefault();
      dy = Math.max(0, ddy - 10);
      sheet.style.transition = 'none';
      sheet.style.transform = 'translateY(' + dy + 'px)';
    }, { passive: false });
    sheet.addEventListener('touchend', () => {
      if (mode !== 'drag') { mode = 'off'; return; }
      mode = 'off';
      if (dy > 90) {
        sheet.style.transition = '';
        sheet.style.transform = '';
        close();
      } else {
        settle();
      }
    });
    sheet.addEventListener('touchcancel', () => { if (mode === 'drag') settle(); mode = 'off'; });
  };

  // While a panel is open, pin the page behind it. On iPhone, overflow:hidden alone does not stop the page
  // scrolling underneath, which makes the panel judder. One place handles every panel by watching the class.
  let lockedY = 0;
  new MutationObserver(() => {
    const body = document.body;
    const on = body.classList.contains('sheet-open');
    if (on && body.style.position !== 'fixed') {
      lockedY = window.scrollY;
      Object.assign(body.style, { position: 'fixed', top: -lockedY + 'px', left: '0', right: '0' });
    } else if (!on && body.style.position === 'fixed') {
      Object.assign(body.style, { position: '', top: '', left: '', right: '' });
      window.scrollTo(0, lockedY);
    }
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  window.spendCloseSettings = closeSettings;
  window.spendSwipeToClose = swipeToClose;

  // ---- all purchases (the expand button next to "Purchases") ----
  const allSheet = $('#all-sheet');
  const allBackdrop = $('#all-backdrop');
  let allScroll = 0;
  const closeAll = () => {
    allScroll = allSheet.scrollTop;
    allSheet.hidden = true;
    allBackdrop.hidden = true;
    document.body.classList.remove('sheet-open');
  };
  // keep = coming back from editing a purchase: same scroll spot, and the "Deleted … Undo" note stays visible.
  const openAll = (keep) => {
    if (!keep) {
      const t = $('#toast');
      if (t) t.hidden = true;
    }
    dash.render();
    allBackdrop.hidden = false;
    allSheet.hidden = false;
    document.body.classList.add('sheet-open');
    allSheet.scrollTop = keep ? allScroll : 0;
  };
  window.spendCloseAll = closeAll;
  window.spendOpenAll = openAll;
  $('#all-open').addEventListener('click', () => openAll(false));
  $('#all-close').addEventListener('click', closeAll);
  allBackdrop.addEventListener('click', closeAll);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !allSheet.hidden) closeAll(); });
  swipeToClose(allSheet, closeAll);
  swipeToClose(settingsSheet, closeSettings);

  // ---- the app ------------------------------------------------------------------------------------------------
  const startApp = () => {
    show('#app');
    $('#acct-email').textContent = read('spend.email') || 'your account';
    dash.start(() => window.loadPurchases());
    if (window.spendSyncLimit) window.spendSyncLimit();
    if (window.spendAlertsRender) window.spendAlertsRender();
    if (window.spendAlertsSync) window.spendAlertsSync();
  };

  const signOut = (message) => {
    closeSettings();
    closeAll();
    if (window.spendClosePeople) window.spendClosePeople();
    session.clear();
    forgetPhone();
    window.spendLimit = 0;
    showSignIn(message);
  };

  $('#show-code').addEventListener('click', showOnboard);
  $('#tour-open').addEventListener('click', () => { closeSettings(); showTour(true); });
  $('#pw-open').addEventListener('click', () => {
    const f = $('#pw-form');
    f.hidden = !f.hidden;
    note('#pw-note', '');
    if (!f.hidden) $('#pw-current').focus();
  });
  $('#pw-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    note('#pw-note', '');
    const current = $('#pw-current').value;
    const next = $('#pw-new').value;
    if (!current || next.length < 10) { note('#pw-note', next.length < 10 && current ? 'Use a new password of at least 10 characters.' : 'Enter your current password and a new one of at least 10 characters.'); return; }
    const btn = $('#pw-save');
    btn.disabled = true;
    try {
      const r = await window.spendApi('PUT', 'me/password', { current, password: next });
      if (r.session) session.set(r.session);
      $('#pw-current').value = '';
      $('#pw-new').value = '';
      $('#pw-form').hidden = true;
      note('#acct-note', 'Password changed. Your other phones were signed out.');
    } catch (e) {
      note('#pw-note', e && e.status ? e.message : 'Could not reach the server. Check your connection and try again.');
    } finally {
      btn.disabled = false;
    }
  });
  $('#sign-out').addEventListener('click', () => signOut('You are signed out.'));
  $('#sign-out-all').addEventListener('click', async () => {
    try {
      await window.spendApi('POST', 'signout-all');
      signOut('You are signed out on every phone.');
    } catch (e) {
      note('#acct-note', 'Could not reach the server. Try again.');
    }
  });
  let armed = false;
  $('#delete-account').addEventListener('click', async () => {
    const btn = $('#delete-account');
    if (!armed) {
      armed = true;
      btn.textContent = 'Tap again to delete everything';
      note('#acct-note', 'This deletes your account, every purchase, your limit and your alerts. It cannot be undone.');
      setTimeout(() => { armed = false; btn.textContent = 'Delete my account and all data'; }, 8000);
      return;
    }
    btn.disabled = true;
    try {
      await window.spendApi('DELETE', 'account');
      signOut('Your account and all its data are deleted.');
    } catch (e) {
      note('#acct-note', 'Could not delete right now. Check your connection and try again.');
    } finally {
      btn.disabled = false;
      armed = false;
      btn.textContent = 'Delete my account and all data';
    }
  });

  const timeFmt = new Intl.DateTimeFormat('en-CA', { hour: 'numeric', minute: '2-digit' });
  dash.onData(() => {
    const m = dash.data('mail_now');
    if (m.status === 'connect') {
      signOut('Please sign in again.');
      return;
    }
    const el = $('#updated');
    const err = $('#load-error');
    if (err) err.hidden = m.status !== 'error';
    if (!el) return;
    const offline = $('#offline-note');
    const stale = m.status === 'ok' && window.spendStale === true;
    if (offline) {
      offline.hidden = !stale;
      if (stale) offline.textContent = 'You\'re offline, or the server can\'t be reached. Showing what was saved on this phone (' + timeFmt.format(new Date(window.spendCachedAt)) + '). It updates when the connection is back.';
    }
    if (stale) el.textContent = 'Offline · saved ' + timeFmt.format(new Date(window.spendCachedAt));
    else if (m.status === 'ok' && dash.lastUpdated) el.textContent = 'Updated ' + timeFmt.format(dash.lastUpdated);
    else if (m.status === 'loading') el.textContent = 'Loading…';
    else el.textContent = '';
  });

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => dash.render(), 150);
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => dash.render());

  const appShown = () => !$('#app').hidden && !!session.get();
  setInterval(() => {
    if (document.visibilityState === 'visible' && appShown()) dash.reload();
  }, 3600000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !appShown()) return;
    const unsent = window.spendQueue && window.spendQueue.list().length > 0;
    if (window.spendStale || unsent || !dash.lastUpdated || Date.now() - dash.lastUpdated.getTime() > 300000) dash.reload();
  });
  window.addEventListener('online', () => {
    if (appShown()) dash.reload();
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
  }

  // Old GitHub-based copies of this app kept these; they are not used any more.
  ['spend.token', 'spend.repo'].forEach(clear);

  const inviteFromLink = new URLSearchParams(location.search).get('invite');
  const resetFromLink = new URLSearchParams(location.search).get('reset');
  if (inviteFromLink || resetFromLink) {
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* not important */ }
  }
  if (!session.get()) {
    showSignIn();
    if (inviteFromLink) {
      setMode(true);
      $('#auth-invite').value = inviteFromLink.slice(0, 80);
    } else if (resetFromLink) {
      setMode(false, true);
      $('#auth-reset').value = resetFromLink.slice(0, 80);
    }
  } else if (!read('spend.onboarded')) showOnboard();
  else startApp();
})();
