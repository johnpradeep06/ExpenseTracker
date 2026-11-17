# Browser test: pick a category once and the store is remembered. Run against test/dev.js: python3 test/remember_e2e.py
import json, datetime, urllib.request as u
from playwright.sync_api import sync_playwright
BASE = 'http://127.0.0.1:8790'
H = {'Authorization': 'Bearer dev-admin', 'Content-Type': 'application/json'}
post = lambda path, body: json.loads(u.urlopen(u.Request(BASE + path, data=json.dumps(body).encode(), headers=H, method='POST')).read())
now = datetime.datetime.now(datetime.timezone.utc)
def issue(days, mins, merchant, amount):
    t = (now - datetime.timedelta(days=days, minutes=mins)).replace(second=0).strftime('%Y-%m-%dT%H:%M:%SZ')
    return {"title": f"Spending - ${amount}", "body": f"Date: {t}\nMerchant: {merchant}\nAmount: ${amount}\nCard: Visa\nCategory: Other", "state": "open", "created_at": t}
res, errs = [], []


def ok(c, l):
    res.append(bool(c))
    print(('  ok ' if c else '  FAIL ') + l)


with sync_playwright() as P:
    b = P.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 390, 'height': 1000}, device_scale_factor=2, has_touch=True, is_mobile=True)
    ctx.add_init_script("try{localStorage.setItem('spend.alertsAsk',String(Date.now()))}catch(e){}")
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errs.append(str(e)))
    vis = lambda s: pg.locator(s).is_visible()
    em = 'remember-e2e@example.com'
    pg.goto(BASE + '/?invite=' + post('/api/admin/invites', {})['code']); pg.wait_for_timeout(500)
    pg.fill('#auth-email', em); pg.fill('#auth-password', 'remember-e2e-pw-1'); pg.click('#auth-submit'); pg.wait_for_timeout(1000)
    post('/api/admin/import', {"email": em, "issues": [issue(1, 0, 'Station Axia', 21.5), issue(2, 0, 'Station Axia', 18.25), issue(3, 0, 'Zzyzx Unknown', 9.0)], "dailyLimit": 0})
    pg.click('#tour-skip'); pg.wait_for_timeout(900); pg.click('#onboard-done'); pg.wait_for_timeout(3500)
    rows = lambda name: pg.locator('#latest .tx-swipe .tx', has_text=name)
    txt = lambda name, i=0: rows(name).nth(i).inner_text().replace('\n', ' | ')

    ok(rows('Station Axia').count() == 2 and all('Other' in txt('Station Axia', i) for i in (0, 1)), 'at first both Station Axia payments are Other: ' + txt('Station Axia'))
    rows('Station Axia').nth(0).scroll_into_view_if_needed(); rows('Station Axia').nth(0).click(); pg.wait_for_timeout(700)
    pg.select_option('#add-category', 'Dining & Coffee')
    pg.click('#add-save'); pg.wait_for_timeout(2800)
    ok('will go to Dining & Coffee from now on' in pg.inner_text('#toast-text'), 'saving says the store is remembered: ' + pg.inner_text('#toast-text'))
    ok('Dining' in txt('Station Axia', 0) and 'Dining' in txt('Station Axia', 1), 'both payments are now Dining & Coffee, the other one too: ' + txt('Station Axia', 1))
    ok('remembered' in (txt('Station Axia', 0) + txt('Station Axia', 1)), 'the one that was not edited says "remembered"')
    ok('Other' in txt('Zzyzx Unknown'), 'another store is untouched')

    # a new payment at the same store sorts itself
    post('/api/admin/import', {"email": em, "issues": [issue(0, 30, 'Station Axia', 33.1)], "dailyLimit": 0})
    pg.evaluate('window.dash.reload()'); pg.wait_for_timeout(2500)
    ok(rows('Station Axia').count() == 3 and all('Dining' in txt('Station Axia', i) for i in range(3)), 'a new Station Axia payment goes to Dining & Coffee by itself')

    # the list of remembered stores
    pg.click('#settings-open'); pg.wait_for_timeout(400); pg.click('#cats-open'); pg.wait_for_timeout(600)
    ok('stores it remembers' in pg.inner_text('#cat-list').lower() and 'Station Axia' in pg.inner_text('#cat-list') and 'Dining & Coffee' in pg.inner_text('#cat-list'), 'My categories lists it: ' + pg.inner_text('#cat-list').replace('\n', ' | ')[-120:])
    pg.click('#cat-list .cat-forget'); pg.wait_for_timeout(2500)
    ok('stores it remembers' not in pg.inner_text('#cat-list').lower(), 'Forget removes it from the list')
    pg.click('#cat-list .link'); pg.wait_for_timeout(300); pg.click('#settings-close'); pg.wait_for_timeout(600)
    texts = [txt('Station Axia', i) for i in range(3)]
    ok(sum('Other' in t for t in texts) == 2 and sum('Dining' in t for t in texts) == 1, 'after forgetting, only the payment picked by hand keeps Dining & Coffee: ' + str([t[:40] for t in texts]))
    ok(not errs, 'no page errors' + ('' if not errs else ': ' + '; '.join(errs[:3])))
    b.close()
print('\nALL PASSED: %d' % len(res) if all(res) else '\nFAILED: %d of %d' % (len(res) - sum(res), len(res)))
raise SystemExit(0 if all(res) else 1)
