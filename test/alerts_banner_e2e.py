# Browser test of the "Turn on alerts" banner against test/dev.js. Run: python3 test/alerts_banner_e2e.py
import json, urllib.request as u
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:8790'
def http(path, body, auth=None):
    h={'Content-Type':'application/json'}
    if auth: h['Authorization']='Bearer '+auth
    return json.loads(u.urlopen(u.Request(BASE+path, data=json.dumps(body).encode(), headers=h, method='POST')).read())
res=[]; errs=[]
def ok(c,l): res.append(bool(c)); print(('  ok ' if c else '  FAIL ')+l)
with sync_playwright() as P:
    b=P.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
    ctx=b.new_context(viewport={'width':390,'height':844},has_touch=True)
    pg=ctx.new_page(); pg.on('pageerror',lambda e: errs.append(str(e)))
    pg.goto(BASE+'/?invite='+http('/api/admin/invites',{},'dev-admin')['code']); pg.wait_for_timeout(500)
    pg.fill('#auth-email','al@example.com'); pg.fill('#auth-password','alerts-preview-pw-1'); pg.click('#auth-submit'); pg.wait_for_timeout(1200)
    pg.click('#tour-skip'); pg.wait_for_timeout(800); pg.click('#onboard-done'); pg.wait_for_timeout(3500)
    vis=lambda s: pg.locator(s).is_visible()
    ok(vis('#alerts-banner') and 'Turn on alerts' in pg.inner_text('#alerts-banner'),'the app asks to turn on alerts with one big button')
    pg.screenshot(path='/tmp/claude-0/alerts-banner.png',clip={'x':0,'y':0,'width':390,'height':420})
    pg.click('#alerts-banner-later'); pg.wait_for_timeout(300)
    ok(not vis('#alerts-banner'),'Not now hides it')
    pg.reload(); pg.wait_for_timeout(3500)
    ok(not vis('#alerts-banner'),'it stays hidden after reopening (for a week)')
    pg.evaluate("localStorage.removeItem('spend.alertsAsk')"); pg.reload(); pg.wait_for_timeout(3500)
    ok(vis('#alerts-banner'),'it comes back once the week is up')
    ok(not errs,'no page errors '+str(errs))
    b.close()
print('\nALL PASSED: %d'%len(res) if all(res) else '\nFAILURES: %d'%res.count(False))
