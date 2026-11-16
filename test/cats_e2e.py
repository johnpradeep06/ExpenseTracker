# Browser test of your own categories (Rent, Phone...) against test/dev.js. Run: python3 test/cats_e2e.py
import json, datetime, urllib.request as u
from playwright.sync_api import sync_playwright
BASE = 'http://127.0.0.1:8790'
H = {'Authorization': 'Bearer dev-admin', 'Content-Type': 'application/json'}
post = lambda path, body: json.loads(u.urlopen(u.Request(BASE + path, data=json.dumps(body).encode(), headers=H, method='POST')).read())
now = datetime.datetime.now(datetime.timezone.utc)
issues = []
for n, m, a, c in [(1, 'Beau Soir', 3.99, 'Other'), (2, 'Rogers', 55.0, 'Other'), (3, 'Metro', 80.0, 'Groceries')]:
    t = (now - datetime.timedelta(days=n)).replace(hour=15, minute=0, second=0).strftime('%Y-%m-%dT%H:%M:%SZ')
    issues.append({"title": f"Spending - ${a}", "body": f"Date: {t}\nMerchant: {m}\nAmount: ${a}\nCard: Visa\nCategory: {c}", "state": "open", "created_at": t})
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
    em = 'cats-e2e@example.com'
    pg.goto(BASE + '/?invite=' + post('/api/admin/invites', {})['code']); pg.wait_for_timeout(500)
    pg.fill('#auth-email', em); pg.fill('#auth-password', 'cats-e2e-password-1'); pg.click('#auth-submit'); pg.wait_for_timeout(1000)
    post('/api/admin/import', {"email": em, "issues": issues, "dailyLimit": 0})
    pg.click('#tour-skip'); pg.wait_for_timeout(900); pg.click('#onboard-done'); pg.wait_for_timeout(3500)
    row = lambda name: pg.locator('#latest .tx-swipe .tx', has_text=name).first
    cls = lambda name: row(name).get_attribute('class')

    def open_row(name):
        row(name).scroll_into_view_if_needed(); row(name).click(); pg.wait_for_timeout(700)

    # ---- Settings > My categories ----
    pg.click('#settings-open'); pg.wait_for_timeout(500)
    ok(vis('#cats-open'), 'Settings has My categories')
    pg.click('#cats-open'); pg.wait_for_timeout(500)
    ok(vis('#cat-list') and 'Make your own' in pg.inner_text('#cat-list'), 'it starts empty and says what it is for')
    pg.click('#cat-list .btn-plain'); pg.wait_for_timeout(500)
    ok(vis('#cat-sheet') and 'New category' in pg.inner_text('#cat-sheet'), '+ New category opens the sheet, on top of the list')
    pg.click('#cat-sheet .primary'); pg.wait_for_timeout(300)
    ok('Give it a name' in pg.inner_text('#cat-sheet'), 'a blank name is refused')
    pg.fill('#cat-sheet input[type=text]', 'groceries'); pg.click('#cat-sheet .primary'); pg.wait_for_timeout(300)
    ok('already a category' in pg.inner_text('#cat-sheet'), 'a name that is already built in is refused (any capitals)')
    pg.fill('#cat-sheet input[type=text]', 'Phone')
    pg.click('#cat-sheet .cat-icons button:nth-child(2)')
    ok(pg.locator('#cat-sheet .cat-seg [aria-pressed=true]').inner_text() == 'Necessary', 'Necessary is picked to start with')
    pg.click('#cat-sheet .primary'); pg.wait_for_timeout(1500)
    ok(not vis('#cat-sheet') and 'Phone' in pg.inner_text('#cat-list') and 'Necessary' in pg.inner_text('#cat-list'), 'Create saves it and it is in the list')
    pg.click('#cat-list .link'); pg.wait_for_timeout(300)
    pg.click('#settings-close'); pg.wait_for_timeout(500)

    # ---- use it on a payment ----
    open_row('Beau Soir')
    opts = pg.eval_on_selector_all('#add-category option', 'os => os.map(o => o.textContent.trim())')
    ok(any('Phone' in o for o in opts) and '＋ New category…' in opts[-1], 'the picker on the Edit payment sheet lists Phone, with + New category at the end: ' + str(opts[-4:]))
    pg.select_option('#add-category', 'Phone'); pg.click('#add-save'); pg.wait_for_timeout(2500)
    ok('Phone' in row('Beau Soir').inner_text() and 'k-need' in cls('Beau Soir'), 'the payment shows as Phone, and green because Phone is necessary: ' + row('Beau Soir').inner_text().replace('\n', ' | '))
    ok('📱' in row('Beau Soir').inner_text() or pg.evaluate("[...document.querySelectorAll('#latest .tx-swipe .tx')].some(e => e.textContent.includes('Beau Soir') && e.textContent.includes('📱'))"), 'with the icon you chose')

    # ---- make one from the picker, and remember a store ----
    open_row('Rogers')
    pg.select_option('#add-category', '__new__'); pg.wait_for_timeout(600)
    ok(vis('#cat-sheet') and vis('#add-sheet'), 'choosing + New category opens the sheet on top of the Edit payment sheet')
    ok('Rogers' in pg.inner_text('#cat-sheet'), 'and offers to use it for Rogers every time')
    pg.fill('#cat-sheet input[type=text]', 'Phone bill')
    pg.locator('#cat-sheet .cat-always input').check()
    pg.click('#cat-sheet .cat-seg .k-fun'); pg.click('#cat-sheet .cat-seg .k-need')
    pg.click('#cat-sheet .primary'); pg.wait_for_timeout(1500)
    ok(not vis('#cat-sheet') and pg.eval_on_selector('#add-category', 'e => e.value') == 'Phone bill', 'the new category is picked on the payment')
    pg.click('#add-save'); pg.wait_for_timeout(2500)
    ok('Phone bill' in row('Rogers').inner_text(), 'Rogers is now in Phone bill')
    # the store rule: another Rogers payment goes there by itself
    post('/api/admin/import', {"email": em, "issues": [{"title": "Spending - $60", "body": "Date: %s\nMerchant: Rogers\nAmount: $60\nCard: Visa\nCategory: Other" % now.strftime('%Y-%m-%dT%H:%M:%SZ'), "state": "open", "created_at": now.strftime('%Y-%m-%dT%H:%M:%SZ')}], "dailyLimit": 0})
    pg.evaluate('window.dash.reload()'); pg.wait_for_timeout(2500)
    ok(pg.locator('#latest .tx-swipe .tx', has_text='Rogers').first.inner_text().count('Phone bill') >= 1 and pg.locator('#latest .tx-swipe .tx', has_text='$60.00').first.inner_text().count('Phone bill') >= 1, 'a new Rogers payment goes into Phone bill by itself')

    # ---- it shows in the cards, and changing the kind changes the colour ----
    ok('Phone' in pg.inner_text('#by-category'), 'the Categories card lists your categories')
    pg.click('#settings-open'); pg.wait_for_timeout(400); pg.click('#cats-open'); pg.wait_for_timeout(400)
    ok('1 store always' in pg.inner_text('#cat-list'), 'the list says one store always goes to Phone bill')
    pg.locator('#cat-list .cat-row', has_text='Phone bill').click(); pg.wait_for_timeout(400)
    ok('Change Phone bill' in pg.inner_text('#cat-sheet') and vis('#cat-sheet input[type=text]') is False, 'tapping one opens it to change (the name stays)')
    pg.click('#cat-sheet .cat-seg .k-fun'); pg.click('#cat-sheet .primary'); pg.wait_for_timeout(2500)
    ok('k-fun' in cls('Rogers'), 'making it Unnecessary turns its payments orange')
    # delete
    pg.locator('#cat-list .cat-row', has_text='Phone bill').click(); pg.wait_for_timeout(400)
    pg.click('#cat-sheet .danger-plain'); pg.wait_for_timeout(200)
    ok('Tap again' in pg.inner_text('#cat-sheet .danger-plain'), 'Delete asks twice')
    pg.click('#cat-sheet .danger-plain'); pg.wait_for_timeout(2500)
    ok('Phone bill' not in pg.inner_text('#cat-list'), 'it is gone from the list')
    pg.click('#cat-list .link'); pg.wait_for_timeout(300); pg.click('#settings-close'); pg.wait_for_timeout(500)
    ok(row('Rogers').count() == 1 and 'Phone bill' not in row('Rogers').inner_text(), 'and Rogers goes back to the app\'s usual guess; the payment is still there: ' + row('Rogers').inner_text().replace('\n', ' | '))

    # ---- Fresh and Arcade ----
    for look in ('candy', 'retro'):
        pg.evaluate("l => { document.documentElement.classList.add(l); window.dash.render(); }", look); pg.wait_for_timeout(600)
        ok('Phone' in row('Beau Soir').inner_text(), '%s look: your category shows on the payment' % look)
        pg.click('#settings-open'); pg.wait_for_timeout(400); pg.click('#cats-open'); pg.wait_for_timeout(400)
        pg.click('#cat-list .btn-plain'); pg.wait_for_timeout(400)
        ok(vis('#cat-sheet') and pg.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), '%s look: the new category sheet opens and nothing sticks out sideways' % look)
        box = pg.locator('#cat-sheet').bounding_box()
        ok(box['x'] >= 0 and box['x'] + box['width'] <= 391, '%s look: it fits the screen (%d wide)' % (look, box['width']))
        pg.keyboard.press('Escape'); pg.wait_for_timeout(300); pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
        pg.click('#settings-close'); pg.wait_for_timeout(400)
        pg.evaluate("l => { document.documentElement.classList.remove(l); window.dash.render(); }", look); pg.wait_for_timeout(400)
    ok(not errs, 'no page errors' + ('' if not errs else ': ' + '; '.join(errs[:3])))
    b.close()
print('\nALL PASSED: %d' % len(res) if all(res) else '\nFAILED: %d of %d' % (len(res) - sum(res), len(res)))
raise SystemExit(0 if all(res) else 1)
