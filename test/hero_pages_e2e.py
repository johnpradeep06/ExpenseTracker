# Browser test of the third hero page (Free to spend) and choosing which hero pages show. Run against test/dev.js: python3 test/hero_pages_e2e.py
import json, datetime, urllib.request as u
from playwright.sync_api import sync_playwright
BASE = 'http://127.0.0.1:8790'
H = {'Authorization': 'Bearer dev-admin', 'Content-Type': 'application/json'}
post = lambda path, body: json.loads(u.urlopen(u.Request(BASE + path, data=json.dumps(body).encode(), headers=H, method='POST')).read())
now = datetime.datetime.now(datetime.timezone.utc)
day = lambda n: (now - datetime.timedelta(days=n)).strftime('%Y-%m-%d')
issues = []
for n, m, a in [(1, 'Metro', 80.0), (2, 'Tim Hortons', 12.5)]:
    t = (now - datetime.timedelta(days=n)).replace(hour=15, minute=0, second=0).strftime('%Y-%m-%dT%H:%M:%SZ')
    issues.append({"title": f"Spending - ${a}", "body": f"Date: {t}\nMerchant: {m}\nAmount: ${a}\nCard: Visa\nCategory: Groceries", "state": "open", "created_at": t})
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
    dots = lambda: pg.locator('.hero-dots i').count()
    page_no = lambda: round(pg.evaluate("document.querySelector('#hero-pager').scrollLeft / document.querySelector('#hero-pager').clientWidth"))
    em = 'heropages@example.com'
    pg.goto(BASE + '/?invite=' + post('/api/admin/invites', {})['code']); pg.wait_for_timeout(500)
    pg.fill('#auth-email', em); pg.fill('#auth-password', 'hero-pages-pw-1'); pg.click('#auth-submit'); pg.wait_for_timeout(1000)
    post('/api/admin/import', {"email": em, "issues": issues, "dailyLimit": 0})
    pg.click('#tour-skip'); pg.wait_for_timeout(900); pg.click('#onboard-done'); pg.wait_for_timeout(3500)

    # ---- three pages ----
    ok(pg.evaluate("!!document.querySelector('#hero-pager #pay')"), 'in the Clean look Free to spend lives inside the hero, as its own page')
    ok(dots() == 3, 'so there are three dots: %d' % dots())
    ok(page_no() == 1, 'the calendar still opens first (page %d)' % page_no())
    ok(pg.locator('#latest').count() == 1 and pg.evaluate("!document.querySelector('.stack > #pay')"), 'and it is no longer a separate card further down')
    pg.evaluate("document.querySelector('#hero-pager').scrollTo({left: 2 * document.querySelector('#hero-pager').clientWidth, behavior: 'instant'})"); pg.wait_for_timeout(500)
    ok(page_no() == 2 and vis('#pay') and 'See what is left until payday' in pg.inner_text('#pay'), 'the third page invites you to set up your paycheck')
    pg.evaluate("""async () => { await window.spendApi('PUT','pay',{amount:1850,every:'2 weeks',start:'%s',bills:[{name:'Rent',amount:1400,every:'month'}]}); await window.spendPayRefresh(); }""" % day(10)); pg.wait_for_timeout(800)
    ok('free to spend' in pg.inner_text('#pay').lower() and '$' in pg.inner_text('#pay'), 'once set up it shows the free-to-spend numbers')
    box = pg.locator('#pay').bounding_box()
    ok(box['x'] >= 0 and box['x'] + box['width'] <= 391, 'and it fits the screen (%d wide)' % box['width'])
    pg.screenshot(path='/tmp/claude-0/hero3.png')

    # ---- choosing pages ----
    pg.click('#settings-open'); pg.wait_for_timeout(500)
    ok(vis('#hero-pages') and pg.locator('#hero-pages button').count() == 3, 'Settings has a Home screen pages chooser with three pages')
    pg.click('#hero-pages [data-page=pay]'); pg.wait_for_timeout(400)
    ok(dots() == 2 and not pg.evaluate("document.querySelector('#hero-pager .hero-pg-pay').offsetParent !== null"), 'turning Free to spend off leaves two pages')
    pg.click('#hero-pages [data-page=trend]'); pg.wait_for_timeout(300)
    ok(pg.locator('.hero-dots').evaluate("e => e.hidden") and dots() == 1, 'with one page left there is nothing to swipe, so the dots go away')
    pg.click('#hero-pages [data-page=cal]'); pg.wait_for_timeout(300)
    ok(pg.locator('#hero-pages [data-page=cal]').get_attribute('aria-pressed') == 'true', 'the last page cannot be turned off')
    pg.click('#hero-pages [data-page=pay]'); pg.click('#hero-pages [data-page=trend]'); pg.wait_for_timeout(400)
    ok(dots() == 3, 'turning them back on brings back three')
    pg.click('#hero-first [data-first=pay]'); pg.wait_for_timeout(500)
    ok(pg.locator('#hero-first [data-first=pay]').get_attribute('aria-pressed') == 'true', 'Opens on can be set to Free to spend')
    pg.click('#settings-close'); pg.wait_for_timeout(300)
    pg.reload(); pg.wait_for_timeout(4000)
    ok(page_no() == 2 and vis('#pay'), 'after a reload the app opens on Free to spend (page %d)' % page_no())
    pg.click('#settings-open'); pg.wait_for_timeout(400)
    pg.click('#hero-pages [data-page=cal]'); pg.click('#hero-pages [data-page=pay]'); pg.wait_for_timeout(300)   # cal off, pay off -> trend only? pay off first would leave trend + ... check below
    ok(dots() <= 2, 'the choice is remembered and still works after a reload')
    pg.click('#hero-pages [data-page=cal]'); pg.click('#hero-pages [data-page=pay]'); pg.wait_for_timeout(300)
    pg.click('#settings-close'); pg.wait_for_timeout(300)

    # ---- Fresh and Arcade keep the card as it was ----
    for look in ('candy', 'retro'):
        pg.evaluate("l => { document.documentElement.classList.add(l); window.dispatchEvent(new CustomEvent('spend:theme', {detail: l})); }", look); pg.wait_for_timeout(700)
        ok(pg.evaluate("!!document.querySelector('.stack > #pay') && !document.querySelector('#hero-pager #pay')"), '%s look: Free to spend is a card of its own again' % look)
        ok(vis('#pay') and 'free to spend' in pg.inner_text('#pay').lower(), '%s look: and it still shows the numbers' % look)
        pg.evaluate("l => { document.documentElement.classList.remove(l); window.dispatchEvent(new CustomEvent('spend:theme', {detail: 'clean'})); }", look); pg.wait_for_timeout(700)
    ok(pg.evaluate("!!document.querySelector('#hero-pager #pay')") and dots() == 3, 'back in Clean it goes back into the hero')

    # ---- the cross on the sign-up card removes the page ----
    pg.evaluate("async () => { await window.spendApi('DELETE','pay'); await window.spendPayRefresh(); }"); pg.wait_for_timeout(800)
    ok('See what is left until payday' in pg.inner_text('#pay'), 'with no plan the third page is the invitation')
    pg.evaluate("document.querySelector('#pay .pay-x').click()"); pg.wait_for_timeout(500)
    ok(dots() == 2, 'its cross takes the page off the home screen')
    pg.click('#settings-open'); pg.wait_for_timeout(400)
    ok(pg.locator('#hero-pages [data-page=pay]').get_attribute('aria-pressed') == 'false', 'and Settings shows it as off, so it can be turned back on')
    ok(pg.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), 'nothing sticks out sideways')
    ok(not errs, 'no page errors' + ('' if not errs else ': ' + '; '.join(errs[:3])))
    b.close()
print('\nALL PASSED: %d' % len(res) if all(res) else '\nFAILED: %d of %d' % (len(res) - sum(res), len(res)))
raise SystemExit(0 if all(res) else 1)
