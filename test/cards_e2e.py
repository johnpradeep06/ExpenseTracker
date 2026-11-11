# Browser test of the per-card view against test/dev.js. Run: python3 test/cards_e2e.py
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
    ctx=b.new_context(viewport={'width':390,'height':844},has_touch=True); pg=ctx.new_page(); pg.on('pageerror',lambda e: errs.append(str(e)))
    pg.on('dialog', lambda d: d.accept('Family card'))
    pg.goto(BASE+'/?invite='+http('/api/admin/invites',{},'dev-admin')['code']); pg.wait_for_timeout(500)
    pg.fill('#auth-email','cd@example.com'); pg.fill('#auth-password','cards-preview-pw-1'); pg.click('#auth-submit'); pg.wait_for_timeout(1200)
    pg.click('#tour-skip'); pg.wait_for_timeout(900)
    code=pg.inner_text('#setup-code')
    for m,a,c in [('Metro','40.00','Amex Gold'),('Costco','60.00','Amex Gold'),('Starbucks','5.50','Visa Debit'),('Lyft','12.00','Visa Debit'),('Amazon','25.00','')]:
        http('/api/log',{'merchant':m,'amount':a,'card':c,'category':''},code)
    pg.click('#onboard-done'); pg.wait_for_timeout(2500)
    vis=lambda s: pg.locator(s).is_visible()
    ok(vis('#by-card'),'the Cards section shows when more than one card is used')
    txt=pg.inner_text('#by-card')
    ok('Amex Gold' in txt and '$100.00' in txt and '2 purchases' in txt,'Amex Gold: $100.00 over 2 purchases')
    ok('Visa Debit' in txt and '$17.50' in txt,'Visa Debit: $17.50')
    ok('No card' in txt and '$25.00' in txt,'purchases with no card are grouped as No card')
    pg.locator('#by-card button', has_text='Amex Gold').click(); pg.wait_for_timeout(500)
    lat=pg.inner_text('#latest')
    ok('Showing Amex Gold' in lat and 'Metro' in lat and 'Costco' in lat and 'Starbucks' not in lat,'tapping a card shows only its individual purchases')
    pg.click('#latest >> text=Rename'); pg.wait_for_timeout(500)
    ok('Family card' in pg.inner_text('#by-card') and 'Showing Family card' in pg.inner_text('#latest'),'renaming a card shows the new name everywhere')
    pg.click('#latest >> text=Show all'); pg.wait_for_timeout(400)
    ok('Starbucks' in pg.inner_text('#latest') and 'Family card' in pg.inner_text('#latest'),'Show all brings everything back, with the card named on each purchase')
    pg.screenshot(path='/tmp/claude-0/cards.png',full_page=True)
    ok(not errs,'no page errors '+str(errs))
    b.close()
print('\nALL PASSED: %d'%len(res) if all(res) else '\nFAILURES: %d'%res.count(False))
