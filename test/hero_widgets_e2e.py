# Browser test of the home screen's two swipeable widgets (Clean look only) against test/dev.js.
# Widget 1: "Last 14 days" with a 7D / 14D / 30D / 1Y switch added under it. Widget 2, one swipe away: a mini month
# calendar with a corner button to jump to any month and year. Run: python3 test/hero_widgets_e2e.py
import json, datetime, urllib.request as u
from playwright.sync_api import sync_playwright
BASE = 'http://127.0.0.1:8790'
H = {'Authorization': 'Bearer dev-admin', 'Content-Type': 'application/json'}
post = lambda path, body: json.loads(u.urlopen(u.Request(BASE + path, data=json.dumps(body).encode(), headers=H, method='POST')).read())

# "now" is built from the real current moment with no fixed hour, so "ago=0" always lands as today and "ago=N" as
# exactly N days back, whatever timezone the test account ends up in (see the trailing-range bug this caught: a fixed
# UTC hour can read as a different calendar day once converted to the account's own time zone).
now = datetime.datetime.now(datetime.timezone.utc)
ROWS = [
    (0, 'Rent', 750, 'Interac', 'Bills & Utilities'),
    (0, 'LemFi', 400, 'CIBC', 'Bills & Utilities'),
    (1, 'Costco', 81.93, 'Amex', 'Groceries'),
    (3, 'Metro', 81.59, 'Visa', 'Groceries'),
    (10, 'Costco', 45.00, 'Amex', 'Groceries'),
    (45, 'Metro', 70, 'Visa', 'Groceries'),
    (45, 'DoorDash', 20, 'Amex', 'Food Delivery'),
    (200, 'Costco', 200, 'Amex', 'Groceries'),
]
issues = []
for ago, m, a, c, cat in ROWS:
    t = (now - datetime.timedelta(days=ago)).strftime('%Y-%m-%dT%H:%M:%SZ')
    issues.append({"title": f"Spending - ${a}", "body": f"Date: {t}\nMerchant: {m}\nAmount: ${a}\nCard: {c}\nCategory: {cat}", "state": "open", "created_at": t})
TOTAL_7D = 750 + 400 + 81.93 + 81.59
TOTAL_14D = TOTAL_7D + 45.00
TOTAL_365D = TOTAL_14D + 70 + 20 + 200

res = []
errs = []


def ok(c, l):
    res.append(bool(c))
    print(('  ok ' if c else '  FAIL ') + l)


with sync_playwright() as P:
    b = P.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 390, 'height': 950}, device_scale_factor=2, has_touch=True, is_mobile=True)
    ctx.add_init_script("try{localStorage.setItem('spend.alertsAsk',String(Date.now()))}catch(e){}")
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errs.append(str(e)))
    vis = lambda s: pg.locator(s).is_visible()
    cdp = ctx.new_cdp_session(pg)

    def swipe(x0, x1, y=260):
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x0, 'y': y}]})
        for i in range(1, 13):
            cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x0 + (x1 - x0) * i / 12, 'y': y}]})
            pg.wait_for_timeout(16)
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        pg.wait_for_timeout(700)

    em = 'hero-widgets@example.com'
    pg.goto(BASE + '/?invite=' + post('/api/admin/invites', {})['code'])
    pg.wait_for_timeout(500)
    pg.fill('#auth-email', em)
    pg.fill('#auth-password', 'hero-widgets-pw-123')
    pg.click('#auth-submit')
    pg.wait_for_timeout(1000)
    post('/api/admin/import', {"email": em, "issues": issues, "dailyLimit": 50})
    pg.click('#tour-skip')
    pg.wait_for_timeout(900)
    pg.click('#onboard-done')
    pg.wait_for_timeout(4000)

    # ---- the calendar widget opens first ----
    ok(pg.evaluate("Math.round(document.querySelector('.hero-pager').scrollLeft/document.querySelector('.hero-pager').clientWidth)") == 1, 'the month calendar is the widget that opens first')
    ok('spent this month' in pg.inner_text('.hero-pg-cal .hero-label').lower(), 'and it is showing this month')
    # ---- widget 1: the range switch ----
    ok(vis('.htr-rng') and pg.locator('.htr-rng button').count() == 4, 'the 7D / 14D / 30D / 1Y switch is under the card')
    ok(pg.locator('.htr-rng button').all_inner_texts() == ['7D', '14D', '30D', '1Y'], 'the four ranges read left to right')
    ok(pg.locator('.htr-rng button[aria-pressed="true"]').inner_text() == '14D', '14D is the default, exactly like today')
    ok(vis('#hero14') and not vis('.htr'), 'on 14D, the original card is what shows')
    ok(vis('.hero-dots'), 'page dots show which widget is open')

    def amt(sel):
        return pg.inner_text(sel).replace('\n', '').split('.')[0].replace('$', '').replace(',', '')

    pg.click('.htr-rng button >> text=7D')
    pg.wait_for_timeout(900)
    ok(not vis('#hero14') and vis('.htr'), '7D switches to the trend widget')
    ok(pg.evaluate("(()=>{const r=document.querySelector('.htr-rng').getBoundingClientRect(), c=document.querySelector('.htr .htr-chart').getBoundingClientRect();return r.top>=c.bottom})()"),'on 7D the switch sits under the chart, at the bottom, same as 14D')
    ok(amt('.htr .hero-amt') == str(int(TOTAL_7D)), '7D total excludes the 10-day-old purchase: ' + pg.inner_text('.htr .hero-amt'))
    ok(pg.locator('.htr .line-svg').count() == 1, '7D is a line chart, same as 14D - not a bar chart')
    ok(pg.locator('.htr .dot').count() == 7, '7D draws one point per day')
    ok(pg.locator('.htr .dot.today').count() == 1 and pg.locator('.htr .dot.today.over').count() == 1, "today's point is marked, and over the limit")
    ok('over today' in pg.inner_text('.htr .htr-today'), '7D still carries the real over-today line')
    ok('Touch and hold the line to see a day' in pg.inner_text('.htr .scrub'), '7D has the same touch-and-hold hint as 14D')
    box = pg.eval_on_selector('.htr .dot.today', 'e=>{const r=e.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]}')
    pg.mouse.move(box[0], box[1])
    pg.wait_for_timeout(150)
    ok('$1,150.00' in pg.inner_text('.htr .scrub'), "touching today's point reads its real total: " + pg.inner_text('.htr .scrub'))
    pg.mouse.move(10, 10)
    pg.wait_for_timeout(150)

    pg.wait_for_timeout(600)  # let the background prefetch of 30D and 1Y land before the timing check below
    t0 = pg.evaluate('performance.now()')
    pg.click('.htr-rng button >> text=30D')
    pg.wait_for_timeout(60)
    switch_ms = pg.evaluate('performance.now()') - t0
    ok(amt('.htr .hero-amt') == str(int(TOTAL_14D)), '30D reaches the 10-day-old purchase: ' + pg.inner_text('.htr .hero-amt'))
    ok(switch_ms < 400, 'switching to a prefetched range is near-instant, not a fresh round trip (%dms)' % switch_ms)
    ok(pg.locator('.htr .line-svg').count() == 1, '30D is a line chart too')
    ok(pg.locator('.htr .dot').count() == 30, '30D draws one point per day')

    pg.click('.htr-rng button >> text=1Y')
    pg.wait_for_timeout(900)
    ok(amt('.htr .hero-amt') == str(int(TOTAL_365D)), '1Y reaches the 45- and 200-day-old purchases: ' + pg.inner_text('.htr .hero-amt'))
    ok(pg.locator('.htr .line-svg').count() == 1, '1Y is a line chart too: every range is the same chart now')
    ok(pg.locator('.htr .dot').count() == 12, '1Y draws one point per month')
    ok(pg.locator('.htr .avg-line').count() == 1, 'the monthly average still shows as a dashed reference line')

    pg.reload()
    pg.wait_for_timeout(3500)
    ok(pg.locator('.htr-rng button[aria-pressed="true"]').inner_text() == '1Y', 'the chosen range is remembered across a reload')
    pg.click('.htr-rng button >> text=14D')
    pg.wait_for_timeout(600)

    # ---- widget 2: the mini month calendar, one swipe away ----
    swipe(330, 60)
    ok(pg.evaluate("Math.round(document.querySelector('.hero-pager').scrollLeft/document.querySelector('.hero-pager').clientWidth)") == 1, 'swiping moves to the calendar widget')
    ok('spent this month' in pg.inner_text('.hero-pg-cal .hero-label').lower(), 'the calendar opens on the current month')
    today_tile = pg.locator('.hcal-d.today')
    ok(today_tile.count() == 1 and 'sel' in (today_tile.get_attribute('class') or ''), "today is on the grid and selected by default")
    ok('$1,150.00' in pg.inner_text('.hcal-read'), "today's readout shows the real total: " + pg.inner_text('.hcal-read'))
    pg.click('.hcal-d:not(.future):not(.blank):not(.today)')
    pg.wait_for_timeout(250)
    ok(pg.locator('.hcal-d.sel').count() == 1 and not today_tile.evaluate('e=>e.classList.contains("sel")'), 'tapping another day moves the selection')

    # the corner picker
    pg.click('.htr-pick')
    pg.wait_for_timeout(300)
    ok(vis('.hero-pop'), 'the corner button opens the month/year picker')
    ok(pg.locator('.hero-pop-grid button.on').count() == 1, 'the current month is marked')
    ok(pg.locator('[aria-label="Next year"]').is_disabled(), 'next year is blocked from the current year')
    pg.click('.hero-pop button >> text=This month')
    pg.wait_for_timeout(600)
    ok(not vis('.hero-pop'), '"This month" closes the picker')
    ok('spent this month' in pg.inner_text('.hero-pg-cal .hero-label').lower(), 'and lands back on the current month')

    ok(pg.evaluate("document.documentElement.scrollWidth<=innerWidth"), 'no sideways overflow from the new widgets')
    pg.screenshot(path='/tmp/claude-0/hero-widgets-e2e.png')

    # ---- Fresh and Arcade: none of this exists; the original single card is untouched ----
    pg.click('.hero-pager')
    pg.evaluate("document.querySelector('.hero-pager').scrollTo({left:0})")
    pg.click('#settings-open')
    pg.wait_for_timeout(400)
    pg.click('.theme-pick button[data-theme="candy"]')
    pg.wait_for_timeout(500)
    pg.click('#settings-close')
    pg.wait_for_timeout(400)
    ok(not pg.locator('.htr-rng').count() and not pg.locator('.hero-dots').count(), 'Fresh has no range switch or dots: the original card, unmodified')
    ok(vis('#hero14') and not vis('.htr'), 'Fresh shows the one original card')
    pg.click('#settings-open')
    pg.wait_for_timeout(400)
    pg.click('.theme-pick button[data-theme="retro"]')
    pg.wait_for_timeout(500)
    pg.click('#settings-close')
    pg.wait_for_timeout(400)
    ok(not pg.locator('.htr-rng').count(), 'Arcade has no range switch either')
    pg.click('#settings-open')
    pg.wait_for_timeout(400)
    pg.click('.theme-pick button[data-theme="clean"]')
    pg.wait_for_timeout(500)
    pg.click('#settings-close')
    pg.wait_for_timeout(600)
    ok(vis('.htr-rng'), 'switching back to Clean rebuilds the switch')

    ok(not errs, 'no page errors ' + str(errs))
    b.close()

print('\nALL PASSED: %d' % len(res) if all(res) else '\nFAILURES: %d' % res.count(False))
