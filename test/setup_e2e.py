# Browser test of the step-by-step "Connect your iPhone" guide against test/dev.js. Run: python3 test/setup_e2e.py
import json, urllib.request as u
from playwright.sync_api import sync_playwright
BASE = 'http://127.0.0.1:8790'
H = {'Authorization': 'Bearer dev-admin', 'Content-Type': 'application/json'}
post = lambda path, body, auth=None: json.loads(u.urlopen(u.Request(BASE + path, data=json.dumps(body).encode(), headers={**H, **({'Authorization': 'Bearer ' + auth} if auth else {})}, method='POST')).read())
TITLES = ['Copy your setup code', 'Add the tap-to-pay Shortcut', 'Paste your code', 'Add the online-payment Shortcut',
          'Paste your code here too', 'Open its settings', 'Turn Automation on', 'Make a small purchase', 'You’re all set']
res, errs = [], []


def ok(c, l):
    res.append(bool(c))
    print(('  ok ' if c else '  FAIL ') + l)


with sync_playwright() as P:
    b = P.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, has_touch=True, is_mobile=True)
    ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=BASE)
    ctx.add_init_script("try{localStorage.setItem('spend.alertsAsk',String(Date.now()))}catch(e){}")
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('response', lambda r: errs.append('404 ' + r.url) if r.status == 404 else None)
    cdp = ctx.new_cdp_session(pg)
    vis = lambda s: pg.locator(s).is_visible()
    h1 = lambda: pg.locator('.wiz-step:not([hidden]) h1').inner_text()
    cnt = lambda: pg.inner_text('#wiz-count')

    def swipe(x0, x1, y=400):
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x0, 'y': y}]})
        for i in range(1, 9):
            cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x0 + (x1 - x0) * i / 8, 'y': y}]})
            pg.wait_for_timeout(16)
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        pg.wait_for_timeout(400)

    pg.goto(BASE + '/?invite=' + post('/api/admin/invites', {})['code'])
    pg.wait_for_timeout(500)
    pg.fill('#auth-email', 'setup-guide@example.com')
    pg.fill('#auth-password', 'setup-guide-pw-123')
    pg.click('#auth-submit')
    pg.wait_for_timeout(1000)
    pg.click('#tour-skip')
    pg.wait_for_timeout(900)

    # ---- step 1 ----
    ok(vis('#onboard') and vis('#wiz'), 'the setup guide opens after the tour')
    ok(cnt() == 'Step 1 of 8' and h1() == TITLES[0], 'it starts at step 1 of 8: ' + cnt())
    ok(not vis('#wiz-back'), 'there is no Back on the first step')
    ok(pg.locator('#wiz-bars i').count() == 9 and pg.locator('#wiz-bars i.on').count() == 1, 'the progress bar has one bar per screen, the first one filled')
    code = pg.inner_text('#setup-code')
    ok(code.startswith('sp_') and not pg.locator('#copy-code').is_disabled(), 'the real setup code is shown and Copy is ready')
    pg.click('#copy-code'); pg.wait_for_timeout(200)
    ok(pg.evaluate('navigator.clipboard.readText()') == code, 'Copy puts the code on the clipboard')
    ok(pg.inner_text('#onboard-done') == 'Skip for now' and 'btn-plain' in pg.get_attribute('#onboard-done', 'class'), 'a quiet "Skip for now" is always available before the end')
    ok(vis('#wiz-next') and 'Next' in pg.inner_text('#wiz-next'), 'there is a Next arrow')

    # ---- walk every step with Next and check each one ----
    seen = [h1()]
    for n in range(1, 9):
        pg.click('#wiz-next'); pg.wait_for_timeout(120)
        seen.append(h1())
        if n < 8:
            ok(cnt() == 'Step %d of 8' % (n + 1), 'Next moves to ' + cnt())
        if n == 1:
            ok(vis('#tap-link') and '500cbb0903604c33a92973012fe0b1ed' in pg.get_attribute('#tap-link', 'href') and pg.get_attribute('#tap-link', 'target') == '_blank', 'step 2 has the tap-to-pay Shortcut link')
            ok(not vis('#tap-missing'), 'and no "ask for the link" message when the link exists')
            ok(pg.get_attribute('#tap-add', 'href') == pg.get_attribute('#tap-link', 'href') and pg.get_attribute('#tap-add', 'target') == '_blank', 'tapping the picture of Add Shortcut opens the same Shortcut')
            ok(vis('#wiz-back'), 'Back appears from step 2')
        if n == 3:
            ok(vis('#notif-link') and 'b7315a1815c944479b2022f220bb2e3d' in pg.get_attribute('#notif-link', 'href'), 'step 4 has the online-payment Shortcut link')
            ok(pg.get_attribute('#notif-add', 'href') == pg.get_attribute('#notif-link', 'href') and pg.get_attribute('#notif-add', 'target') == '_blank', 'and its Add Shortcut picture opens it too')
        if n in (4, 5, 6):
            img = pg.locator('.wiz-step:not([hidden]) img').first
            ok(img.evaluate('i => i.complete && i.naturalWidth === 690') and len(img.get_attribute('alt')) > 20, 'step %d shows its real screenshot, loaded, with a description' % (n + 1))
            tag = pg.locator('.wiz-step:not([hidden]) .wiz-tag').inner_text().lower()
            ok('log notification purchase' in tag, 'and it says which Shortcut the picture is from')
            ok(vis('.wiz-step:not([hidden]) .wiz-touch') and vis('.wiz-step:not([hidden]) .wiz-hl'), 'and a pointer and a highlight show what to tap')
        if n == 6:
            ok('green' in pg.inner_text('.wiz-step:not([hidden]) .wiz-sub') and 'Log tap purchase' in pg.inner_text('.wiz-step:not([hidden])'), 'step 7 says to turn Automation on, and to do the same in the tap Shortcut')
    pg.evaluate('window.spendWizard.go(4)'); pg.wait_for_timeout(200)
    full = pg.locator('.wiz-step:not([hidden]) .wiz-img-a')
    ok(full.evaluate('i => i.naturalHeight > 1000') and 'whole' in pg.locator('.wiz-step:not([hidden]) .wiz-tag').inner_text().lower(), 'step 5 shows the whole Shortcut, not just the Text box')
    ok(pg.locator('.wiz-step:not([hidden]) .wiz-img-b').evaluate('i => i.complete && i.naturalHeight > 1000') and 'example' in pg.inner_text('.wiz-step:not([hidden]) .wiz-eg'), 'with an example pasted code that fades in, and a note that it is only an example')
    pg.evaluate('window.spendWizard.go(8)'); pg.wait_for_timeout(200)
    ok(seen == TITLES, 'the nine screens come in the right order: ' + ' > '.join(seen))
    ok(cnt() == 'All done' and not vis('#wiz-next'), 'the last screen says all done and has no Next')
    ok(pg.inner_text('#onboard-done') == 'Show my spending' and 'primary' in pg.get_attribute('#onboard-done', 'class'), 'there the way out becomes the main button')
    ok(pg.locator('#wiz-bars i.on').count() == 9, 'every bar is filled at the end')
    ok(vis('#step-home'), 'the Home Screen tip shows in the browser')

    # ---- Back, arrow keys, swipe ----
    pg.click('#wiz-back'); pg.wait_for_timeout(120)
    ok(h1() == TITLES[7], 'Back goes to the previous step')
    ok('Finish' in pg.inner_text('#wiz-next'), 'step 8 offers Finish instead of Next')
    pg.keyboard.press('ArrowLeft'); pg.wait_for_timeout(120)
    ok(h1() == TITLES[6], 'the left arrow key goes back')
    pg.keyboard.press('ArrowRight'); pg.wait_for_timeout(120)
    ok(h1() == TITLES[7], 'the right arrow key goes forward')
    swipe(320, 60); ok(h1() == TITLES[8], 'swiping left goes forward')
    swipe(60, 320); ok(h1() == TITLES[7], 'swiping right goes back')
    swipe(200, 215); ok(h1() == TITLES[7], 'a tiny drag does nothing')
    pg.evaluate('window.scrollTo(0,0)')

    # ---- the first purchase is noticed ----
    ok('Waiting for your first purchase' in pg.inner_text('#first-status'), 'step 8 waits for the first purchase')
    post('/api/log', {'merchant': 'Tim Hortons', 'amount': '4.50', 'card': 'Visa', 'category': 'Dining & Coffee'}, auth=code)
    pg.wait_for_timeout(6500)
    ok('It works' in pg.inner_text('#first-status') and 'Tim Hortons' in pg.inner_text('#first-status'), 'it notices the purchase and says it works: ' + pg.inner_text('#first-status'))

    # ---- fits the screen, in every look ----
    fits = lambda: pg.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1')
    ok(fits(), 'nothing runs off the side of the screen (Clean)')
    for cls in ('candy', 'retro'):
        pg.evaluate("c => { document.documentElement.classList.add(c) }", cls)
        pg.wait_for_timeout(200)
        for n in (0, 4, 8):
            pg.evaluate('n => window.spendWizard.go(n)', n)
            pg.wait_for_timeout(120)
            ok(fits() and (vis('#wiz-next') or n == 8) and vis('.wiz-step:not([hidden]) h1'), '%s look: step %d fits and works' % (cls, n + 1))
        pg.evaluate("c => { document.documentElement.classList.remove(c) }", cls)

    # ---- skip, finish and coming back ----
    pg.evaluate('window.spendWizard.go(0)')
    pg.click('#onboard-done'); pg.wait_for_timeout(900)
    ok(vis('#app') and not vis('#onboard'), '"Skip for now" goes to the spending app')
    pg.evaluate("document.querySelector('#show-code').click()"); pg.wait_for_timeout(900)
    ok(vis('#onboard') and cnt() == 'Step 1 of 8' and h1() == TITLES[0], '"Set up the Shortcut again" in Settings starts the guide from step 1')
    pg.evaluate('window.spendWizard.go(8)')
    pg.click('#onboard-done'); pg.wait_for_timeout(900)
    ok(vis('#app'), '"Show my spending" at the end goes to the app')
    ok(pg.evaluate("localStorage.getItem('spend.onboarded')") == '1', 'and the app remembers setup was done')
    ok(not errs, 'no page errors' + ('' if not errs else ': ' + '; '.join(errs[:3])))
    b.close()
print('\nALL PASSED: %d' % len(res) if all(res) else '\nFAILED: %d of %d' % (len(res) - sum(res), len(res)))
raise SystemExit(0 if all(res) else 1)
