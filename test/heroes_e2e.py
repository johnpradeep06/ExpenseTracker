# Browser test of the Heroes screen against test/dev.js. Run: python3 test/heroes_e2e.py
import json, datetime, urllib.request as u
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:8790'
H={'Authorization':'Bearer dev-admin','Content-Type':'application/json'}
post=lambda path,body: json.loads(u.urlopen(u.Request(BASE+path, data=json.dumps(body).encode(), headers=H, method='POST')).read())
now=datetime.datetime.now(); issues=[]
for ago,a in [(3,10),(2,12),(1,15)]:
    t=(now-datetime.timedelta(days=ago)).replace(hour=13,minute=0,second=0,microsecond=0).astimezone(datetime.timezone.utc)
    iso=t.strftime('%Y-%m-%dT%H:%M:%SZ'); amt=f"{a:.2f}"
    issues.append({"title":f"Spending - ${amt} - {iso[:10]} - Groceries","body":f"Date: {iso}\nMerchant: Metro\nAmount: ${amt}\nCard: Visa\nCategory: Groceries","state":"open","created_at":iso})
res=[]; errs=[]
def ok(c,l): res.append(bool(c)); print(('  ok ' if c else '  FAIL ')+l)
with sync_playwright() as P:
    b=P.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
    ctx=b.new_context(viewport={'width':390,'height':844},device_scale_factor=2,has_touch=True)
    pg=ctx.new_page(); pg.on('pageerror',lambda e: errs.append(str(e)))
    vis=lambda s: pg.locator(s).is_visible()
    pg.goto(BASE+'/?invite='+post('/api/admin/invites',{})['code']); pg.wait_for_timeout(500)
    pg.fill('#auth-email','hero@example.com'); pg.fill('#auth-password','hero-preview-pw-1'); pg.click('#auth-submit'); pg.wait_for_timeout(1200)
    post('/api/admin/import',{"email":"hero@example.com","issues":issues,"dailyLimit":50})
    pg.click('#tour-skip'); pg.wait_for_timeout(900); pg.click('#onboard-done'); pg.wait_for_timeout(1500)
    pg.click('#settings-open'); pg.wait_for_timeout(400)
    ok(vis('#heroes-open'),'Settings has a Heroes row')
    pg.click('#heroes-open'); pg.wait_for_timeout(500)
    ok(vis('#heroes-sheet') and not vis('#settings-sheet'),'Heroes sheet opens, Settings closes')
    ok(pg.locator('.hx-card').count()==8,'8 heroes listed')
    ok(pg.locator('.hx-card.on').count()==1 and 'Captain' in pg.inner_text('.hx-card.on'),'Captain Penny is chosen by default')
    ok(pg.locator('.hx-card.locked').count()>=4,'later heroes are locked behind streaks')
    pg.screenshot(path='/tmp/claude-0/heroes-sheet.png')
    # force-unlock and pick Hulk
    pg.evaluate("localStorage.setItem('spend.best','30')"); pg.click('#heroes-sheet .link'); pg.wait_for_timeout(300)
    pg.click('#settings-open'); pg.wait_for_timeout(300); pg.click('#heroes-open'); pg.wait_for_timeout(400)
    ok(pg.locator('.hx-card.locked').count()==0,'all unlocked with a 30-day best streak')
    pg.locator('.hx-card',has_text='Hulk').click(); pg.wait_for_timeout(1000)
    ok(pg.evaluate("localStorage.getItem('spend.hero')")=='hulk-hog','choice saved on this phone')
    ok(pg.locator('.hx-stage.hx-smash').count()==1,'the power plays after choosing')
    pg.screenshot(path='/tmp/claude-0/hero-play.png')
    pg.wait_for_timeout(2600); ok(pg.locator('.hx-stage').count()==0,'the animation cleans itself up')
    pg.evaluate("window.spendHeroPlay('doctor-doom-pig')"); pg.wait_for_timeout(1500)
    ok(pg.locator('.hx-stage.hx-doom').count()==1,'Doom Pig boss plays'); pg.screenshot(path='/tmp/claude-0/hero-doom.png')
    ok(not errs,'no page errors '+str(errs))
    b.close()
print('\nALL PASSED: %d'%len(res) if all(res) else '\nFAILURES: %d'%res.count(False))
