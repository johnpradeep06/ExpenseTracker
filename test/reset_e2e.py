# Browser test of password reset and change password against test/dev.js. Run: python3 test/reset_e2e.py
import json, urllib.request as u
from playwright.sync_api import sync_playwright
BASE='http://127.0.0.1:8790'
H={'Authorization':'Bearer dev-admin','Content-Type':'application/json'}
post=lambda path,body: json.loads(u.urlopen(u.Request(BASE+path, data=json.dumps(body).encode(), headers=H, method='POST')).read())
res=[]; errs=[]
def ok(c,l): res.append(bool(c)); print(('  ok ' if c else '  FAIL ')+l)
def sign_up(pg,email,pw):
    pg.goto(BASE+'/?invite='+post('/api/admin/invites',{})['code']); pg.wait_for_timeout(500)
    pg.fill('#auth-email',email); pg.fill('#auth-password',pw); pg.click('#auth-submit'); pg.wait_for_timeout(1200)
    pg.click('#tour-skip'); pg.wait_for_timeout(800); pg.click('#onboard-done'); pg.wait_for_timeout(1200)
with sync_playwright() as P:
    b=P.chromium.launch(executable_path='/usr/bin/google-chrome',args=['--no-sandbox'])
    # owner phone
    octx=b.new_context(viewport={'width':390,'height':844},has_touch=True); og=octx.new_page(); og.on('pageerror',lambda e: errs.append(str(e)))
    sign_up(og,'ana@example.com','ana-password-1')
    # Lee's phone
    lctx=b.new_context(viewport={'width':390,'height':844},has_touch=True); lg=lctx.new_page(); lg.on('pageerror',lambda e: errs.append(str(e)))
    sign_up(lg,'lee@example.com','lee-password-1')
    # sign-in screen on a new phone: forgot password
    nctx=b.new_context(viewport={'width':390,'height':844},has_touch=True); ng=nctx.new_page(); ng.on('pageerror',lambda e: errs.append(str(e)))
    ng.goto(BASE+'/'); ng.wait_for_timeout(600)
    ok(ng.locator('#auth-forgot').is_visible(),'sign-in shows Forgot your password?')
    ng.click('#auth-forgot')
    ok(ng.locator('#reset-field').is_visible() and ng.inner_text('#auth-submit')=='Set new password' and not ng.locator('#auth-forgot').is_visible(),'reset form opens')
    ng.click('#auth-toggle'); ok(not ng.locator('#reset-field').is_visible() and ng.inner_text('#auth-submit')=='Sign in','Back to sign in works')
    # owner makes a reset code for Lee
    og.click('#settings-open'); og.wait_for_timeout(400); og.click('#people-open'); og.wait_for_timeout(800)
    ok(og.locator('#people-list button',has_text='Reset password').count()==1,'owner sees one Reset password button (not for self)')
    og.click('#people-list button >> text=Reset password'); og.wait_for_timeout(700)
    code=og.inner_text('#reset-code')
    ok(code.startswith('rst_') and og.locator('#reset-result').is_visible() and 'lee@example.com' in og.inner_text('#reset-for'),'owner gets a reset code for lee@example.com')
    og.screenshot(path='/tmp/claude-0/reset-owner.png')
    # Lee uses the code from a link on a new phone
    ng.goto(BASE+'/?reset='+code); ng.wait_for_timeout(600)
    ok(ng.locator('#reset-field').is_visible() and ng.input_value('#auth-reset')==code,'the reset link fills the code in')
    ng.fill('#auth-email','lee@example.com'); ng.fill('#auth-password','short'); ng.click('#auth-submit'); ng.wait_for_timeout(700)
    ok(ng.locator('#signin-error').is_visible() and '10' in ng.inner_text('#signin-error'),'a short new password is explained')
    ng.fill('#auth-password','lee-new-password-1'); ng.click('#auth-submit'); ng.wait_for_timeout(1800)
    ok(ng.locator('#app').is_visible() or ng.locator('#tour').is_visible() or ng.locator('#onboard').is_visible(),'Lee is signed in after the reset')
    # old password dead, new works (API)
    try: u.urlopen(u.Request(BASE+'/api/auth/login',data=json.dumps({'email':'lee@example.com','password':'lee-password-1'}).encode(),headers={'Content-Type':'application/json'},method='POST')); old=True
    except Exception: old=False
    ok(not old,'the old password stops working')
    # Lee's old phone was signed out
    lg.reload(); lg.wait_for_timeout(1500)
    ok(lg.locator('#signin').is_visible(),"Lee's old phone is signed out")
    # change password in Settings from the new phone
    ng.goto(BASE+'/'); ng.wait_for_timeout(1500)
    for sel in ['#tour-skip','#onboard-done']:
        try: ng.click(sel,timeout=700); ng.wait_for_timeout(500)
        except Exception: pass
    ng.click('#settings-open'); ng.wait_for_timeout(400)
    ng.click('#pw-open'); ok(ng.locator('#pw-form').is_visible(),'Change password opens a form')
    ng.fill('#pw-current','wrong-password-1'); ng.fill('#pw-new','lee-third-password-1'); ng.click('#pw-save'); ng.wait_for_timeout(800)
    ok('not right' in ng.inner_text('#pw-note'),'wrong current password is explained')
    ng.fill('#pw-current','lee-new-password-1'); ng.click('#pw-save'); ng.wait_for_timeout(1000)
    ok(not ng.locator('#pw-form').is_visible() and 'Password changed' in ng.inner_text('#acct-note'),'password changed')
    ng.screenshot(path='/tmp/claude-0/reset-settings.png')
    ok(ng.locator('#settings-sheet').is_visible(),'still signed in after changing it')
    ok(not errs,'no page errors '+str(errs))
    b.close()
print('\nALL PASSED: %d'%len(res) if all(res) else '\nFAILURES: %d'%res.count(False))
