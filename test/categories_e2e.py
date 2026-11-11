# Browser test of the Food Delivery and Snacks categories against test/dev.js. Run: python3 test/categories_e2e.py
import json, urllib.request as u
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:8790'
H={'Authorization':'Bearer dev-admin','Content-Type':'application/json'}
def http(path, body, auth=None):
    h={'Content-Type':'application/json'}
    if auth: h['Authorization']='Bearer '+auth
    return json.loads(u.urlopen(u.Request(BASE+path, data=json.dumps(body).encode(), headers=h, method='POST')).read())
res=[]; errs=[]
def ok(c,l): res.append(bool(c)); print(('  ok ' if c else '  FAIL ')+l)
with sync_playwright() as P:
    b=P.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
    ctx=b.new_context(viewport={'width':390,'height':844},has_touch=True); pg=ctx.new_page(); pg.on('pageerror',lambda e: errs.append(str(e)))
    pg.goto(BASE+'/?invite='+http('/api/admin/invites',{},'dev-admin')['code']); pg.wait_for_timeout(500)
    pg.fill('#auth-email','cat@example.com'); pg.fill('#auth-password','cat-preview-pw-1'); pg.click('#auth-submit'); pg.wait_for_timeout(1200)
    pg.click('#tour-skip'); pg.wait_for_timeout(900)
    code=pg.inner_text('#setup-code')
    for m,a,c in [('Uber Eats','23.10',''),('DoorDash','31.00',''),('7-Eleven','4.50',''),('Dairy Queen','6.25',''),('Tim Hortons','3.10','Dining & Coffee'),('Uber','14.00','')]:
        http('/api/log',{'merchant':m,'amount':a,'card':'Visa','category':c},code)
    pg.click('#onboard-done'); pg.wait_for_timeout(2500)
    txt=pg.inner_text('#by-category')
    ok('Food Delivery' in txt, 'Food Delivery shows up as a category')
    ok('Snacks' in txt, 'Snacks shows up as a category')
    ok('$54.10' in txt, 'Uber Eats + DoorDash add up to $54.10 under Food Delivery')
    ok('$10.75' in txt, '7-Eleven + Dairy Queen add up to $10.75 under Snacks')
    ok('Dining & Coffee' in txt and 'Transport' in txt, 'Tim Hortons stays Dining & Coffee and plain Uber stays Transport')
    pg.screenshot(path='/tmp/claude-0/cats.png',full_page=True)
    pg.click('#add-open') if pg.locator('#add-open').count() else None
    opts=pg.evaluate("Array.from(document.querySelectorAll('#add-category option')).map(o=>o.textContent)")
    ok('Food Delivery' in opts and 'Snacks' in opts,'the Add purchase menu offers both')
    ok(not errs,'no page errors '+str(errs))
    b.close()
print('\nALL PASSED: %d'%len(res) if all(res) else '\nFAILURES: %d'%res.count(False))
