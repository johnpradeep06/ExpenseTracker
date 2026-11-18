# Browser test of the "Stay conscious" card (draining battery + streak) in all three looks. Run against test/dev.js: python3 test/stay_e2e.py
import json, datetime, urllib.request as u
from playwright.sync_api import sync_playwright
BASE = 'http://127.0.0.1:8790'
H = {'Authorization': 'Bearer dev-admin', 'Content-Type': 'application/json'}
post = lambda path, body: json.loads(u.urlopen(u.Request(BASE + path, data=json.dumps(body).encode(), headers=H, method='POST')).read())
now = datetime.datetime.now(datetime.timezone.utc)
res, errs = [], []


def ok(c, l):
    res.append(bool(c))
    print(('  ok ' if c else '  FAIL ') + l)


def issue(days_ago, hour, merchant, amount):
    t = (now - datetime.timedelta(days=days_ago)).replace(hour=hour, minute=0, second=0, microsecond=0).strftime('%Y-%m-%dT%H:%M:%SZ')
    return {"title": "Spending - $%s" % amount, "body": f"Date: {t}\nMerchant: {merchant}\nAmount: ${amount}\nCard: Visa\nCategory: Other", "state": "open", "created_at": t}


# Today is never in the future: purchases "today" are put at 00:30 UTC so they exist at any hour. Six earlier days all under $50.
ISSUES = [issue(d, 12, 'Shop %d' % d, 10 + d) for d in range(1, 7)] + [issue(0, 0, 'Metro', 20)]


def boot(P, b, email, issues, limit):
    ctx = b.new_context(viewport={'width': 390, 'height': 900}, device_scale_factor=2, has_touch=True, is_mobile=True)
    ctx.add_init_script("try{localStorage.setItem('spend.alertsAsk',String(Date.now()))}catch(e){}")
    pg = ctx.new_page()
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(BASE + '/?invite=' + post('/api/admin/invites', {})['code']); pg.wait_for_timeout(500)
    pg.fill('#auth-email', email); pg.fill('#auth-password', 'stay-e2e-password-1'); pg.click('#auth-submit'); pg.wait_for_timeout(1000)
    post('/api/admin/import', {"email": email, "issues": issues, "dailyLimit": limit})
    pg.click('#tour-skip'); pg.wait_for_timeout(900); pg.click('#onboard-done'); pg.wait_for_timeout(3500)
    return ctx, pg


with sync_playwright() as P:
    b = P.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx, pg = boot(P, b, 'stay1@example.com', ISSUES, 50)
    txt = lambda s: pg.inner_text(s)
    vis = lambda s: pg.locator(s).is_visible()
    ok(vis('#stay'), 'the Stay conscious card shows')
    ok('$30' in txt('#stay .st-big'), 'it says $30 left today: $50 limit minus $20 spent (%s)' % txt('#stay .st-big'))
    ok('60%' in txt('#stay .st-bat'), 'the battery is 60% full')
    ok(pg.get_attribute('#stay', 'data-level') == 'ok', 'and it is green')
    ok(pg.locator('#stay .st-d').count() == 7, 'the week row has 7 days')
    ok(pg.locator('#stay .st-d.today').count() == 1 and pg.locator('#stay .st-d.ok').count() >= 5, 'today is still open and the six days before are ticked')
    ok(txt('#stay .st-num b').strip() == '6', 'the streak is 6 days (today is not counted until it is over): %s' % txt('#stay .st-num b'))
    ok('1 skip left' in txt('#stay .st-note'), 'one free skip is available this week')
    ok('Next milestone: 7' in txt('#stay .st-next'), 'the next milestone is 7 days, 1 to go')

    # more spending drains it
    pg.evaluate("async () => { await window.spendApi('POST','purchases',{title:'Spending - $25',body:'Date: '+new Date().toISOString()+'\\nMerchant: Uber Eats\\nAmount: $25\\nCard: Visa\\nCategory: Other'}); }")
    pg.evaluate("window.dash && window.dash.reload && window.dash.reload()"); pg.wait_for_timeout(2500)
    if '$5' not in txt('#stay .st-big'):
        pg.reload(); pg.wait_for_timeout(3500)
    ok('$5' in txt('#stay .st-big'), 'after another $25 it says $5 left (%s)' % txt('#stay .st-big'))
    ok(pg.get_attribute('#stay', 'data-level') == 'bad' and pg.locator('#stay .st-bat.low').count() == 1, 'the battery turns red and pulses')
    ok('borrowed from tomorrow' in txt('#stay .st-say'), 'and says so in plain words')
    pg.evaluate("async () => { await window.spendApi('POST','purchases',{title:'Spending - $30',body:'Date: '+new Date().toISOString()+'\\nMerchant: SAQ\\nAmount: $30\\nCard: Visa\\nCategory: Other'}); }")
    pg.reload(); pg.wait_for_timeout(3500)
    ok('over' in txt('#stay .st-bat') and txt('#stay .st-big').startswith('−$25'), 'going over shows -$25 and "over" (%s)' % txt('#stay .st-big'))
    ok(pg.locator('#stay .st-d.skip').count() == 1 and txt('#stay .st-num b').strip() == '6', 'the first day over uses the free skip, so the 6 day streak survives')
    ok('No skip left' in txt('#stay .st-note'), 'and the card says no skip is left')

    # all three looks
    for look in ('candy', 'retro', 'clean'):
        pg.evaluate("l => { const c = document.documentElement.classList; c.remove('candy', 'retro'); if (l !== 'clean') c.add(l); window.dash.render(); }", look); pg.wait_for_timeout(700)
        pg.locator('#stay').scroll_into_view_if_needed()
        ok(vis('#stay') and pg.locator('#stay .st-bat').count() == 1 and pg.locator('#stay .st-week .st-d').count() == 7, '%s look: the card has its battery and week row' % look)
        ok(pg.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), '%s look: nothing sticks out sideways' % look)
        ok(pg.evaluate("(() => { const r = document.querySelector('#stay').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1; })()"), '%s look: the card fits the screen' % look)
        pg.screenshot(path='/tmp/claude-0/stay-%s.png' % look, clip={'x': 0, 'y': max(0, pg.locator('#stay').bounding_box()['y'] - 10), 'width': 390, 'height': min(560, pg.locator('#stay').bounding_box()['height'] + 20)})
    ctx.close()

    # a streak that breaks: Mon-style two over days in the same calendar week would depend on the weekday, so use an over day last week + yesterday
    br = [issue(d, 12, 'Shop %d' % d, 10) for d in range(3, 8)] + [issue(2, 12, 'Big night', 90), issue(1, 12, 'Big night 2', 95)]
    ctx, pg = boot(P, b, 'stay2@example.com', br, 50)
    wk = pg.evaluate("[...document.querySelectorAll('#stay .st-d')].map(e => e.className)")
    ok(any('bad' in c for c in wk) or any('skip' in c for c in wk), 'over-limit days show in the week row (%s)' % wk)
    ok(vis('#stay .st-lost') or pg.locator('#stay .st-d.bad').count() == 0, 'a broken streak shows the lost-streak note (or the two days fell in different weeks and were forgiven)')
    ctx.close()

    # no limit: streak asks for one, battery falls back to the 14-day average
    ctx, pg = boot(P, b, 'stay3@example.com', ISSUES, 0)
    ok(vis('#stay .st-cta') and 'Set a daily limit' in txt('#stay .st-cta') and pg.locator('#stay .st-week').count() == 0, 'no limit set: the streak part asks you to set one')
    ok('daily average' in txt('#stay .st-lab'), 'and the battery uses your daily average instead')
    ctx.close()
    ok(not errs, 'no page errors' + ('' if not errs else ': ' + '; '.join(errs[:3])))
    b.close()
print('\nALL PASSED: %d' % len(res) if all(res) else '\nFAILED: %d of %d' % (len(res) - sum(res), len(res)))
raise SystemExit(0 if all(res) else 1)
