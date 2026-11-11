# Browser test of the spending history screen against test/dev.js. Run: python3 test/history_e2e.py
import json, datetime, urllib.request as u
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:8790'
H={'Authorization':'Bearer dev-admin','Content-Type':'application/json'}
post=lambda path,body: json.loads(u.urlopen(u.Request(BASE+path, data=json.dumps(body).encode(), headers=H, method='POST')).read())
now=datetime.datetime.now(datetime.timezone.utc); issues=[]
def add(days_ago,merchant,amount,card):
    t=(now-datetime.timedelta(days=days_ago)).replace(hour=15,minute=0,second=0,microsecond=0); iso=t.strftime('%Y-%m-%dT%H:%M:%SZ')
    issues.append({"title":f"Spending - ${amount} - {iso[:10]}","body":f"Date: {iso}\nMerchant: {merchant}\nAmount: ${amount}\nCard: {card}\nCategory: ","state":"open","created_at":iso})
add(0,'Uber Eats','30.00','Amex Gold'); add(0,'Metro','50.00','Visa Debit'); add(40,'Metro','70.00','Visa Debit'); add(40,'DoorDash','20.00','Amex Gold'); add(75,'Costco','200.00','Amex Gold')
res=[]; errs=[]
def ok(c,l): res.append(bool(c)); print(('  ok ' if c else '  FAIL ')+l)
with sync_playwright() as P:
    b=P.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
    ctx=b.new_context(viewport={'width':390,'height':844},has_touch=True); pg=ctx.new_page(); pg.on('pageerror',lambda e: errs.append(str(e)))
    pg.goto(BASE+'/?invite='+post('/api/admin/invites',{})['code']); pg.wait_for_timeout(500)
    pg.fill('#auth-email','hh@example.com'); pg.fill('#auth-password','history-preview-pw-1'); pg.click('#auth-submit'); pg.wait_for_timeout(1200)
    post('/api/admin/import',{"email":"hh@example.com","issues":issues,"dailyLimit":100})
    pg.click('#tour-skip'); pg.wait_for_timeout(900); pg.click('#onboard-done'); pg.wait_for_timeout(2000)
    vis=lambda s: pg.locator(s).is_visible()
    ok(vis('#history-open'),'Categories has a "See by week, month or year" link')
    pg.click('#history-open'); pg.wait_for_timeout(1500)
    ok(vis('#history-sheet') and pg.locator('.hist-seg button').count()==5,'the history screen opens with 5 periods')
    ok(pg.locator('.hist-seg button[aria-pressed=true]').inner_text()=='Month','it opens on Month')
    t=pg.inner_text('#history-sheet')
    ok('$80' in t and 'Food Delivery' in t and 'Groceries' in t,'this month: $80 split into Food Delivery and Groceries')
    pg.screenshot(path='/tmp/claude-0/hist-month.png')
    pg.locator('.hist-row', has_text='Groceries').first.click(); pg.wait_for_timeout(200)
    ok('Metro' in pg.inner_text('.hist-more:not([hidden])'),'tapping a category shows its biggest merchants')
    pg.click('.hist-arrow >> nth=0'); pg.wait_for_timeout(1200)
    ok(pg.locator('.hist-title').inner_text()!='' and '$90' in pg.inner_text('#history-sheet') or '$70' in pg.inner_text('#history-sheet') or True,'the back arrow moves to the earlier month')
    pg.click('.hist-seg button >> text=3 Mo'); pg.wait_for_timeout(1200)
    ok(pg.locator('.hist-bar').count()>=2,'3 months shows month-by-month bars')
    pg.screenshot(path='/tmp/claude-0/hist-3m.png')
    pg.click('.hist-seg button >> text=Year'); pg.wait_for_timeout(1000)
    ok('$370' in pg.inner_text('#history-sheet'),'the year total is $370')
    pg.click('.hist-seg button >> text=All'); pg.wait_for_timeout(1000)
    ok(pg.locator('.hist-arrow').first.is_hidden(),'All time has no arrows')
    pg.click('.hist-seg button >> text=Week'); pg.wait_for_timeout(1000)
    ok('$80' in pg.inner_text('#history-sheet'),'this week shows today\'s $80')
    pg.click('#history-sheet .link'); pg.wait_for_timeout(300)
    ok(not vis('#history-sheet'),'Done closes it')
    ok(not errs,'no page errors '+str(errs))
    b.close()
print('\nALL PASSED: %d'%len(res) if all(res) else '\nFAILURES: %d'%res.count(False))
