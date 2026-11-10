# Browser test of the saving game (Fresh theme) against test/dev.js. Run: python3 test/game_e2e.py
import json, datetime, urllib.request as u
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:8790'
H={'Authorization':'Bearer dev-admin','Content-Type':'application/json'}
post=lambda path,body: json.loads(u.urlopen(u.Request(BASE+path, data=json.dumps(body).encode(), headers=H, method='POST')).read())
now=datetime.datetime.now()
# (days ago, merchant, category, amount): a $50 limit; day -4 is over, day -2 has no spending
plan=[(6,'Lyft','Transport',30),(5,'Tim Hortons','Dining & Coffee',12),(4,'Amazon','Shopping',70),(3,'Metro','Groceries',18),(1,'Uber Eats','Dining & Coffee',25)]
issues=[]
for ago,m,c,a in plan:
    t=(now-datetime.timedelta(days=ago)).replace(hour=13,minute=0,second=0,microsecond=0).astimezone(datetime.timezone.utc)
    iso=t.strftime('%Y-%m-%dT%H:%M:%SZ'); amt=f"{a:.2f}"
    issues.append({"title":f"Spending - ${amt} - {iso[:10]} - {c}","body":f"Date: {iso}\nMerchant: {m}\nAmount: ${amt}\nCard: Visa\nCategory: {c}","state":"open","created_at":iso})
res=[]; errs=[]
def ok(c,l): res.append(bool(c)); print(('  ok ' if c else '  FAIL ')+l)
with sync_playwright() as P:
    b = P.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, has_touch=True, color_scheme='light')
    ctx.add_init_script("Date.prototype.getHours=function(){return 14}")
    pg = ctx.new_page(); pg.on('pageerror', lambda e: errs.append(str(e)))
    vis=lambda s: pg.locator(s).is_visible(); t=lambda s: pg.inner_text(s)
    pg.goto(BASE+'/?invite='+post('/api/admin/invites',{})['code']); pg.wait_for_timeout(500)
    pg.fill('#auth-email','saver@example.com'); pg.fill('#auth-password','saver-preview-pw-1'); pg.click('#auth-submit'); pg.wait_for_timeout(1200)
    post('/api/admin/import',{"email":"saver@example.com","issues":issues,"dailyLimit":50})
    pg.click('#tour-skip'); pg.wait_for_timeout(900); pg.click('#onboard-done'); pg.wait_for_timeout(1500)
    ok(not vis('#game'), 'Clean theme: no game')
    pg.click('#settings-open'); pg.wait_for_timeout(400); pg.click('.theme-pick button[data-theme=candy]'); pg.wait_for_timeout(300); pg.click('#settings-close'); pg.wait_for_timeout(1800)
    ok(vis('#game'), 'Fresh theme: the game shows on the total card')
    ok('Pick something' in t('#goal-name') and vis('#collect-btn'), 'no goal yet, and a Collect button')
    amt=t('#collect-amt'); ok('$165.00' in amt and '5 days' in amt.lower(), 'coins waiting: $165.00 over 5 days (' + amt + ')')
    ok('Lv 1' in t('#lvl-badge'), 'level 1')
    # set a goal
    pg.click('#goal-open', force=True); pg.wait_for_timeout(400)
    ok(vis('#goal-sheet'), 'tapping the goal opens the goal sheet')
    pg.locator('#emoji-pick button', has_text='✈️').click(); pg.fill('#goal-name-input','Japan trip'); pg.fill('#goal-amount-input','1000')
    pg.click('#goal-save'); pg.wait_for_timeout(900)
    ok(not vis('#goal-sheet') and 'Japan trip' in t('#goal-name') and '✈️' in t('#goal-emoji'), 'goal saved: ✈️ Japan trip')
    ok('$0.00 of $1,000' in t('#goal-sub'), 'goal line: $0.00 of $1,000 (' + t('#goal-sub') + ')')
    state=ctx.storage_state(); ctx.close()

    # the recording: collect coins, level up, golden coin, play with Penny
    v = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, has_touch=True, color_scheme='light', storage_state=state)
    v.add_init_script("Date.prototype.getHours=function(){return 14}")
    vp = v.new_page(); vp.on('pageerror', lambda e: errs.append(str(e)))
    rec=lambda sec: vp.wait_for_timeout(int(sec*1000))
    vp.goto(BASE+'/'); rec(4.6)                                  # hello, then "Coins waiting!"
    vp.click('#collect-btn', force=True); rec(5.5)                           # coins fly in, dance, level 2 + party hat
    ok(vp.inner_text('#lvl-badge')=='Lv 2' and vp.get_attribute('#pet','data-outfit')=='hat', 'collecting: level 2 and the party hat')
    ok('$165.00 of $1,000' in vp.inner_text('#goal-sub'), 'goal filled to $165.00 (' + vp.inner_text('#goal-sub') + ')')
    ok(not vp.locator('#collect-btn').is_visible() and vp.locator('#real-offer').is_visible(), 'Collect gone; the golden coin offer shows')
    vp.click('#real-btn', force=True); rec(5.0)                              # golden coin, level 3 + sunglasses
    ok(vp.inner_text('#lvl-badge')=='Lv 3' and vp.get_attribute('#pet','data-outfit')=='shades', 'golden coin: level 3 and sunglasses')
    ok(not vp.locator('#real-offer').is_visible(), 'the offer is used up')
    pet=vp.locator('#pet')
    pet.click(force=True); rec(1.2)                                         # tap: giggle + heart
    pet.dblclick(force=True); rec(1.4)                                      # double tap: spin
    box=pet.bounding_box(); vp.mouse.move(box['x']+40, box['y']+40); vp.mouse.down(); vp.wait_for_timeout(700); vp.mouse.up(); rec(2.6)   # hold: a tip
    v.close(); b.close()
    ok(not errs, 'no page errors ' + str(errs))
print('ALL PASSED' if all(res) else 'SOME FAILED', len(res))
if not all(res): raise SystemExit(1)
