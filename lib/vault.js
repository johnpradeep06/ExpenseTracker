'use strict';
// Encryption at rest for purchase text (the title and body of every purchase).
//
// Why: the database holds everyone's spending. If a backup or a database login ever leaks, plain text rows would be
// readable by anyone. With this, the database holds only scrambled values, and the key lives somewhere else (the
// DATA_KEY setting on the server). Reading the database alone shows nothing.
//
// How: AES-256-GCM, a fresh random IV for every value, and the owner's id plus the column name bound in as
// "additional data". That means a stored value cannot be copied onto another person's purchase, or into the other
// column, without being rejected. Stored form: "e1:" + base64url(iv + tag + ciphertext).
//
// Safe to roll out: values without the "e1:" prefix are old plain text and are read as they are. With no DATA_KEY set,
// new values are stored as plain text (nothing breaks), and a stored scrambled value with no key is refused loudly
// instead of being shown as gibberish.
//
// Keys: DATA_KEY is used for writing. During a key change, put the old key in DATA_KEY_PREV so old rows still open.
const crypto = require('crypto');

const PREFIX = 'e1:';
const INFO = 'spending-purchase-data-v1';
const cache = new Map();

const keyFrom = (secret) => {
  if (!cache.has(secret)) cache.set(secret, Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), INFO, 32)));
  return cache.get(secret);
};
const secrets = () => [process.env.DATA_KEY, process.env.DATA_KEY_PREV].map((s) => String(s || '').trim()).filter(Boolean);
const goodSecret = (s) => s.length >= 32;

// True when new values will be scrambled. A key that is set but too short is not used, and says so in the server log.
let warned = false;
const enabled = () => {
  const k = String(process.env.DATA_KEY || '').trim();
  if (!k) return false;
  if (!goodSecret(k)) {
    if (!warned) { warned = true; console.warn('DATA_KEY is set but shorter than 32 characters, so purchases are NOT being encrypted'); }
    return false;
  }
  return true;
};

const isSealed = (v) => typeof v === 'string' && v.startsWith(PREFIX);

const seal = (userId, field, text) => {
  const value = String(text === undefined || text === null ? '' : text);
  if (!enabled()) return value;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFrom(String(process.env.DATA_KEY).trim()), iv);
  c.setAAD(Buffer.from(userId + '|' + field, 'utf8'));
  const out = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), out]).toString('base64url');
};

const open = (userId, field, stored) => {
  if (!isSealed(stored)) return stored;
  const keys = secrets().filter(goodSecret);
  if (!keys.length) throw new Error('Purchase data is encrypted but DATA_KEY is not set');
  const b = Buffer.from(stored.slice(PREFIX.length), 'base64url');
  if (b.length < 28) throw new Error('A stored purchase value is damaged');
  for (const secret of keys) {
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', keyFrom(secret), b.subarray(0, 12));
      d.setAAD(Buffer.from(userId + '|' + field, 'utf8'));
      d.setAuthTag(b.subarray(12, 28));
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
    } catch (e) { /* try the next key */ }
  }
  throw new Error('A stored purchase value could not be opened with the current key');
};

// A purchase row as the app uses it, with its text opened.
const openRow = (userId, row) => ({ ...row, title: open(userId, 'title', row.title), body: open(userId, 'body', row.body) });

module.exports = { seal, open, openRow, isSealed, enabled, PREFIX };
