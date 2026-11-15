# Browser test of necessary / unnecessary marks and the "Where money leaks" card against test/dev.js. Run: python3 test/leaks_e2e.py
import json, datetime, urllib.request as u
from playwright.sync_api import sync_playwright
BASE = 'http://127.0.0.1:8790'
H = {'Authorization': 'Bearer dev-admin', 'Content-Type': 'application/json'}
post = lambda path, body: json.loads(u.urlopen(u.Request(BASE + path, data=json.dumps(body).encode(), headers=H, method='POST')).read())
now = datetime.datetime.now(datetime.timezone.utc)
# (minutes ago, merchant, amount, category as the Shortcut said it)
ROWS = [(10, 'Metro', 81.93, 'Groceries'), (40, 'STM', 6.50, 'Transport'), (55, 'Studio Zen', 65.00, 'Other'), (70, 'SAQ', 28.80, 'Other'), (100, 'Uber Eats', 28.40, 'Other'),
        (130, 'Tim Hortons', 4.50, 'Other'), (160, 'Tim Hortons', 4.50, 'Other'), (190, 'Tim Hortons', 4.50, 'Other')]
issues = []
for mins, m, a, c in ROWS:
    t = (now - datetime.timedelta(minutes=mins)).strftime('%Y-%m-%dT%H:%M:%SZ')
    issues.append({"title": f"Spending - ${a}", "body": f"Date: {t}\nMerchant: {m}\nAmount: ${a}\nCard: Visa\nCategory: {c}", "state": "open", "created_at": t})
NEED = 81.93 + 6.50
FUN = 28.80 + 28.40 + 4.50 * 3
UNK = 65.00
res, errs = [], []


def ok(c, l):
    res.append(bool(c))
    print(('  ok ' if c else '  FAIL ') + l)


money = lambda x: '$' + format(round(x, 2), ',.2f')
with sync_playwright() as P:
    b = P.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 390, 'height': 1100}, device_scale_factor=2, has_touch=True, is_mobile=True)
    ctx.add_init_script("try{localStorage.setItem('spend.alertsAsk',String(Date.now()))}catch(e){}")
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errs.append(str(e)))
    cdp = ctx.new_cdp_session(pg)
    vis = lambda s: pg.locator(s).is_visible()

    def swipe(sel, i, dx, hold=False):
        pg.locator(sel).nth(i).scroll_into_view_if_needed()
        pg.wait_for_timeout(150)
        r = pg.locator(sel).nth(i).bounding_box()
        x0, y = r['x'] + r['width'] / 2 - (dx / 2), r['y'] + r['height'] / 2
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x0, 'y': y}]})
        for k in range(1, 11):
            cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x0 + dx * k / 10, 'y': y}]})
            pg.wait_for_timeout(18)
        if not hold:
            cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
            pg.wait_for_timeout(900)

    em = 'leaks@example.com'
    pg.goto(BASE + '/?invite=' + post('/api/admin/invites', {})['code']); pg.wait_for_timeout(500)
    pg.fill('#auth-email', em); pg.fill('#auth-password', 'leaks-password-123'); pg.click('#auth-submit'); pg.wait_for_timeout(1000)
    post('/api/admin/import', {"email": em, "issues": issues, "dailyLimit": 0})
    pg.click('#tour-skip'); pg.wait_for_timeout(900); pg.click('#onboard-done'); pg.wait_for_timeout(3500)

    # ---- the card ----
    txt = lambda: pg.inner_text('#leaks')
    ok(vis('#leaks'), 'the Where money leaks card shows in the Clean look')
    ok(money(FUN) in txt() and money(NEED) in txt() and money(UNK) in txt(), 'it adds up unnecessary %s, necessary %s and not sure %s' % (money(FUN), money(NEED), money(UNK)))
    ok(str(round(FUN / (FUN + NEED + UNK) * 100)) + '% of spending' in txt(), 'and the share of your spending')
    ok('Tim Hortons ×3' in txt(), 'the biggest leaks name the store you keep going back to')
    # ---- the colours on the rows ----
    names = pg.eval_on_selector_all('#latest .tx-swipe .tx', "els => els.map(e => [e.querySelector('.cat-name').textContent, e.className])")
    kind = lambda n: next(c for m, c in names if m == n)
    ok('k-need' in kind('Metro') and 'k-need' in kind('STM'), 'groceries and transport start green (necessary)')
    ok('k-fun' in kind('SAQ') and 'k-fun' in kind('Uber Eats') and 'k-fun' in kind('Tim Hortons'), 'SAQ, delivery and coffee start orange (unnecessary)')
    ok('k-unk' in kind('Studio Zen'), 'a store the app cannot place starts grey (not sure)')

    # ---- swiping ----
    row_of = lambda name: next(i for i, (m, c) in enumerate(names) if m == name)
    i = row_of('Metro')
    swipe('#latest .tx-swipe .tx', i, 100, hold=True)
    ok(pg.locator('#latest .tx-swipe').nth(i).locator('.tx-flip').is_visible() and 'Unnecessary' in pg.locator('#latest .tx-swipe').nth(i).locator('.tx-flip').inner_text(), 'dragging a green row to the right shows the orange Unnecessary action')
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []}); pg.wait_for_timeout(1200)
    names = pg.eval_on_selector_all('#latest .tx-swipe .tx', "els => els.map(e => [e.querySelector('.cat-name').textContent, e.className])")
    ok('k-fun' in kind('Metro'), 'letting go flips Metro to orange')
    ok(money(FUN + 81.93) in txt() and money(NEED - 81.93) in txt(), 'and the card updates at once: %s unnecessary' % money(FUN + 81.93))
    ok('Metro is now unnecessary' in pg.inner_text('#toast-text') and vis('#toast-undo'), 'a toast says so, with Undo')
    pg.click('#toast-undo'); pg.wait_for_timeout(1500)
    names = pg.eval_on_selector_all('#latest .tx-swipe .tx', "els => els.map(e => [e.querySelector('.cat-name').textContent, e.className])")
    ok('k-need' in kind('Metro') and money(FUN) in txt(), 'Undo puts it back to green')

    i = row_of('SAQ')
    swipe('#latest .tx-swipe .tx', i, 100)
    names = pg.eval_on_selector_all('#latest .tx-swipe .tx', "els => els.map(e => [e.querySelector('.cat-name').textContent, e.className])")
    ok('k-need' in kind('SAQ') and money(NEED + 28.80) in txt(), 'swiping an orange row flips it to green (necessary)')
    i = row_of('Studio Zen')
    swipe('#latest .tx-swipe .tx', i, 100)
    names = pg.eval_on_selector_all('#latest .tx-swipe .tx', "els => els.map(e => [e.querySelector('.cat-name').textContent, e.className])")
    ok('k-fun' in kind('Studio Zen'), 'a grey row flips to orange')
    n_before = pg.evaluate("document.querySelectorAll('#latest .tx-swipe .tx.k-fun').length")
    swipe('#latest .tx-swipe .tx', row_of('Metro'), 40)
    ok(pg.evaluate("document.querySelectorAll('#latest .tx-swipe .tx.k-fun').length") == n_before, 'a short drag does nothing')
    swipe('#latest .tx-swipe .tx', row_of('Metro'), -70)
    ok(pg.locator('#latest .tx-swipe').nth(row_of('Metro')).locator('.tx-del').is_visible(), 'swiping left still reveals Delete')
    pg.mouse.click(10, 10)

    # ---- it is saved ----
    pg.reload(); pg.wait_for_timeout(3500)
    names = pg.eval_on_selector_all('#latest .tx-swipe .tx', "els => els.map(e => [e.querySelector('.cat-name').textContent, e.className])")
    ok('k-need' in kind('SAQ') and 'k-fun' in kind('Studio Zen'), 'the marks are still there after reloading the app')

    # ---- Fresh and Arcade do not change ----
    for cls in ('candy', 'retro'):
        pg.evaluate("c => { document.documentElement.classList.add(c); window.dash.render(); }", cls)
        pg.wait_for_timeout(700)
        ok(not vis('#leaks'), '%s look: no Where money leaks card' % cls)
        ok(pg.locator('#latest .tx-flip').count() == 0, '%s look: no swipe-to-flip action on the rows' % cls)
        pg.evaluate("c => { document.documentElement.classList.remove(c); window.dash.render(); }", cls)
        pg.wait_for_timeout(500)
    ok(not errs, 'no page errors' + ('' if not errs else ': ' + '; '.join(errs[:3])))
    b.close()
print('\nALL PASSED: %d' % len(res) if all(res) else '\nFAILED: %d of %d' % (len(res) - sum(res), len(res)))
raise SystemExit(0 if all(res) else 1)
