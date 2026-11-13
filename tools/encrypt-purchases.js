#!/usr/bin/env node
'use strict';
// One-time move of existing purchases from plain text to encrypted text (see lib/vault.js).
//
//   DATABASE_URL=... DATA_KEY=... node tools/encrypt-purchases.js            look only: how many rows would change
//   DATABASE_URL=... DATA_KEY=... node tools/encrypt-purchases.js --apply    encrypt every plain row
//   DATABASE_URL=... DATA_KEY=... DATA_KEY_PREV=old node tools/encrypt-purchases.js --apply --rekey
//                                                                            also re-encrypt rows made with the old key
//   DATABASE_URL=... DATA_KEY=... node tools/encrypt-purchases.js --apply --decrypt
//                                                                            undo: write everything back as plain text
//
// Safe to stop and run again: it only touches rows that still need changing. Each value is encrypted, opened again and
// compared before it is written, and a row is only updated if nobody changed it in the meantime. It never prints
// purchase text, only counts.
const vault = require('../lib/vault');

const BATCH = 500;

const run = async ({ q, apply = false, decrypt = false, rekey = false, log = console.log }) => {
  if (!decrypt && !vault.enabled()) throw new Error('Set DATA_KEY first (at least 32 characters)');
  const stats = { seen: 0, plain: 0, sealed: 0, changed: 0, skipped: 0, failed: 0 };
  let last = 0;
  for (;;) {
    const rows = await q('select id, user_id, title, body from purchases where id > $1 order by id limit ' + BATCH, [last]);
    if (!rows.length) break;
    for (const r of rows) {
      last = Number(r.id);
      stats.seen++;
      const isSealed = vault.isSealed(r.title) || vault.isSealed(r.body);
      if (isSealed) stats.sealed++; else stats.plain++;
      let title;
      let body;
      let touch;
      try {
        if (decrypt) {
          touch = isSealed;
          if (touch) { title = vault.open(r.user_id, 'title', r.title); body = vault.open(r.user_id, 'body', r.body); }
        } else {
          // Rows with both values sealed are done, unless a key change was asked for.
          const done = vault.isSealed(r.title) && vault.isSealed(r.body);
          touch = !done || rekey;
          if (touch) {
            const t = vault.open(r.user_id, 'title', r.title);
            const b = vault.open(r.user_id, 'body', r.body);
            title = vault.seal(r.user_id, 'title', t);
            body = vault.seal(r.user_id, 'body', b);
            // Check before writing: what is stored must open to exactly what was there.
            if (vault.open(r.user_id, 'title', title) !== t || vault.open(r.user_id, 'body', body) !== b) throw new Error('did not read back the same');
          }
        }
      } catch (e) {
        stats.failed++;
        log('row ' + r.id + ': skipped (' + e.message + ')');
        continue;
      }
      if (!touch) { stats.skipped++; continue; }
      if (!apply) { stats.changed++; continue; }
      const out = await q('update purchases set title = $2, body = $3 where id = $1 and title = $4 and body = $5 returning id', [r.id, title, body, r.title, r.body]);
      if (out.length) stats.changed++; else { stats.skipped++; log('row ' + r.id + ': changed by someone else, left alone (run again)'); }
    }
  }
  return stats;
};

// Opens every row to prove the database and the key agree. Returns counts only.
const verify = async ({ q }) => {
  const out = { rows: 0, plain: 0, sealed: 0, bad: 0 };
  let last = 0;
  for (;;) {
    const rows = await q('select id, user_id, title, body from purchases where id > $1 order by id limit ' + BATCH, [last]);
    if (!rows.length) break;
    for (const r of rows) {
      last = Number(r.id);
      out.rows++;
      if (vault.isSealed(r.title) || vault.isSealed(r.body)) out.sealed++; else out.plain++;
      try { vault.open(r.user_id, 'title', r.title); vault.open(r.user_id, 'body', r.body); } catch (e) { out.bad++; }
    }
  }
  return out;
};

module.exports = { run, verify };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const opts = { apply: args.includes('--apply'), decrypt: args.includes('--decrypt'), rekey: args.includes('--rekey') };
    const { q } = require('../lib/db');
    console.log(opts.apply ? (opts.decrypt ? 'Writing purchases back as plain text...' : 'Encrypting purchases...') : 'Looking only (add --apply to change anything).');
    const s = await run({ q, ...opts });
    console.log('Looked at ' + s.seen + ' purchases: ' + s.plain + ' plain, ' + s.sealed + ' encrypted.');
    console.log((opts.apply ? 'Changed ' : 'Would change ') + s.changed + ', left alone ' + s.skipped + ', problems ' + s.failed + '.');
    if (opts.apply) {
      const v = await verify({ q });
      console.log('Check: ' + v.rows + ' rows, ' + v.sealed + ' encrypted, ' + v.plain + ' plain, ' + v.bad + ' that cannot be opened.');
      if (v.bad || s.failed) process.exitCode = 1;
    }
    process.exit(process.exitCode || 0);
  })().catch((e) => { console.error('Stopped: ' + e.message); process.exit(1); });
}
