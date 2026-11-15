# Browser test of a bill sent from the Apple Shortcut (plain text) and checked in the app, with the AI reader OFF.
# Run: python3 test/billshortcut_e2e.py
import json, datetime, urllib.request as u, urllib.error
from playwright.sync_api import sync_playwright
BASE = 'http://127.0.0.1:8790'
H = {'Authorization': 'Bearer dev-admin', 'Content-Type': 'application/json'}
post = lambda path, body, auth=None: json.loads(u.urlopen(u.Request(BASE + path, data=json.dumps(body).encode(), headers={**H, **({'Authorization': 'Bearer ' + auth} if auth else {})}, method='POST')).read())
now = datetime.datetime.now(datetime.timezone.utc)
ROWS = [(10, 'Metro', 63.58), (40, 'Tim Hortons', 4.5)]
issues = []
for mins, m, a in ROWS:
    t = (now - datetime.timedelta(minutes=mins)).strftime('%Y-%m-%dT%H:%M:%SZ')
    issues.append({"title": f"Spending - ${a}", "body": f"Date: {t}\nMerchant: {m}\nAmount: ${a}\nCard: Visa\nCategory: Groceries", "state": "open", "created_at": t})
TEXT = """METRO PLUS #204
MONTREAL QC
2026-11-15 18:12
LAIT 2% 2L                5,49 FC
OEUFS GR A 12             4,29 FC
PAIN TRANCHE              3,19 FC
POULET ENTIER
   2,134 kg @ 5,81/kg      12,40 FC
CHIPS LAYS BBQ 235G       4,99 FCT
COCA-COLA 12X355ML        7,99 FCT
BIERE MOLSON 12X355ML    21,99 FCT
RABAIS                    -1,00
SOUS-TOTAL               58,34
TPS 5% (R123456789)       1,75
TVQ 9,975% (1234567890)   3,49
TOTAL                    63,58
VISA ****4242            63,58"""
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
    # the AI reader is OFF for this whole test: only the Shortcut route exists
    pg.route('**/api/config*', lambda route: route.fulfill(status=200, content_type='application/json', body=json.dumps({'vapidPublicKey': '', 'billScan': False})))
    vis = lambda s: pg.locator(s).is_visible()
    em = 'billsc-e2e@example.com'
    pg.goto(BASE + '/?invite=' + post('/api/admin/invites', {})['code']); pg.wait_for_timeout(500)
    pg.fill('#auth-email', em); pg.fill('#auth-password', 'billsc-e2e-password'); pg.click('#auth-submit'); pg.wait_for_timeout(1000)
    post('/api/admin/import', {"email": em, "issues": issues, "dailyLimit": 0})
    pg.click('#tour-skip'); pg.wait_for_timeout(1200)
    code = pg.inner_text('#setup-code')
    code2 = code
    pg.click('#onboard-done'); pg.wait_for_timeout(3500)
    row = lambda name: pg.locator('#latest .tx-swipe .tx', has_text=name).first

    def open_row(name):
        row(name).scroll_into_view_if_needed(); row(name).click(); pg.wait_for_timeout(700)

    # ---- no AI and no bill: nothing to scan ----
    open_row('Tim Hortons')
    ok(vis('#add-sheet') and vis('#add-scan'), 'with no AI reader the scan button is still there, because the Shortcut can read the bill')
    pg.click('#add-scan'); pg.wait_for_timeout(900)
    link = pg.locator('#bill-sheet a.primary')
    ok(vis('#bill-sheet') and link.count() == 1 and 'Scan with Shortcut' in link.inner_text(), 'it offers Scan with Shortcut, and no Take a photo button')
    href = link.get_attribute('href')
    import re
    mm = re.match(r'^shortcuts://run-shortcut\?name=Capture%20bill&input=text&text=(\d+)$', href or '')
    ok(bool(mm), 'the button opens the Capture bill Shortcut and passes the purchase number: ' + str(href))
    tim = mm.group(1) if mm else '0'
    pg.click('#bill-sheet .link'); pg.wait_for_timeout(300)
    # the Shortcut sends the text back with that number: it goes to Tim Hortons even though the totals differ
    out = post('/api/bills/text', {'text': TEXT, 'purchaseId': tim}, auth=code2)
    ok(out['ok'] and out['merchant'] == 'Tim Hortons', 'the bill lands on the purchase the button was for: ' + out['message'])
    ok('does not match' in out['message'], 'and the message says the total does not match, so check it')

    # ---- the Shortcut sends the text of the bill ----
    out = post('/api/bills/text', {'text': TEXT}, auth=code)
    ok(out['ok'] and out['merchant'] == 'Metro' and 'Open the app' in out['message'], 'the Shortcut gets a message to show: ' + out['message'])
    try:
        post('/api/bills/text', {'text': TEXT}, auth='sp_wrongwrongwrongwrongwrongwrong')
        ok(False, 'a wrong setup code is refused')
    except urllib.error.HTTPError as e:
        ok(e.code == 401, 'a wrong setup code is refused')
    pg.evaluate('window.dash.reload()'); pg.wait_for_timeout(2500)
    ok('bill to review' in row('Metro').inner_text(), 'the purchase now says "bill to review"')
    open_row('Metro')
    ok(vis('#add-scan') and 'Review the scanned bill' in pg.inner_text('#add-scan'), 'its edit sheet offers Review the scanned bill, even with the AI reader off')
    pg.click('#add-scan'); pg.wait_for_timeout(1500)
    ok(vis('#bill-sheet') and pg.locator('.bill-item').count() == 8, 'the review screen shows the 8 items from the Shortcut: %d' % pg.locator('.bill-item').count())
    ok('From your iPhone' in pg.inner_text('#bill-sheet'), 'and says where they came from')
    ok('add up to this purchase' in pg.inner_text('#bill-sheet'), 'the items and tax add up to the purchase')
    cls = lambda name: pg.locator('.bill-item', has_text=name).first.get_attribute('class')
    ok('k-fun' in cls('BIERE') and 'k-fun' in cls('CHIPS') and 'k-need' in cls('LAIT'), 'beer and chips start orange, milk green')
    ok(not pg.get_by_text('Scan again').count(), 'there is no Scan again button, because there is no AI reader')
    pg.locator('.bill-item', has_text='CHIPS').click(); pg.wait_for_timeout(200)
    ok('k-need' in cls('CHIPS'), 'tapping flips an item')
    pg.click('#bill-sheet .bill-actions .primary'); pg.wait_for_timeout(1800)
    ok(not vis('#bill-sheet') and 'Saved 8 items' in pg.inner_text('#toast-text'), 'saving closes it and says so: ' + pg.inner_text('#toast-text'))
    ok('8 items' in row('Metro').inner_text() and 'bill to review' not in row('Metro').inner_text(), 'the purchase now says 8 items, and no longer says a bill is waiting')
    open_row('Metro')
    ok(vis('#add-scan') and 'Open the scanned bill' in pg.inner_text('#add-scan'), 'it can be opened again later')
    pg.click('#add-scan'); pg.wait_for_timeout(1200)
    ok(pg.locator('.bill-item').count() == 8 and 'scanned before' in pg.inner_text('#bill-sheet') and 'k-need' in cls('CHIPS'), 'the saved items, with the choice you made, are there')
    pg.click('#bill-sheet .link'); pg.wait_for_timeout(300)

    # ---- Fresh and Arcade ----
    post('/api/bills/text', {'text': TEXT.replace('63,58', '63,58')}, auth=code)
    for c2 in ('candy', 'retro'):
        pg.evaluate("c => { document.documentElement.classList.add(c); window.dash.render(); }", c2)
        pg.wait_for_timeout(600)
        pg.evaluate('window.dash.reload()'); pg.wait_for_timeout(1800)
        t = pg.inner_text('#latest')
        ok('bill to review' not in t and '8 items' not in t, '%s look: no bill labels on the purchases' % c2)
        pg.evaluate("c => { document.documentElement.classList.remove(c); window.dash.render(); }", c2)
        pg.wait_for_timeout(400)
    ok(not errs, 'no page errors' + ('' if not errs else ': ' + '; '.join(errs[:3])))
    b.close()
print('\nALL PASSED: %d' % len(res) if all(res) else '\nFAILED: %d of %d' % (len(res) - sum(res), len(res)))
raise SystemExit(0 if all(res) else 1)
