# Browser test of learning from your marks, against test/dev.js. Run: python3 test/learn_e2e.py
import json, datetime, urllib.request as u
from playwright.sync_api import sync_playwright
BASE = 'http://127.0.0.1:8790'
H = {'Authorization': 'Bearer dev-admin', 'Content-Type': 'application/json'}
post = lambda path, body: json.loads(u.urlopen(u.Request(BASE + path, data=json.dumps(body).encode(), headers=H, method='POST')).read())
now = datetime.datetime.now(datetime.timezone.utc)
issues = []
# four payments at a store the app does not know, each with its own amount and time
for n, (days, mins, a) in enumerate([(1, 0, 12.0), (1, 130, 13.5), (2, 0, 14.25), (2, 200, 15.75)]):
    t = (now - datetime.timedelta(days=days, minutes=mins)).replace(second=0).strftime('%Y-%m-%dT%H:%M:%SZ')
    issues.append({"title": f"Spending - ${a}", "body": f"Date: {t}\nMerchant: Zzyzx Unknown\nAmount: ${a}\nCard: Visa\nCategory: Other", "state": "open", "created_at": t})
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
    em = 'learn-e2e@example.com'
    pg.goto(BASE + '/?invite=' + post('/api/admin/invites', {})['code']); pg.wait_for_timeout(500)
    pg.fill('#auth-email', em); pg.fill('#auth-password', 'learn-e2e-password-1'); pg.click('#auth-submit'); pg.wait_for_timeout(1000)
    post('/api/admin/import', {"email": em, "issues": issues, "dailyLimit": 0})
    pg.click('#tour-skip'); pg.wait_for_timeout(900); pg.click('#onboard-done'); pg.wait_for_timeout(3500)
    rows = lambda: pg.locator('#latest .tx-swipe .tx', has_text='Zzyzx Unknown')
    cls = lambda i: rows().nth(i).get_attribute('class')

    def flip(i):
        rows().nth(i).scroll_into_view_if_needed(); pg.wait_for_timeout(200)
        r = rows().nth(i).bounding_box()
        x0, y = r['x'] + r['width'] / 2 - 50, r['y'] + r['height'] / 2
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x0, 'y': y}]})
        for k in range(1, 11):
            cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x0 + 100 * k / 10, 'y': y}]}); pg.wait_for_timeout(18)
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []}); pg.wait_for_timeout(1800)

    ok(rows().count() == 4 and all('learned' not in cls(i) and 'k-unk' in cls(i) for i in range(4)), 'at first the unknown store is grey (not sure) and nothing is learned')
    pg.click('#settings-open'); pg.wait_for_timeout(400)
    ok(not vis('#learn-note'), 'and Settings has no learning note yet')
    pg.click('#settings-close'); pg.wait_for_timeout(300)

    # mark one: not a habit yet
    flip(0)
    ok('k-fun' in cls(0) and 'learned' not in cls(0), 'one swipe marks it unnecessary (a solid orange edge, your own mark)')
    ok(all('learned' not in cls(i) for i in (1, 2, 3)), 'one mark is not a habit: the others stay grey')
    # mark a second one the same way: now it is a habit
    flip(1)
    ok('k-fun' in cls(1) and 'learned' not in cls(1), 'the second mark is also solid')
    ok(all('k-fun' in cls(i) and 'learned' in cls(i) for i in (2, 3)), 'the other two payments there now start as unnecessary by themselves, dashed: ' + str([cls(2), cls(3)]))
    ok(all('learned' in rows().nth(i).inner_text() for i in (2, 3)), 'and say "learned" in their line')
    dashed = pg.evaluate("() => getComputedStyle(document.querySelectorAll('#latest .tx-swipe .tx.learned')[0], '::before').backgroundImage")
    ok('repeating-linear-gradient' in dashed, 'the edge of a learned colour is dashed, yours are solid')
    pg.click('#settings-open'); pg.wait_for_timeout(500)
    ok(vis('#learn-note') and '1 store' in pg.inner_text('#learn-count') and '2 marks' in pg.inner_text('#learn-count'), 'Settings says what it learned: ' + pg.inner_text('#learn-count'))
    pg.click('#settings-close'); pg.wait_for_timeout(300)

    # your own mark always wins, and a mixed record is let go
    flip(2)   # a learned unnecessary one: you say necessary
    ok('k-need' in cls(2) and 'learned' not in cls(2), 'a mark you make on a learned one wins (solid green)')
    ok('learned' not in cls(3), 'and with two unnecessary and one necessary there is no clear habit, so the last one goes back to grey: ' + cls(3))
    flip(2)   # back to unnecessary: the habit returns
    ok('learned' in cls(3) and 'k-fun' in cls(3), 'marking it unnecessary again brings the habit back')

    # forget
    pg.click('#settings-open'); pg.wait_for_timeout(500)
    pg.click('#learn-forget'); pg.wait_for_timeout(200)
    ok('Tap again' in pg.inner_text('#learn-forget'), 'Forget asks twice')
    pg.click('#learn-forget'); pg.wait_for_timeout(2500)
    pg.click('#settings-close'); pg.wait_for_timeout(500)
    ok('learned' not in cls(3) and 'k-unk' in cls(3), 'after forgetting, that payment is grey again')
    ok(all('k-fun' in cls(i) for i in (0, 1, 2)), 'and your own marks are still there')

    # looks
    flip(3); flip(3)
    for look in ('candy', 'retro'):
        pg.evaluate("l => { document.documentElement.classList.add(l); window.dash.render(); }", look); pg.wait_for_timeout(600)
        ok(pg.evaluate("document.querySelectorAll('#latest .tx.learned').length") >= 0 and pg.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), '%s look: nothing sticks out sideways' % look)
        pg.evaluate("l => { document.documentElement.classList.remove(l); window.dash.render(); }", look); pg.wait_for_timeout(300)
    ok(not errs, 'no page errors' + ('' if not errs else ': ' + '; '.join(errs[:3])))
    b.close()
print('\nALL PASSED: %d' % len(res) if all(res) else '\nFAILED: %d of %d' % (len(res) - sum(res), len(res)))
raise SystemExit(0 if all(res) else 1)
