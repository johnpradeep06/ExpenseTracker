# Browser test of the pay period card (Free to spend) in all three looks, against test/dev.js. Run: python3 test/pay_e2e.py
import json, datetime, urllib.request as u
from playwright.sync_api import sync_playwright
BASE = 'http://127.0.0.1:8790'
H = {'Authorization': 'Bearer dev-admin', 'Content-Type': 'application/json'}
post = lambda path, body: json.loads(u.urlopen(u.Request(BASE + path, data=json.dumps(body).encode(), headers=H, method='POST')).read())
now = datetime.datetime.now(datetime.timezone.utc)
day = lambda n: (now - datetime.timedelta(days=n)).strftime('%Y-%m-%d')
issues = []
for n, m, a in [(2, 'Metro', 80.00), (4, 'Tim Hortons', 12.50), (7, 'SAQ', 31.00)]:
    t = (now - datetime.timedelta(days=n)).replace(hour=15, minute=0, second=0).strftime('%Y-%m-%dT%H:%M:%SZ')
    issues.append({"title": f"Spending - ${a}", "body": f"Date: {t}\nMerchant: {m}\nAmount: ${a}\nCard: Visa\nCategory: Groceries", "state": "open", "created_at": t})
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
    vis = lambda s: pg.locator(s).is_visible()
    txt = lambda s: pg.inner_text(s)
    low = lambda s: pg.inner_text(s).lower()   # labels are drawn in capitals
    em = 'pay-e2e@example.com'
    pg.goto(BASE + '/?invite=' + post('/api/admin/invites', {})['code']); pg.wait_for_timeout(500)
    pg.fill('#auth-email', em); pg.fill('#auth-password', 'pay-e2e-password-1'); pg.click('#auth-submit'); pg.wait_for_timeout(1000)
    post('/api/admin/import', {"email": em, "issues": issues, "dailyLimit": 0})
    pg.click('#tour-skip'); pg.wait_for_timeout(900); pg.click('#onboard-done'); pg.wait_for_timeout(3500)

    # ---- no plan yet: a small invitation, easy to dismiss ----
    ok(vis('#pay') and 'See what is left until payday' in txt('#pay'), 'before setup there is a small card inviting you to set up your paycheck')
    ok('$' not in txt('#pay'), 'and it shows no numbers')

    # ---- setup, three steps ----
    pg.click('#pay .pay-go'); pg.wait_for_timeout(500)
    ok(vis('#pay-setup') and 'Your paycheck' in txt('#pay-setup'), 'Set up opens the paycheck step')
    pg.click('#pay-setup .primary'); pg.wait_for_timeout(300)
    ok('Enter what you get paid' in txt('#pay-setup') and vis('#pay-setup .pay-err'), 'an empty paycheck is refused with a plain message')
    pg.fill('#pay-setup .money-input input', '1850')
    pg.fill('#pay-setup input[type=date]', day(10)); pg.dispatch_event('#pay-setup input[type=date]', 'change'); pg.wait_for_timeout(200)
    ok('Next payday:' in txt('#pay-setup'), 'it shows the next payday straight away')
    pg.click('#pay-setup .primary'); pg.wait_for_timeout(400)
    ok('Bills you cannot skip' in txt('#pay-setup') and pg.locator('#pay-setup .pay-bill').count() == 2, 'step 2 lists Rent and Utilities to fill in')
    pg.locator('#pay-setup .pay-bill').nth(0).locator('.pay-am input').fill('1400')
    ok('646.15 per paycheck' in txt('#pay-setup'), 'a monthly rent shows what it takes from each paycheck')
    pg.locator('#pay-setup .pay-bill').nth(1).locator('.pay-nm').fill('Hydro-Québec')
    pg.locator('#pay-setup .pay-bill').nth(1).locator('.pay-am input').fill('90')
    pg.locator('#pay-setup .pay-bill').nth(1).locator('.pay-fq').click(); pg.wait_for_timeout(100)
    ok('Every year' in pg.locator('#pay-setup .pay-bill').nth(1).inner_text(), 'tapping the frequency changes it')
    for _ in range(3):
        pg.locator('#pay-setup .pay-bill').nth(1).locator('.pay-fq').click(); pg.wait_for_timeout(100)   # week, 2 weeks, back to month
    ok('Every month' in pg.locator('#pay-setup .pay-bill').nth(1).inner_text(), 'and it comes back round to every month')
    pg.click('#pay-setup .pay-chips .own'); pg.wait_for_timeout(200)
    ok(pg.locator('#pay-setup .pay-bill').count() == 3, 'Add your own adds a blank bill')
    pg.locator('#pay-setup .pay-bill').nth(2).locator('.pay-nm').fill('Daycare')
    pg.locator('#pay-setup .pay-bill').nth(2).locator('.pay-am input').fill('abc')
    pg.click('#pay-setup .primary'); pg.wait_for_timeout(300)
    ok('Check the amount of Daycare' in txt('#pay-setup'), 'a bill with a bad amount is flagged by name')
    pg.locator('#pay-setup .pay-bill').nth(2).locator('.pay-am input').fill('200')
    pg.locator('#pay-setup .pay-bill').nth(2).locator('.pay-rm').click(); pg.wait_for_timeout(200)
    ok(pg.locator('#pay-setup .pay-bill').count() == 2, 'the x removes a bill')
    pg.click('#pay-setup .primary'); pg.wait_for_timeout(300)
    free = 1850 - round(1400 * 12 / 26, 2) - round(90 * 12 / 26, 2)
    ok('That is it' in txt('#pay-setup') and ('$%s' % format(free, ',.2f')) in txt('#pay-setup'), 'step 3 shows what is free each pay period ($%.2f)' % free)
    pg.click('#pay-setup .primary'); pg.wait_for_timeout(1500)
    ok(not vis('#pay-setup') and vis('#pay') and 'free to spend' in low('#pay'), 'Done closes the sheet and shows the card')

    # ---- the card ----
    spent = 80 + 12.5  # SAQ was 7 days ago, before the payday 10 days ago? no: 7 days ago is after it, so it counts
    spent = 80 + 12.5 + 31
    left = free - spent
    ok(('$%s' % format(left, ',.2f')) in txt('#pay .pay-big') or ('$%s' % format(left, ',.2f')) in txt('#pay'), 'it shows what is left: %.2f (free %.2f minus %.2f spent)' % (left, free, spent))
    ok('a day' in low('#pay') and 'to payday' in low('#pay'), 'with the days to payday and an amount per day')
    ok(not vis('#pay .pay-rows'), 'the sums are hidden until you tap')
    pg.click('#pay .pay-big'); pg.wait_for_timeout(300)
    ok(vis('#pay .pay-rows') and 'paycheck' in low('#pay') and 'fixed bills' in low('#pay') and 'spent since' in low('#pay'), 'tapping the card opens the four lines of sums')
    pg.click('#pay .pay-edit'); pg.wait_for_timeout(500)
    ok(vis('#pay-setup') and pg.locator('#pay-setup .money-input input').first.input_value() == '1850', 'Edit opens the setup with your numbers in it')
    pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
    ok(not vis('#pay-setup'), 'Escape closes it without changing anything')

    # ---- payday: the card asks ----
    pg.evaluate("""async () => { await window.spendApi('PUT', 'pay', { amount: 1850, every: '2 weeks', start: '%s', bills: [{ name: 'Rent', amount: 1400, every: 'month', ap: false }] }); await window.spendPayRefresh(); }""" % day(14))
    pg.wait_for_timeout(800)
    ok('did you get paid?' in low('#pay') and vis('#pay .pay-paid'), 'when payday has come, the card asks "Did you get paid?"')
    pg.click('#pay .pay-no'); pg.wait_for_timeout(300)
    ok('did you get paid?' not in low('#pay') and 'payday was' in low('#pay') and vis('#pay .pay-paid'), 'Not yet puts the numbers back, says payday was, and keeps a Got paid button')
    pg.click('#pay .pay-paid'); pg.wait_for_timeout(500)
    ok(vis('#pay-paidsheet') and pg.locator('#pay-paidsheet .money-input input').input_value() == '1850', 'Got paid opens a sheet with the amount filled in')
    pg.fill('#pay-paidsheet .money-input input', '1900')
    pg.click('#pay-paidsheet .primary'); pg.wait_for_timeout(1500)
    ok(not vis('#pay-paidsheet') and 'New pay period' in txt('#toast-text'), 'Start new period closes it and says so: ' + txt('#toast-text'))
    ok('14 days to payday' in low('#pay') or '13 days to payday' in low('#pay'), 'a new period starts with about 14 days to go')

    # ---- the looks ----
    for look in ('candy', 'retro'):
        pg.evaluate("l => { document.documentElement.classList.add(l); window.dash.render(); }", look)
        pg.wait_for_timeout(500)
        ok(vis('#pay') and 'free to spend' in low('#pay'), '%s look: the card is there' % look)
        box = pg.locator('#pay').bounding_box()
        ok(box['width'] <= 390 and box['x'] >= 0, '%s look: it fits the screen (%d wide)' % (look, box['width']))
        if not vis('#pay .pay-edit'):
            pg.click('#pay .pay-big'); pg.wait_for_timeout(200)
        pg.click('#pay .pay-edit'); pg.wait_for_timeout(400)
        ok(vis('#pay-setup'), '%s look: the setup sheet opens' % look)
        sw = pg.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1")
        ok(sw, '%s look: nothing sticks out sideways' % look)
        pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
        pg.evaluate("l => { document.documentElement.classList.remove(l); window.dash.render(); }", look)
        pg.wait_for_timeout(300)
    ok(not errs, 'no page errors' + ('' if not errs else ': ' + '; '.join(errs[:3])))
    b.close()
print('\nALL PASSED: %d' % len(res) if all(res) else '\nFAILED: %d of %d' % (len(res) - sum(res), len(res)))
raise SystemExit(0 if all(res) else 1)
