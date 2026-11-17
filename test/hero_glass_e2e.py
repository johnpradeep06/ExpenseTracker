# Browser test of the glass swipe on the hero. Run against test/dev.js: python3 test/hero_glass_e2e.py
import json, datetime, urllib.request as u
from playwright.sync_api import sync_playwright
BASE = 'http://127.0.0.1:8790'
H = {'Authorization': 'Bearer dev-admin', 'Content-Type': 'application/json'}
post = lambda path, body: json.loads(u.urlopen(u.Request(BASE + path, data=json.dumps(body).encode(), headers=H, method='POST')).read())
now = datetime.datetime.now(datetime.timezone.utc)
t = (now - datetime.timedelta(days=1)).replace(second=0).strftime('%Y-%m-%dT%H:%M:%SZ')
issues = [{"title": "Spending - $20", "body": f"Date: {t}\nMerchant: Metro\nAmount: $20\nCard: Visa\nCategory: Groceries", "state": "open", "created_at": t}]
res, errs = [], []


def ok(c, l):
    res.append(bool(c))
    print(('  ok ' if c else '  FAIL ') + l)


def boot(P, b, email, reduce=False):
    ctx = b.new_context(viewport={'width': 390, 'height': 900}, device_scale_factor=2, has_touch=True, is_mobile=True, reduced_motion='reduce' if reduce else 'no-preference')
    ctx.add_init_script("try{localStorage.setItem('spend.alertsAsk',String(Date.now()))}catch(e){}")
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(BASE + '/?invite=' + post('/api/admin/invites', {})['code']); pg.wait_for_timeout(500)
    pg.fill('#auth-email', email); pg.fill('#auth-password', 'glass-e2e-password-1'); pg.click('#auth-submit'); pg.wait_for_timeout(1000)
    post('/api/admin/import', {"email": email, "issues": issues, "dailyLimit": 50})
    pg.click('#tour-skip'); pg.wait_for_timeout(900); pg.click('#onboard-done'); pg.wait_for_timeout(3500)
    return ctx, pg


MID = "(() => { const p = document.querySelector('#hero-pager'); p.style.scrollSnapType = 'none'; p.scrollTo({ left: 1.5 * p.clientWidth, behavior: 'instant' }); })()"
STATE = """() => { const out = {}; const pager = document.querySelector('#hero-pager'); const pages = [...pager.querySelectorAll('.hero-pg')].filter((e) => e.style.display !== 'none');
  out.filters = pages.map((e) => e.style.filter); out.opac = pages.map((e) => Number(e.style.opacity || 1)); out.scale = pages.map((e) => e.style.transform);
  const sh = document.querySelector('.hero-sheen'); out.sheen = sh ? Number(sh.style.opacity || 0) : -1; out.moving = document.querySelector('#headline').classList.contains('hero-moving');
  out.will = pages.length ? getComputedStyle(pages[0]).willChange : ''; return out; }"""

with sync_playwright() as P:
    b = P.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx, pg = boot(P, b, 'glass-e2e@example.com')
    pg.evaluate("async () => { await window.spendApi('PUT','pay',{amount:1850,every:'2 weeks',start:new Date(Date.now()-5*864e5).toISOString().slice(0,10),bills:[]}); await window.spendPayRefresh(); }"); pg.wait_for_timeout(1000)
    st = pg.evaluate(STATE)
    ok(all(f == '' for f in st['filters']) and st['sheen'] == 0 and not st['moving'], 'at rest the hero is plain and crisp: no blur, no highlight, no compositing hints (%s)' % st['will'])
    pg.evaluate(MID); pg.wait_for_timeout(120)
    st = pg.evaluate(STATE)
    ok(st['moving'] and 'will-change' != '' and 'filter' in st['will'], 'while the pages move the compositing hints are on: ' + st['will'])
    ok(sum(1 for f in st['filters'] if f.startswith('blur(')) >= 2, 'halfway between two pages both frost over: %s' % st['filters'])
    ok(all(o < 1 for o in st['opac'][:3]) and min(st['opac']) < 0.8, 'and fade (%s)' % st['opac'])
    ok(any(s.startswith('scale(0.9') for s in st['scale']), 'and shrink a little (%s)' % st['scale'])
    ok(st['sheen'] > 0.5, 'and a highlight sweeps across the card (%.2f)' % st['sheen'])
    pg.screenshot(path='/tmp/claude-0/glass-mid.png', clip={'x': 0, 'y': 60, 'width': 390, 'height': 520})
    pg.wait_for_timeout(500)
    st = pg.evaluate(STATE)
    ok(all(f == '' for f in st['filters']) and all(s == '' for s in st['scale']) and all(o == 1 for o in st['opac']) and st['sheen'] == 0 and not st['moving'], 'a moment after the swipe stops everything is cleared again, crisp (%s)' % st['filters'])
    ok(pg.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), 'nothing sticks out sideways')
    pg.evaluate("document.querySelector('#hero-pager').style.scrollSnapType = ''")

    # a finger that pauses halfway: the effect holds until it lets go
    cdp = ctx.new_cdp_session(pg)
    box = pg.locator('#hero-pager').bounding_box(); y = box['y'] + 160
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': 330, 'y': y}]})
    for k in range(1, 9):
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': 330 - k * 22, 'y': y}]}); pg.wait_for_timeout(16)
    pg.wait_for_timeout(500)      # the finger rests: no scrolling for half a second
    st = pg.evaluate(STATE)
    ok(st['moving'] and any(f.startswith('blur(') for f in st['filters']), 'while the finger rests mid-swipe the glass effect stays (%s)' % st['filters'])
    cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []}); pg.wait_for_timeout(1200)
    st = pg.evaluate(STATE)
    ok(all(f == '' for f in st['filters']) and not st['moving'] and st['sheen'] == 0, 'once the finger lets go and the page settles, it is crisp again')
    ctx.close()

    # Reduce Motion: no effect at all
    ctx, pg = boot(P, b, 'glass-calm@example.com', reduce=True)
    pg.evaluate(MID); pg.wait_for_timeout(150)
    st = pg.evaluate(STATE)
    ok(all(f == '' for f in st['filters']) and all(s == '' for s in st['scale']) and st['sheen'] <= 0 and not st['moving'], 'with Reduce Motion on, there is no blur, shrink or highlight at all')
    ctx.close()

    # Fresh and Arcade have no swipeable hero: nothing is added there
    ctx, pg = boot(P, b, 'glass-look@example.com')
    for look in ('candy', 'retro'):
        pg.evaluate("l => { document.documentElement.classList.add(l); window.dispatchEvent(new CustomEvent('spend:theme', {detail: l})); }", look); pg.wait_for_timeout(600)
        ok(pg.locator('.hero-sheen').count() == 0, '%s look: no highlight element is left behind' % look)
        pg.evaluate("l => { document.documentElement.classList.remove(l); window.dispatchEvent(new CustomEvent('spend:theme', {detail: 'clean'})); }", look); pg.wait_for_timeout(600)
    ok(pg.locator('.hero-sheen').count() == 1, 'back in Clean it comes back (once)')
    ctx.close()
    ok(not errs, 'no page errors' + ('' if not errs else ': ' + '; '.join(errs[:3])))
    b.close()
print('\nALL PASSED: %d' % len(res) if all(res) else '\nFAILED: %d of %d' % (len(res) - sum(res), len(res)))
raise SystemExit(0 if all(res) else 1)
