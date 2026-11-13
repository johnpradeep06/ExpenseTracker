# Browser test of the whole new-user journey against test/dev.js. Run: python3 test/e2e.py
import json, urllib.request
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8790'
def sign(page, email, password, up=False):
    if up:
        page.click('#auth-toggle')
        page.fill('#auth-invite', http('POST', '/api/admin/invites', {}, auth='dev-admin')[1]['code'])
    page.fill('#auth-email', email); page.fill('#auth-password', password)
    page.click('#auth-submit')

PUSH_STUB = """
(() => {
  Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });
  window.PushManager = function () {};
  let perm = 'default';
  window.Notification = { get permission() { return perm; }, requestPermission: async () => { perm = 'granted'; return perm; } };
  let current = null;
  const reg = { pushManager: {
    getSubscription: async () => current,
    subscribe: async (o) => { current = { endpoint: 'https://web.push.apple.com/test-phone', options: { applicationServerKey: o.applicationServerKey.buffer }, toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'p', auth: 'a' } }; }, unsubscribe: async () => { current = null; return true; } }; return current; } } };
  Object.defineProperty(navigator, 'serviceWorker', { value: { ready: Promise.resolve(reg), register: async () => reg, addEventListener() {} }, configurable: true });
})();
"""

def http(method, path, body=None, auth=None):
    req = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={'Content-Type': 'application/json', **({'Authorization': 'Bearer ' + auth} if auth else {})})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or b'null')
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b'null')

passed = 0
def ok(cond, label):
    global passed
    assert cond, label
    passed += 1
    print('  ok', label)

P = sync_playwright().start()
b = P.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, has_touch=True,
                    user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148')
ctx.grant_permissions(['clipboard-read', 'clipboard-write'], origin=BASE)
pg = ctx.new_page(); errs = []
pg.on('pageerror', lambda e: errs.append(str(e)))
t = lambda s: pg.locator(s).inner_text().replace('\n', ' / ')
vis = lambda s: pg.locator(s).is_visible()

# 1. New friend opens the app in Safari
pg.goto(BASE + '/'); pg.wait_for_timeout(600)
ok(vis('#signin') and not vis('#app'), 'sign-in page first')
ok(vis('#install-tip'), 'iPhone in Safari gets the Add to Home Screen tip')
pg.screenshot(path='/tmp/e2e-signin.png')
sign(pg, 'ana@example.com', 'ana-password-1', up=True); pg.wait_for_timeout(1200)
ok(vis('#tour') and not vis('#onboard'), 'a new person starts with the app tour')
ok('1 of 4' in t('#tour-count'), 'tour shows its progress')
pg.screenshot(path='/tmp/e2e-tour.png')
for _ in range(3): pg.click('#tour-next'); pg.wait_for_timeout(120)
ok('4 of 4' in t('#tour-count') and 'Set up my Shortcuts' in t('#tour-next'), 'last tour card leads to Shortcut setup')
pg.click('#tour-back'); pg.wait_for_timeout(120); ok('3 of 4' in t('#tour-count'), 'tour Back works')
pg.click('#tour-skip'); pg.wait_for_timeout(900)
ok(vis('#onboard') and not vis('#tour'), 'Skip goes to the Connect your iPhone page')
code = pg.inner_text('#setup-code')
ok(code.startswith('sp_'), 'setup code shown')
pg.click('#copy-code'); pg.wait_for_timeout(200)
ok(pg.evaluate('navigator.clipboard.readText()') == code, 'copy button copies the code')
pg.click('#wiz-next'); pg.wait_for_timeout(150)
ok('500cbb0903604c33a92973012fe0b1ed' in (pg.get_attribute('#tap-link', 'href') or '') and vis('#tap-link'), 'tap Shortcut link is on its setup step')
pg.click('#wiz-next'); pg.click('#wiz-next'); pg.wait_for_timeout(150)
ok('b7315a1815c944479b2022f220bb2e3d' in (pg.get_attribute('#notif-link', 'href') or '') and vis('#notif-link'), 'online Shortcut link is on its setup step')
for _ in range(3): pg.click('#wiz-next'); pg.wait_for_timeout(100)
ok('Turn Automation on' in pg.inner_text('#onboard'), 'setup guide explains turning Automation on')
pg.click('#wiz-next'); pg.wait_for_timeout(150)
ok('Waiting for your first purchase' in t('#first-status'), 'setup page waits for the first purchase')
pg.screenshot(path='/tmp/e2e-onboard.png', full_page=True)

# 2. The Shortcut sends purchases (tap + the Wallet alert for the same payment, then another)
s, r = http('POST', '/api/log', {'merchant': 'Tim Hortons', 'amount': '12.40', 'card': 'Visa', 'category': 'Dining & Coffee'}, auth=code)
ok(s == 200 and r['ok'] and '$12.40 spent today' in r['message'], 'Shortcut tap logged: ' + r['message'])
s, r = http('POST', '/api/log', {'source': 'wallet', 'title': 'Visa', 'subtitle': 'TIM HORTONS #1234', 'body': '$12.40'}, auth=code)
ok(s == 200, 'Shortcut Wallet alert logged: ' + r['message'])
http('POST', '/api/log', {'merchant': 'Adonis', 'amount': '$85.02', 'card': 'Amex'}, auth=code)
pg.wait_for_timeout(6500)
ok('It works' in t('#first-status') and 'Got ' in t('#first-status'), 'the setup page notices the first purchase: ' + t('#first-status'))
pg.screenshot(path='/tmp/e2e-onboard-done.png', full_page=True)
pg.click('#onboard-done'); pg.wait_for_timeout(900)
ok(vis('#app'), 'Done -> the spending app')
ok(t('[data-draw=h_amt]').replace(' ', '') in ('$97.42',), 'total counts the tap+Wallet pair once: ' + t('[data-draw=h_amt]'))
ok(pg.locator('#acct-email').text_content() == 'ana@example.com', 'account email shown in settings')
pg.screenshot(path='/tmp/e2e-app.png')

# 3. Daily limit from the top button
pg.click('#limit-open'); pg.fill('#limit-input', '50'); pg.click('#limit-save'); pg.wait_for_timeout(600)
ok('$50' in t('#limit-open'), 'limit set from the top button: ' + t('#limit-open'))
ok('over today' in t('#hero14 .avg-note'), 'chart says over today: ' + t('#hero14 .avg-note').split(' / ')[0])

# 4. Add, edit, delete, undo a payment by hand
pg.click('#add-open'); pg.fill('#add-merchant', 'Metro'); pg.fill('#add-amount', '10'); pg.click('#add-save'); pg.wait_for_timeout(800)
ok('Added $10.00 at Metro' in t('#toast-text'), 'manual add')
rows = lambda: [x.replace('\n', ' | ') for x in pg.locator('[data-draw=tx] .tx').all_inner_texts()]
ok(any('Metro' in x for x in rows()), 'Metro listed')
pg.locator('[data-draw=tx] .tx', has_text='Metro').first.click(); pg.wait_for_timeout(300)
pg.fill('#add-amount', '11.5'); pg.click('#add-save'); pg.wait_for_timeout(800)
ok(any('Metro' in x and '$11.50' in x for x in rows()), 'edit saved')
pg.click('#toast-undo'); pg.wait_for_timeout(900)
ok(any('Metro' in x and '$10.00' in x for x in rows()), 'undo edit')
pg.locator('[data-draw=tx] .tx', has_text='Metro').first.click(); pg.wait_for_timeout(300)
pg.click('#add-delete'); pg.click('#add-delete'); pg.wait_for_timeout(800)
ok(not any('Metro' in x for x in rows()), 'delete')
pg.click('#toast-undo'); pg.wait_for_timeout(900)
ok(any('Metro' in x for x in rows()), 'undo delete')

# 5. Alerts on (phone push faked)
pg2 = ctx.new_page(); pg2.on('pageerror', lambda e: errs.append(str(e)))
pg2.add_init_script(PUSH_STUB)
pg2.goto(BASE + '/'); pg2.wait_for_timeout(800)
pg2.click('#settings-open')
pg2.click('#alerts-on'); pg2.wait_for_timeout(800)
ok('Alerts are on' in pg2.inner_text('#alerts-text'), 'alerts turned on')
pushes = json.loads(urllib.request.urlopen(BASE + '/__pushes').read())
ok(pushes and pushes[-1]['title'] == 'Spending alerts are on', 'welcome push sent to the phone')
http('POST', '/api/log', {'merchant': 'Cineplex', 'amount': '20'}, auth=code)
pushes = json.loads(urllib.request.urlopen(BASE + '/__pushes').read())
ok(pushes[-1]['title'].startswith('Still over') or pushes[-1]['title'].startswith('Over'), 'over-limit alert pushed: ' + pushes[-1]['body'])
pg2.close()

# 6. Offline: saved copy shown
pg.route('**/api/**', lambda route: route.abort())
pg.click('.sp-refresh'); pg.wait_for_timeout(800)
ok(vis('#offline-note') and t('[data-draw=h_amt]') != '—', 'offline shows the saved copy')
pg.unroute('**/api/**')
pg.click('.sp-refresh'); pg.wait_for_timeout(800)
ok(not vis('#offline-note'), 'back online')

# 7. Another person sees nothing of Ana's
pg3 = b.new_context(viewport={'width': 390, 'height': 844}).new_page()
pg3.goto(BASE + '/'); pg3.wait_for_timeout(500); sign(pg3, 'bo@example.com', 'bo-password-1', up=True); pg3.wait_for_timeout(1200)
pg3.click('#tour-skip'); pg3.wait_for_timeout(800); pg3.click('#onboard-done'); pg3.wait_for_timeout(800)
ok(pg3.inner_text('[data-draw=h_amt]').replace('\n', '') == '$0.00', 'Bo sees $0.00, none of Ana\'s data')

# 7a. The tour can be opened again from Settings
pg.click('#settings-open'); pg.wait_for_timeout(400); pg.click('#tour-open'); pg.wait_for_timeout(500)
ok(vis('#tour') and not vis('#app'), 'App tour opens again from Settings')
for _ in range(3): pg.click('#tour-next'); pg.wait_for_timeout(100)
ok('Done' in t('#tour-next'), 'tour from Settings ends with Done')
pg.click('#tour-next'); pg.wait_for_timeout(900)
ok(vis('#app') and not vis('#tour'), 'Done returns to the app')

# 7a2. The saving game is switched off for everyone by default
pg.click('#settings-open'); pg.wait_for_timeout(400); pg.click('.theme-pick button[data-theme=candy]'); pg.wait_for_timeout(300); pg.click('#settings-close'); pg.wait_for_timeout(1500)
ok(not vis('#game') and not vis('#collect-btn') and not vis('#goal-open'), 'the saving game is hidden (switched off), even in the Fresh theme')
ok(vis('#pet') and vis('.jar'), 'Penny and the candy jar are still there in Fresh')
pg.click('#settings-open'); pg.wait_for_timeout(400); pg.click('.theme-pick button[data-theme=clean]'); pg.wait_for_timeout(300); pg.click('#settings-close'); pg.wait_for_timeout(500)

# 7b. Owner tools: invites, people, removing access
pg3.click('#settings-open'); pg3.wait_for_timeout(500)
ok(not pg3.locator('#people-open').is_visible(), 'a normal person does not see People & invites')
pg3.click('#settings-close'); pg3.wait_for_timeout(300)
pg.click('#settings-open'); pg.wait_for_timeout(600)
ok(vis('#people-open'), 'the owner sees People & invites in Settings')
pg.click('#people-open'); pg.wait_for_timeout(700)
ok(vis('#people-sheet') and not vis('#settings-sheet'), 'People & invites opens')
ok('ana@example.com' in t('#people-list') and 'You (owner)' in t('#people-list'), 'owner is listed as you')
pg.fill('#inv-note', 'For Di'); pg.click('#inv-create'); pg.wait_for_timeout(900)
code2 = pg.inner_text('#inv-code')
ok(code2.startswith('inv_') and vis('#inv-result'), 'invite created and shown')
ok('For Di' in t('#invites-list'), 'new invite is listed as waiting')
pg.screenshot(path='/tmp/e2e-people.png')
ctx4 = b.new_context(viewport={'width': 390, 'height': 844})
pg4 = ctx4.new_page(); pg4.on('pageerror', lambda e: errs.append(str(e)))
pg4.goto(BASE + '/?invite=' + code2); pg4.wait_for_timeout(600)
ok(pg4.locator('#invite-field').is_visible() and pg4.input_value('#auth-invite') == code2, 'an invite link opens sign-up with the code filled in')
ok('invite=' not in pg4.url, 'the code is removed from the address bar')
pg4.fill('#auth-email', 'di@example.com'); pg4.fill('#auth-password', 'di-password-1'); pg4.click('#auth-submit'); pg4.wait_for_timeout(1300)
ok(pg4.locator('#tour').is_visible(), 'Di creates an account with the invite and starts with the tour')
pg4.click('#sign-out') if False else None
code_again = http('POST', '/api/auth/signup', {'email': 'x@example.com', 'password': 'xx-password-1', 'invite': code2})
ok(code_again[0] == 403, 'the same invite cannot be used twice')
pg.click('#people-close'); pg.wait_for_timeout(200); pg.click('#settings-open'); pg.wait_for_timeout(400); pg.click('#people-open'); pg.wait_for_timeout(800)
ok('di@example.com' in t('#people-list'), 'Di now shows under people with access')
di_btn = pg.locator('#people-list .person', has_text='di@example.com').locator('button').last
di_btn.click(); pg.wait_for_timeout(200)
ok('Tap again' in di_btn.inner_text(), 'removing asks twice')
di_btn.click(); pg.wait_for_timeout(900)
ok('Access removed' in t('#people-list'), 'Di shows as removed')
ok(http('POST', '/api/auth/login', {'email': 'di@example.com', 'password': 'di-password-1'})[0] == 403, 'Di can no longer sign in')
pg.locator('#people-list .person', has_text='di@example.com').locator('button').last.click(); pg.wait_for_timeout(900)
ok(http('POST', '/api/auth/login', {'email': 'di@example.com', 'password': 'di-password-1'})[0] == 200, 'restoring lets Di sign in again')
pg.click('#signups-toggle'); pg.wait_for_timeout(700)
ok('Off' in t('#signups-state'), 'signups switched off')
ok(http('POST', '/api/auth/signup', {'email': 'y@example.com', 'password': 'yy-password-1', 'invite': http('POST', '/api/admin/invites', {}, auth='dev-admin')[1]['code']})[0] == 403, 'with signups off a good invite is refused')
pg.click('#signups-toggle'); pg.wait_for_timeout(700)
ok('On' in t('#signups-state'), 'signups switched back on')
pg.evaluate("document.querySelector('#people-sheet').dispatchEvent(new Event('touchstart'))")
pg.click('#people-close'); pg.wait_for_timeout(300)
ok(not vis('#people-sheet'), 'Done closes People & invites')
ctx4.close()

# 8. Sign out everywhere kicks old sessions; sign back in skips setup
pg.click('#settings-open')
pg.click('#sign-out-all'); pg.wait_for_timeout(700)
ok(vis('#signin') and 'every phone' in t('#signin-error'), 'signed out everywhere')
ok(pg.evaluate("localStorage.getItem('spend.cache')") is None, 'saved copy removed on sign-out')
sign(pg, 'ana@example.com', 'ana-password-1'); pg.wait_for_timeout(1200)
ok(vis('#app'), 'returning person goes straight to the app')

# 9. Delete account
pg.click('#settings-open')
pg.click('#delete-account'); pg.wait_for_timeout(200)
ok('cannot be undone' in t('#acct-note'), 'delete asks first')
pg.click('#delete-account'); pg.wait_for_timeout(800)
ok(vis('#signin') and 'deleted' in t('#signin-error'), 'account deleted')
left = json.loads(urllib.request.urlopen(urllib.request.Request(BASE + '/__sql', data=b"select (select count(*) from users where email='ana@example.com')::int u, (select count(*) from purchases)::int p, (select count(*) from devices)::int d", method='POST')).read())[0]
ok(left == {'u': 0, 'p': 0, 'd': 0}, 'Ana\'s account, purchases and phone are gone: ' + json.dumps(left))
s, r = http('POST', '/api/log', {'merchant': 'X', 'amount': '1'}, auth=code)
ok(s == 401, 'her old setup code no longer works')

ok(not errs, 'no page errors ' + json.dumps(errs))
print('\nALL PASSED:', passed)
b.close(); P.stop()
