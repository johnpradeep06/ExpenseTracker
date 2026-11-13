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
| `CRON_SECRET` | `openssl rand -hex 32` (Vercel Cron sends it automatically as a Bearer token) |
| `ADMIN_SECRET` | `openssl rand -hex 32` (used once to import John's old purchases) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | `npx web-push generate-vapid-keys` |
| `SITE_URL` | The final https address of the deployed app, with no trailing slash |

No users exist yet, so fresh secrets are fine. Never commit them.

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
