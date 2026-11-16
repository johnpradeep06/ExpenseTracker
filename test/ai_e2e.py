# Browser test of AI categories: only for people the owner switches it on for. Run against test/dev.js: python3 test/ai_e2e.py
import json, datetime, urllib.request as u
from playwright.sync_api import sync_playwright
BASE = 'http://127.0.0.1:8790'
H = {'Authorization': 'Bearer dev-admin', 'Content-Type': 'application/json'}
post = lambda path, body: json.loads(u.urlopen(u.Request(BASE + path, data=json.dumps(body).encode(), headers=H, method='POST')).read())
now = datetime.datetime.now(datetime.timezone.utc)
issues = []
for n, m, a in [(1, 'Beau Soir', 3.99), (2, 'Chez Pierre', 24.5), (3, 'Zzyzx Unknown', 9.0), (4, 'Metro', 40.0)]:
    t = (now - datetime.timedelta(days=n)).replace(hour=15, minute=0, second=0).strftime('%Y-%m-%dT%H:%M:%SZ')
    issues.append({"title": f"Spending - ${a}", "body": f"Date: {t}\nMerchant: {m}\nAmount: ${a}\nCard: Visa\nCategory: Other", "state": "open", "created_at": t})
res, errs = [], []


def ok(c, l):
    res.append(bool(c))
    print(('  ok ' if c else '  FAIL ') + l)


def start(P, email, owner_page=None):
    ctx = P.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox']) if False else None
    return ctx


with sync_playwright() as P:
    b = P.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])

    def sign_up(email):
        ctx = b.new_context(viewport={'width': 390, 'height': 1000}, device_scale_factor=2, has_touch=True, is_mobile=True)
        ctx.add_init_script("try{localStorage.setItem('spend.alertsAsk',String(Date.now()))}catch(e){}")
        pg = ctx.new_page()
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(BASE + '/?invite=' + post('/api/admin/invites', {})['code']); pg.wait_for_timeout(500)
        pg.fill('#auth-email', email); pg.fill('#auth-password', 'ai-e2e-password-1'); pg.click('#auth-submit'); pg.wait_for_timeout(1000)
        post('/api/admin/import', {"email": email, "issues": issues, "dailyLimit": 0})
        pg.click('#tour-skip'); pg.wait_for_timeout(900); pg.click('#onboard-done'); pg.wait_for_timeout(3500)
        return pg

    row = lambda pg, name: pg.locator('#latest .tx-swipe .tx', has_text=name).first
    vis = lambda pg, s: pg.locator(s).is_visible()

    # ---- the owner (ana@example.com is OWNER_EMAIL in the local copy) ----
    own = sign_up('ana@example.com')
    own.wait_for_timeout(2500)
    t = row(own, 'Beau Soir').inner_text()
    ok('Groceries' in t and 'AI guess' in t, 'the owner\'s unknown store gets a category from the AI and says so: ' + t.replace('\n', ' | '))
    t = row(own, 'Chez Pierre').inner_text()
    ok('Dining' in t, 'another store is placed too: ' + t.replace('\n', ' | '))
    t = row(own, 'Zzyzx Unknown').inner_text()
    ok('Other' in t and 'AI guess' not in t, 'a store the AI does not know stays Other, with no label: ' + t.replace('\n', ' | '))
    t = row(own, 'Metro').inner_text()
    ok('Groceries' in t and 'AI guess' not in t, 'a store the app already knows is not sent to the AI (no label)')
    own.click('#settings-open'); own.wait_for_timeout(500)
    ok(vis(own, '#ai-note') and 'Only the store name is sent' in own.inner_text('#ai-note'), 'Settings tells the owner what AI categories do, and what is sent')
    ok('2 stores have' in own.inner_text('#ai-count'), 'and how many stores it sorted: ' + own.inner_text('#ai-count'))
    own.click('#settings-close'); own.wait_for_timeout(300)

    # ---- a friend: nothing, until the owner says so ----
    fr = sign_up('friend-ai-e2e@example.com')
    fr.wait_for_timeout(2500)
    t = row(fr, 'Beau Soir').inner_text()
    ok('Groceries' not in t and 'AI guess' not in t, 'the friend\'s same store is NOT categorized: ' + t.replace('\n', ' | '))
    fr.click('#settings-open'); fr.wait_for_timeout(500)
    ok(not vis(fr, '#ai-note'), 'and Settings shows them no AI note')
    ok(not fr.locator('#people-open').is_visible(), 'and they have no People screen')
    fr.click('#settings-close'); fr.wait_for_timeout(300)

    # ---- the owner switches it on for the friend ----
    own.click('#settings-open'); own.wait_for_timeout(400); own.click('#people-open'); own.wait_for_timeout(1500)
    btn = own.locator('#people-list .person', has_text='friend-ai-e2e@example.com').locator('button', has_text='AI')
    ok(btn.count() == 1 and 'AI: off' in btn.inner_text(), 'People shows an AI switch for the friend, off')
    ok(own.locator('#people-list .person', has_text='ana@example.com').locator('button', has_text='AI').count() == 0, 'and none for the owner, who always has it')
    btn.click(); own.wait_for_timeout(1500)
    btn = own.locator('#people-list .person', has_text='friend-ai-e2e@example.com').locator('button', has_text='AI')
    ok('AI: on' in btn.inner_text(), 'tapping switches it on for the friend')

    # ---- the friend now gets it ----
    fr.reload(); fr.wait_for_timeout(5000)
    t = row(fr, 'Beau Soir').inner_text()
    ok('Groceries' in t and 'AI guess' in t, 'the friend\'s store now gets its AI category: ' + t.replace('\n', ' | '))
    fr.click('#settings-open'); fr.wait_for_timeout(500)
    ok(vis(fr, '#ai-note'), 'and Settings now explains it to them')
    fr.click('#settings-close'); fr.wait_for_timeout(300)

    # ---- and off again ----
    btn.click(); own.wait_for_timeout(1500)
    fr.reload(); fr.wait_for_timeout(5000)
    t = row(fr, 'Beau Soir').inner_text()
    ok('AI guess' not in t and 'Groceries' not in t, 'switching it off takes the AI categories away again: ' + t.replace('\n', ' | '))
    # a category picked by hand always wins
    fr.evaluate("""async () => { await window.spendApi('POST', 'purchases', { title: 'Spending - $5 - Lumiere Studio - Shopping', body: 'Date: %s\\nMerchant: Lumiere Studio\\nAmount: $5.00\\nCard: Added by hand\\nCategory: Shopping\\nEntry: manual' }); await window.dash.reload(); }""" % now.strftime('%Y-%m-%dT%H:%M:%S+00:00'))
    fr.wait_for_timeout(2500)
    ok('Shopping' in row(fr, 'Lumiere Studio').inner_text(), 'a category picked by hand is kept')

    # ---- looks ----
    for look in ('candy', 'retro'):
        own.evaluate("l => { document.documentElement.classList.add(l); window.dash.render(); }", look); own.wait_for_timeout(600)
        ok('AI guess' in row(own, 'Beau Soir').inner_text(), '%s look: the AI label shows' % look)
        own.evaluate("l => { document.documentElement.classList.remove(l); window.dash.render(); }", look); own.wait_for_timeout(300)
    ok(not errs, 'no page errors' + ('' if not errs else ': ' + '; '.join(errs[:3])))
    b.close()
print('\nALL PASSED: %d' % len(res) if all(res) else '\nFAILED: %d of %d' % (len(res) - sum(res), len(res)))
raise SystemExit(0 if all(res) else 1)
