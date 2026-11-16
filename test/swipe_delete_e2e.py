# Browser test: swiping a purchase to the left (or tapping its red Delete) asks first. Run against test/dev.js: python3 test/swipe_delete_e2e.py
import json, datetime, urllib.request as u
from playwright.sync_api import sync_playwright
BASE = 'http://127.0.0.1:8790'
H = {'Authorization': 'Bearer dev-admin', 'Content-Type': 'application/json'}
post = lambda path, body: json.loads(u.urlopen(u.Request(BASE + path, data=json.dumps(body).encode(), headers=H, method='POST')).read())
now = datetime.datetime.now(datetime.timezone.utc)
ROWS = [(10, 'Metro', 81.93), (40, 'Studio Zen', 65.00), (70, 'SAQ', 28.80)]
issues = []
for mins, m, a in ROWS:
    t = (now - datetime.timedelta(minutes=mins)).strftime('%Y-%m-%dT%H:%M:%SZ')
    issues.append({"title": f"Spending - ${a}", "body": f"Date: {t}\nMerchant: {m}\nAmount: ${a}\nCard: Visa\nCategory: Other", "state": "open", "created_at": t})
res, errs = [], []


def ok(c, l):
    res.append(bool(c))
    print(('  ok ' if c else '  FAIL ') + l)


with sync_playwright() as P:
    b = P.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 390, 'height': 1100}, device_scale_factor=2, has_touch=True, is_mobile=True)
    ctx.add_init_script("try{localStorage.setItem('spend.alertsAsk',String(Date.now()))}catch(e){}")
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errs.append(str(e)))
    cdp = ctx.new_cdp_session(pg)
    vis = lambda s: pg.locator(s).is_visible()

    def swipe(name, dx):
        loc = pg.locator('#latest .tx-swipe', has_text=name).first
        loc.scroll_into_view_if_needed(); pg.wait_for_timeout(150)
        r = loc.bounding_box()
        x0, y = (r['x'] + r['width'] - 6 if dx < -300 else r['x'] + r['width'] / 2 - (dx / 2)), r['y'] + r['height'] / 2
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x0, 'y': y}]})
        for k in range(1, 11):
            cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x0 + dx * k / 10, 'y': y}]})
            pg.wait_for_timeout(18)
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        pg.wait_for_timeout(700)

    count = lambda name: pg.locator('#latest .tx-swipe', has_text=name).count()
    em = 'swipedel@example.com'
    pg.goto(BASE + '/?invite=' + post('/api/admin/invites', {})['code']); pg.wait_for_timeout(500)
    pg.fill('#auth-email', em); pg.fill('#auth-password', 'swipedel-password-1'); pg.click('#auth-submit'); pg.wait_for_timeout(1000)
    post('/api/admin/import', {"email": em, "issues": issues, "dailyLimit": 0})
    pg.click('#tour-skip'); pg.wait_for_timeout(900); pg.click('#onboard-done'); pg.wait_for_timeout(3500)

    # a quick or medium swipe only shows the red button: deleting takes a long, slow pull
    swipe('Studio Zen', -200)
    ok(not vis('.confirm-box') and pg.locator('#latest .tx-swipe', has_text='Studio Zen').first.locator('.tx-del').is_visible(), 'a medium swipe only reveals the red Delete button')
    pg.touchscreen.tap(8, 8); pg.wait_for_timeout(500)
    swipe('Studio Zen', -280)
    ok(not vis('.confirm-box'), 'even a fairly long swipe does not start a delete')
    pg.touchscreen.tap(8, 8); pg.wait_for_timeout(500)
    # a long swipe to the left asks first
    swipe('Studio Zen', -335)
    ok(vis('.confirm-box') and 'Studio Zen' in pg.inner_text('.confirm-box') and '$65.00' in pg.inner_text('.confirm-box'), 'a long swipe left asks "Delete this payment?" and names it: ' + (pg.inner_text('.confirm-box') if vis('.confirm-box') else 'no dialog').replace('\n', ' | '))
    ok(count('Studio Zen') == 1, 'and nothing is deleted while it is asking')
    pg.click('.confirm-no'); pg.wait_for_timeout(600)
    ok(not vis('.confirm-box') and count('Studio Zen') == 1, 'Keep it closes the question and the payment is still there')
    ok(not pg.locator('#toast-text').inner_text().startswith('Deleted'), 'no "Deleted" message')
    box = pg.locator('#latest .tx-swipe', has_text='Studio Zen').first.locator('.tx').bounding_box()
    other = pg.locator('#latest .tx-swipe', has_text='Metro').first.locator('.tx').bounding_box()
    ok(abs(box['x'] - other['x']) < 2, 'the row slides back into place (%.0f vs %.0f)' % (box['x'], other['x']))

    # saying yes deletes it, and Undo still works
    swipe('Studio Zen', -335)
    pg.click('.confirm-yes'); pg.wait_for_timeout(1500)
    ok(count('Studio Zen') == 0 and 'Deleted Studio Zen' in pg.inner_text('#toast-text'), 'Delete removes it and shows Undo: ' + pg.inner_text('#toast-text'))
    pg.click('#toast-undo'); pg.wait_for_timeout(2500)
    ok(count('Studio Zen') == 1, 'Undo brings it back')

    # a short swipe shows the red button; tapping it asks too
    swipe('SAQ', -100)
    ok(pg.locator('#latest .tx-swipe', has_text='SAQ').first.locator('.tx-del').is_visible(), 'a short swipe shows the red Delete button')
    pg.locator('#latest .tx-swipe', has_text='SAQ').first.locator('.tx-del').click(); pg.wait_for_timeout(500)
    ok(vis('.confirm-box') and count('SAQ') == 1, 'tapping the red Delete asks as well')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(600)
    ok(not vis('.confirm-box') and count('SAQ') == 1, 'Escape means keep it')
    swipe('SAQ', -100)
    pg.locator('#latest .tx-swipe', has_text='SAQ').first.locator('.tx-del').click(); pg.wait_for_timeout(400)
    pg.touchscreen.tap(8, 8); pg.wait_for_timeout(500)
    ok(not vis('.confirm-box') and count('SAQ') == 1, 'tapping outside the box means keep it')
    swipe('SAQ', -100)
    pg.locator('#latest .tx-swipe', has_text='SAQ').first.locator('.tx-del').click(); pg.wait_for_timeout(400)
    pg.click('.confirm-yes'); pg.wait_for_timeout(1500)
    ok(count('SAQ') == 0, 'yes from the red button deletes it')
    # the Edit payment sheet must never slide sideways, even when the phone gives the When field a wide width
    pg.locator('#latest .tx-swipe .tx').first.scroll_into_view_if_needed(); pg.locator('#latest .tx-swipe .tx').first.click(); pg.wait_for_timeout(700)
    pg.add_style_tag(content="input[type=datetime-local]{min-width:560px}")
    r = pg.evaluate("() => { const i = document.querySelector('#add-when').getBoundingClientRect(); const s = document.querySelector('#add-sheet'); return [i.right, s.getBoundingClientRect().right, s.scrollWidth, s.clientWidth]; }")
    ok(r[0] <= r[1] + 1 and r[2] <= r[3], 'the When box stays inside the Edit payment sheet, which cannot slide sideways (%d vs %d)' % (r[0], r[1]))
    pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
    ok(not errs, 'no page errors' + ('' if not errs else ': ' + '; '.join(errs[:3])))
    b.close()
print('\nALL PASSED: %d' % len(res) if all(res) else '\nFAILED: %d of %d' % (len(res) - sum(res), len(res)))
raise SystemExit(0 if all(res) else 1)
