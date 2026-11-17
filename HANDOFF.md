# My spending: handoff for the next Claude session

Owner: John Pradeepraj. GitHub, Vercel and Railway are all on the account **johnpradeep06**.
The code is finished and tested. This session's job is to publish it and deploy it.

## What this is
A private Apple Pay spending tracker that is being opened up to friends.
- A friend opens the app, taps **Create an account** with an email and password (Google sign-in was removed; passwords are stored as scrypt hashes, 5 wrong tries lock the account for 15 minutes).
- The app shows a private **setup code**. They paste it into ONE iPhone Shortcut.
- The Shortcut sends each Apple Pay purchase to `POST /api/log` with `Authorization: Bearer <setup code>`.
- The app shows spending, a line graph against the daily average, a daily limit, and push alerts
  (over-average alert after a purchase, 8 AM morning note, 9 PM summary).
- Every user only sees their own data.

## Layout
- `public/`  The installable web app (plain JS, no build step). `sw.js` is the service worker.
- `api/index.js`  ONE serverless function. `vercel.json` rewrites `/api/:path*` to `/api/index?route=:path*`.
- `lib/db.js`  Postgres access through `q(text, params)`. Tables are created automatically on first query.
  Uses `@neondatabase/serverless`. For Railway Postgres, swap this one file to the `pg` package
  (keep `q()` and `setTestDb()` the same; use a small pool, for example max 1 to 3, because it runs on serverless).
- `lib/compute.js`, `lib/notes.js`  Shared spending maths and notification text. They load `public/calcs.js`,
  `runtime.js` and `loader.js` in a Node `vm`, so the alerts match the app exactly.
- `vercel.json`  Rewrites, security headers (CSP), and 4 cron schedules that call `/api/cron`.
- `test/server.test.js`  Server tests on in-memory Postgres (PGlite). Run `npm install` then `npm test`.
- `test/e2e.py`, `test/dev.js`  Browser test against a local dev server (needs Playwright and Chrome).
- `jose` and `web-push` are ESM-only and are loaded with dynamic `import()`. Do not change them to `require()`.

## Environment variables (names only; none are in this zip)
| Name | How to get it |
|---|---|
| `DATABASE_URL` | Postgres connection string (Neon, or Railway Postgres) |
| `SESSION_SECRET` | `openssl rand -hex 32` |
| `DATA_KEY` | `openssl rand -hex 32`. Encrypts purchase text in the database (see below). **Keep a copy somewhere safe, outside Vercel: without it the encrypted purchases cannot be read.** |
| `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` | Optional. Switches on **Scan the bill**: an AI vision model reads a photo of a bill. Without either key the button never appears and nothing else changes. Anthropic wins if both are set. |
| `BILL_MODEL`, `BILL_DAILY_LIMIT` | Optional. The vision model (default `claude-haiku-5-5` or `gemini-2.5-flash`) and the most bills one person can scan a day (default 10). |
| `CRON_SECRET` | `openssl rand -hex 32` (Vercel Cron sends it automatically as a Bearer token) |
| `ADMIN_SECRET` | `openssl rand -hex 32` (used once to import John's old purchases) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | `npx web-push generate-vapid-keys` |
| `SITE_URL` | The final https address of the deployed app, with no trailing slash |

No users exist yet, so fresh secrets are fine. Never commit them.

## Scan the bill
- A person taps a purchase, then **Scan the bill**, and takes a photo. The browser shrinks it and re-saves it as a plain JPEG
  (which drops any location data), and sends it once to `POST /api/bills/scan`. The server asks the AI model (`lib/vision.js`)
  for the items, then `lib/bills.js` re-reads every number, drops lines that are not items (tax, total, card, change), forces
  alcohol and everything bought at the SAQ to unnecessary, applies what the person decided about the same product before, and
  checks that the items plus tax add up to the purchase. **The photo is never stored.**
- The person reviews the items, taps any to flip necessary / unnecessary, and saves (`PUT /api/purchases/:id/items`). Item names
  are stored encrypted (`bill_items`); the amount paid is shared over the items so the pieces add up exactly. A scanned purchase
  counts in Where money leaks by its items instead of as a whole.
- Limits: `BILL_DAILY_LIMIT` bills per person per day. Tests use a pretend reader (`api._test.setBillReader`), so no key is needed.
- **Free and private option: the Apple Shortcut "Scan bill".** The iPhone reads the text off the photo itself (Scan Documents, then
  Extract Text from Image) and posts it to `POST /api/bills/text` with the setup code. `lib/billtext.js` turns it into items with rules
  (no AI, nothing leaves the server), `lib/itemkinds.js` guesses necessary / unnecessary in French and English, the bill is matched to
  the purchase with the same total, and it waits as an encrypted draft (`bill_drafts`) that the person checks in the app.
  The parser is tested on realistic French bills; tune it on real phone output if a layout is misread.
- The prompt in `lib/vision.js` has not been tuned against real Montreal bills yet. Try a few and adjust it.

## Free to spend (pay period)
The person enters their paycheck, last payday and how often they are paid (one short screen). The card shows
**paycheck - spent since payday**, the days to payday and an amount per day. It is the third page of the Clean hero
(each person chooses which hero pages show, in Settings); Fresh and Arcade show it as a card.
- Fixed bills (rent, utilities) were built and then removed because they confused people: a bill paid with Apple Pay was
  counted twice. The server ignores any bills list (an older plan's stored bills are dropped when read). Purchases in the
  Bills & Utilities category are shown as their own line ("Bills & utilities you paid") inside spending.
  `public/payperiod.js` still has the bill maths (spread over the paychecks of a year); it is simply unused by the app.
- Maths: `public/payperiod.js` (pure; the server and tests load the same file). Tests: `node test/payperiod.test.js`.
- Server: `GET/PUT/DELETE pay`, `POST pay/paid` in `api/index.js`. The plan is one small sealed value per person
  (`pay_plans.data`, field name `pay`), so it is encrypted once DATA_KEY is set. Spending since payday comes from the
  same purchase rules as everything else (`compute.summary(...).rows`); deleted purchases do not count.
- App: `public/payui.js` (card, setup sheet, "Got paid" sheet), `public/pay.css` (all three looks), `public/hero.js`
  (the third hero page and the page chooser). On payday the card asks "Did you get paid?"; the new period starts on the
  day the person says, not automatically.
- Browser tests: `python3 test/pay_e2e.py`, `python3 test/hero_pages_e2e.py` (against `node test/dev.js`).

## Your own categories (Rent, Phone, Daycare...)
A person can make up to 20 categories of their own: a name (24 characters), an icon and whether it is necessary, not sure
or unnecessary. They can also say "use it for this store every time" (a store rule: store key -> category).
- Storage: `user_cats.data`, one sealed value per person (field name `cats`): `{ cats: [{name, icon, kind}], rules: {storeKey: name} }`.
  Routes `GET/PUT categories` in `api/index.js` (the whole list is sent each time; checks in `lib/customcats.js`).
- The sums: `public/calcs.js` reads `window.spendCustom` (a manual category that is one of theirs is kept; a store rule
  puts a store's payments there; the kind decides green/orange/grey). In the app `public/cats.js` sets it; on the server
  `compute.withCustom(custom, fn)` sets it around each calculation, so alerts, history and Free to spend agree.
- UI: `public/cats.js` + `public/cats.css` (picker entries on the Edit payment sheet, "+ New category", the sheet,
  Settings > My categories). Deleting a category never deletes a payment: they go back to the app's usual guess.
- Remembered stores: picking a category on a payment (Edit payment) remembers it for that store (`rules` + `ruleNames`, built-in
  categories allowed): every payment at that store goes there, earlier ones too, but never one picked by hand. Shown as "· remembered";
  listed under Settings > My categories > "Stores it remembers" with Forget. Beats the AI's guess.
- Not built: renaming (delete and make again), a monthly limit per category.
- Tests: server tests ("your own categories"), `python3 test/cats_e2e.py`.

## AI categories (Gemini) - owner-controlled
Stores the app's own rules cannot place (`how === 'none'`) are sent to Google's Gemini, and the answer is remembered. It
is a feature the **owner switches on per person** (People & invites > "AI: on/off"); the owner always has it. Nothing is
sent for anyone who does not have it.
- Models: `lib/gemini.js` is the one place that calls Gemini. Cheapest first (Flash-Lite: free tier, fewest tokens); when a name answers 404 (Google retires
  names) the next is tried, and if all are gone it asks Google's model list and uses the newest stable `gemini-N-flash-lite`. `CATEGORY_MODEL` /
  `BILL_MODEL` pin one model instead.
- Switched on by `GEMINI_API_KEY` on the server (the same key can read bills). Optional: `CATEGORY_MODEL` (default
  `gemini-2.5-flash-lite`), `AI_DAILY_LIMIT` (stores per person per day, default 40), `AI_GLOBAL_DAILY` (whole app, default 300).
  Set them in Vercel's environment settings; never in chat or code.
- What is sent: ONLY store names (a few at a time) and the category list. No amount, date, card or person. Names are sent as a
  JSON list (data, not instructions). Each answer must be one of the app's own categories or it becomes "Other"
  (`lib/storeai.js`). Tests fake the network and check exactly what leaves the server.
- Answers are per person (`user_ai`, one sealed value, field `ai`), never shared between people, so one person's stores are
  never visible to another. A store is asked about once. The person's own choices (a category picked by hand, a store rule,
  their own categories) always win over the AI.
- Server: `POST ai/categorize` (403 unless switched on, 429 past the allowances), `POST owner/people/:id/ai-on|ai-off`,
  `GET me` carries `ai: { enabled }` and the person's answers come inside `categories.ai`. Calculations read them via
  `window.spendCustom.ai` (`public/calcs.js`); `public/ai.js` asks for the unplaced stores once the app has data.
- The AI **bill photo reader** (POST bills/scan) follows the same per-person switch: a photo goes to an AI company, so people without AI
  get only the Shortcut route (the bill is read on their phone). `GET me` carries `ai.bills`; `GET config` no longer decides who sees it.
- A purchase categorized by the AI says "AI guess" in its line. Tests: server tests ("AI categories"), `python3 test/ai_e2e.py`.

## Encryption of purchase text
- Every purchase's title and details are stored encrypted (AES-256-GCM, `lib/vault.js`), so a leaked database or backup
  shows nothing readable. Only the server, holding `DATA_KEY`, can open them. Amounts, merchants and cards are inside that text.
- Each value is tied to its owner and its column, so it cannot be copied onto someone else's purchase.
- Old plain text rows still read fine. With no `DATA_KEY`, new rows are stored as plain text and the app keeps working; an
  encrypted row with no key is refused, never shown as gibberish. A key shorter than 32 characters is ignored (and logged).
- Move existing rows over once, after the key is set and this code is live: `tools/encrypt-purchases.js`
  (looks only by default; `--apply` changes rows; `--apply --decrypt` undoes it; see the comments at the top of the file).
- Changing the key: put the old one in `DATA_KEY_PREV`, set the new `DATA_KEY`, run the tool with `--apply --rekey`, then remove `DATA_KEY_PREV`.
- The key is separate from `SESSION_SECRET`, so changing the sign-in secret never touches stored purchases.

## Do these in order
1. Unzip, run `npm install` and `npm test` (expect all passing). Then `git init`, commit, and push to a
   **private** repo `johnpradeep06/my-spending` on branch `main`. `.gitignore` already excludes secrets and `node_modules`.
2. Vercel: create a project from that repo (Node 24.x, region `yul1` is fine). Set every variable above.
   A project named `my-spending` already exists on John's Vercel team without a Git link and with older
   variable values. It is fine to reuse it by connecting the repo in Settings, Git, or to make a new one.
3. Database: create Postgres on Railway or Neon, and set `DATABASE_URL`. If it is Railway, swap `lib/db.js` to `pg` first
   and keep the tests passing.
4. Railway: connect the same repo. The app itself runs on Vercel, so on Railway only the database is required
   unless John asks to run the API there too.
5. (Google sign-in was removed. Nothing to set up in Google Cloud.)
6. Test live: open the app, create an account, copy the setup code, then
   `curl -X POST $SITE_URL/api/log -H "Authorization: Bearer <code>" -H "Content-Type: application/json" -d '{"merchant":"Test","amount":"1.00","card":"Test","category":"Other"}'`.
7. Import John's old purchases (his GitHub issues from `Cyril-praveen/spend-data`, 4 so far) with
   `POST /api/admin/import` and `Authorization: Bearer <ADMIN_SECRET>`, body `{ "email": "<his account email>", "issues": [...], "dailyLimit": <number or null> }`.
   He must create his account in the app first (use the same email).
8. Put the final iCloud link of the combined Shortcut into `SHORTCUT_URL` in `public/main.js` (empty for now), then redeploy.

## Notes
- The combined Shortcut ("Log purchase") accepts both Wallet-tap fields (merchant, amount, card, category) and
  Wallet-notification fields (title, subtitle, body). The server's `fromShortcut` already handles both shapes.
- Open question for John: a weekly spending cap, either one total or one per category, Monday to Sunday.
- The old version is a GitHub Pages app (`Cyril-praveen/spend-app`, branch `main`). Do not change it.
- Delete this file once the work is done.
