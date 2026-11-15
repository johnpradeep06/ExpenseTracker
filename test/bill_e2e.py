# Browser test of scanning a bill against test/dev.js (which has a pretend AI reader). Run: python3 test/bill_e2e.py
import json, datetime, urllib.request as u
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw
BASE = 'http://127.0.0.1:8790'
H = {'Authorization': 'Bearer dev-admin', 'Content-Type': 'application/json'}
post = lambda path, body: json.loads(u.urlopen(u.Request(BASE + path, data=json.dumps(body).encode(), headers=H, method='POST')).read())
now = datetime.datetime.now(datetime.timezone.utc)
ROWS = [(10, 'Metro', 90.61), (30, 'Metro', 81.93), (50, 'Tim Hortons', 4.5)]
issues = []
for mins, m, a in ROWS:
    t = (now - datetime.timedelta(minutes=mins)).strftime('%Y-%m-%dT%H:%M:%SZ')
    issues.append({"title": f"Spending - ${a}", "body": f"Date: {t}\nMerchant: {m}\nAmount: ${a}\nCard: Visa\nCategory: Groceries", "state": "open", "created_at": t})
# a plain picture of a bill, so the browser has a real JPEG to shrink and send
img = Image.new('RGB', (900, 1400), (246, 242, 231)); d = ImageDraw.Draw(img)
for i, line in enumerate(['METRO PLUS #204', 'LAIT 2% 2L 5,49', 'CHIPS LAYS BBQ 4,99', 'BIERE MOLSON 12X 21,99', 'TOTAL 90,61']): d.text((60, 80 + i * 60), line, fill=(30, 30, 30))
img.save('/tmp/claude-0/bill-photo.jpg', 'JPEG', quality=85)
open('/tmp/claude-0/not-a-photo.jpg', 'w').write('this is not an image')
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
    vis = lambda s: pg.locator(s).is_visible()
    em = 'bill-e2e@example.com'
    pg.goto(BASE + '/?invite=' + post('/api/admin/invites', {})['code']); pg.wait_for_timeout(500)
    pg.fill('#auth-email', em); pg.fill('#auth-password', 'bill-e2e-password-1'); pg.click('#auth-submit'); pg.wait_for_timeout(1000)
    post('/api/admin/import', {"email": em, "issues": issues, "dailyLimit": 0})
    pg.click('#tour-skip'); pg.wait_for_timeout(900); pg.click('#onboard-done'); pg.wait_for_timeout(3500)

    def open_row(name, nth=0):
        pg.locator('#latest .tx-swipe .tx', has_text=name).nth(nth).scroll_into_view_if_needed()
        pg.locator('#latest .tx-swipe .tx', has_text=name).nth(nth).click()
        pg.wait_for_timeout(600)

    leaks = lambda: pg.inner_text('#leaks')
    before_fun = float(pg.inner_text('#leaks .lk-amt').replace('$', '').replace(',', ''))
    ok(before_fun == 4.5, 'before any bill, only the coffee counts as unnecessary and the two grocery trips count as necessary: %s' % money(before_fun))

    # ---- the button ----
    open_row('Metro', 0)
    ok(vis('#add-sheet') and vis('#add-scan'), 'in the edit sheet there is a Scan the bill button (Clean look, reader switched on)')
    pg.click('#add-scan'); pg.wait_for_timeout(700)
    ok(vis('#bill-sheet') and 'Take a photo' in pg.inner_text('#bill-sheet'), 'it opens the scanner')

    # ---- a photo that is not a photo ----
    with pg.expect_file_chooser() as fc:
        pg.click('#bill-sheet .primary')
    fc.value.set_files('/tmp/claude-0/not-a-photo.jpg'); pg.wait_for_timeout(1500)
    ok('could not be used' in pg.inner_text('#bill-sheet') and vis('#bill-sheet .primary'), 'a file that is not a photo gives a plain message and Try again')
    pg.click('#bill-sheet .primary'); pg.wait_for_timeout(300)

    # ---- a real photo ----
    with pg.expect_file_chooser() as fc:
        pg.click('#bill-sheet .primary')
    fc.value.set_files('/tmp/claude-0/bill-photo.jpg'); pg.wait_for_timeout(2500)
    ok(pg.locator('.bill-item').count() == 12, 'the 12 items on the bill are listed, without the subtotal, tax and card lines: %d' % pg.locator('.bill-item').count())
    ok('Reading your bill' not in pg.inner_text('#bill-sheet') and 'This takes a few seconds' not in pg.inner_text('#bill-sheet'), 'the reading message is gone once the items are shown')
    ok('add up to this purchase' in pg.inner_text('#bill-sheet'), 'it checks the items and tax against the purchase and says they add up')
    cls = lambda name: pg.locator('.bill-item', has_text=name).first.get_attribute('class')
    ok('k-fun' in cls('BIERE') and 'k-need' in cls('LAIT') and 'k-unk' in cls('CREME'), 'beer starts orange, milk green, and ice cream (the reader was unsure) grey')
    leg0 = pg.inner_text('.bill-leg')
    pg.locator('.bill-item', has_text='COCA').click(); pg.wait_for_timeout(200)
    ok('k-need' in cls('COCA') and pg.inner_text('.bill-leg') != leg0, 'tapping an item flips it, and the totals change')
    pg.locator('.bill-item', has_text='COCA').click(); pg.wait_for_timeout(200)
    pg.locator('.bill-item', has_text='CREME').click(); pg.wait_for_timeout(200)
    ok('k-fun' in cls('CREME'), 'tapping a grey item makes it unnecessary')
    ok(pg.locator('.bill-leg .dot').count() == 2 or pg.locator('.bill-leg .dot').count() == 3, 'a legend shows necessary and unnecessary')
    pg.click('#bill-sheet .bill-actions .primary'); pg.wait_for_timeout(1800)
    ok(not vis('#bill-sheet') and 'Saved 12 items' in pg.inner_text('#toast-text'), 'saving closes the scanner and says so: ' + pg.inner_text('#toast-text'))
    ok(pg.locator('#latest .tx-swipe .tx', has_text='12 items').count() == 1, 'the purchase now says 12 items')
    ok('k-mix' in pg.locator('#latest .tx-swipe .tx', has_text='12 items').first.get_attribute('class'), 'and its edge shows part green, part orange')
    after_fun = float(pg.inner_text('#leaks .lk-amt').replace('$', '').replace(',', ''))
    ok(after_fun > before_fun + 40, 'the Where money leaks card now counts the beer, chips, soda and ice cream: %s -> %s' % (money(before_fun), money(after_fun)))

    # ---- scanned before ----
    open_row('12 items')
    pg.click('#add-scan'); pg.wait_for_timeout(1500)
    ok(pg.locator('.bill-top').count() == 1 and pg.locator('.bill-msg').count() == 1, 'and nothing is shown twice')
    ok(pg.locator('.bill-item').count() == 12 and 'scanned before' in pg.inner_text('#bill-sheet'), 'opening it again shows the saved items')
    pg.locator('.bill-item', has_text='SAVON').locator('.bill-x').click(); pg.wait_for_timeout(200)
    ok(pg.locator('.bill-item').count() == 11, 'an item can be removed')
    pg.click('#bill-sheet .bill-actions .primary'); pg.wait_for_timeout(1800)
    ok(pg.locator('#latest .tx-swipe .tx', has_text='11 items').count() == 1, 'and the change is saved (11 items)')

    # ---- a bill that does not match ----
    open_row('Metro', 1)
    pg.click('#add-scan'); pg.wait_for_timeout(700)
    with pg.expect_file_chooser() as fc:
        pg.click('#bill-sheet .primary')
    fc.value.set_files('/tmp/claude-0/bill-photo.jpg'); pg.wait_for_timeout(2500)
    ok('A line may be missing' in pg.inner_text('#bill-sheet'), 'a bill that does not add up to the purchase warns the person before saving')
    pg.click('#bill-sheet .closeBtn, #bill-sheet .link'); pg.wait_for_timeout(300)
    ok(not vis('#bill-sheet'), 'Close leaves without saving')

    # ---- Fresh and Arcade ----
    for cls_ in ('candy', 'retro'):
        pg.evaluate("c => { document.documentElement.classList.add(c); window.dash.render(); }", cls_)
        pg.wait_for_timeout(600)
        pg.locator('#latest .tx-swipe .tx').first.scroll_into_view_if_needed()
        pg.locator('#latest .tx-swipe .tx').first.click(); pg.wait_for_timeout(800)
        ok(vis('#add-sheet') and not vis('#add-scan'), '%s look: no Scan the bill button' % cls_)
        pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
        pg.evaluate("c => { document.documentElement.classList.remove(c); window.dash.render(); }", cls_)
        pg.wait_for_timeout(400)
    ok(not errs, 'no page errors' + ('' if not errs else ': ' + '; '.join(errs[:3])))
    b.close()
print('\nALL PASSED: %d' % len(res) if all(res) else '\nFAILED: %d of %d' % (len(res) - sum(res), len(res)))
raise SystemExit(0 if all(res) else 1)
