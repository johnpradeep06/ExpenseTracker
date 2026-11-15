'use strict';
// Postgres access through the pg package (Railway Postgres). Tests swap in an in-memory Postgres via setTestDb().
const { Pool } = require('pg');

let pool = null;
let testDb = null;
let ready = null;

const SCHEMA = [
  `create table if not exists users (
     id uuid primary key default gen_random_uuid(),
     email text not null,
     pw_hash text not null,
     fail_count integer not null default 0,
     locked_until timestamptz,
     name text not null default '',
     created_at timestamptz not null default now(),
     daily_limit numeric(12,2) not null default 0,
     tz text not null default 'America/Toronto',
     key_hash text unique,
     key_enc text,
     session_version integer not null default 1
   )`,
  'create unique index if not exists users_email_lower on users (lower(email))',
  'alter table users add column if not exists disabled boolean not null default false',
  'alter table users add column if not exists last_seen timestamptz',
  'alter table users add column if not exists reset_hash text',
  'alter table users add column if not exists reset_expires timestamptz',
  `create table if not exists invites (
     id bigserial primary key,
     code_hash text unique not null,
     note text not null default '',
     created_at timestamptz not null default now(),
     expires_at timestamptz not null,
     used_at timestamptz,
     used_by uuid references users(id) on delete set null,
     revoked_at timestamptz
   )`,
  `create table if not exists app_settings (
     key text primary key,
     value text not null
   )`,
  `create table if not exists signup_attempts (
     ip text not null,
     at timestamptz not null default now()
   )`,
  'create index if not exists signup_attempts_ip_at on signup_attempts (ip, at)',
  `create table if not exists game (
     user_id uuid primary key references users(id) on delete cascade,
     goal_name text not null default '',
     goal_emoji text not null default '',
     goal_amount numeric(12,2) not null default 0,
     xp integer not null default 0,
     created_at timestamptz not null default now()
   )`,
  `create table if not exists game_days (
     user_id uuid not null references users(id) on delete cascade,
     day text not null,
     saved numeric(12,2) not null,
     limit_at numeric(12,2) not null,
     real boolean not null default false,
     collected_at timestamptz not null default now(),
     primary key (user_id, day)
   )`,
  `create table if not exists purchases (
     id bigserial primary key,
     user_id uuid not null references users(id) on delete cascade,
     title text not null,
     body text not null,
     state text not null default 'open',
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now()
   )`,
  // The person's own mark on a purchase: 'need' (necessary) or 'fun' (unnecessary). Empty means the app's guess by category.
  'alter table purchases add column if not exists kind text',
  'create index if not exists purchases_user_created on purchases (user_id, created_at desc)',
  // The items found on a scanned bill. The name is encrypted like the rest of the purchase text. price is as printed;
  // alloc is that item's share of what was actually paid (tax and rounding spread over the items), and kind is the
  // person's own final call on it: 'need' (necessary), 'fun' (unnecessary) or 'unk' (not sure).
  `create table if not exists bill_items (
     id bigserial primary key,
     purchase_id bigint not null references purchases(id) on delete cascade,
     user_id uuid not null references users(id) on delete cascade,
     pos integer not null default 0,
     name text not null,
     price numeric(12,2) not null,
     alloc numeric(12,2) not null,
     kind text not null default 'unk',
     created_at timestamptz not null default now()
   )`,
  'create index if not exists bill_items_purchase on bill_items (purchase_id)',
  // One row per bill photo read, so a person's daily number of scans can be limited.
  `create table if not exists bill_scans (
     user_id uuid not null references users(id) on delete cascade,
     at timestamptz not null default now()
   )`,
  'create index if not exists bill_scans_user_at on bill_scans (user_id, at)',
  `create table if not exists devices (
     id bigserial primary key,
     user_id uuid not null references users(id) on delete cascade,
     endpoint text unique not null,
     p256dh text not null,
     auth text not null,
     created_at timestamptz not null default now()
   )`,
  `create table if not exists notes_sent (
     user_id uuid not null references users(id) on delete cascade,
     kind text not null,
     day text not null,
     primary key (user_id, kind, day)
   )`
];

const raw = async (text, params) => {
  if (testDb) return testDb(text, params || []);
  if (!pool) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) throw new Error('No database is connected');
    const local = /@(localhost|127\.0\.0\.1|[^/:]*\.railway\.internal)\b/.test(url) || /sslmode=disable/.test(url);
    // Small pool: every serverless instance has its own. Railway's public proxy uses a self-signed certificate.
    pool = new Pool({ connectionString: url, max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000, ssl: local ? false : { rejectUnauthorized: false } });
    pool.on('error', (e) => console.error('database pool error:', e.message));
  }
  return (await pool.query(text, params || [])).rows;
};

// The tables are made once. Every server instance used to run all of the setup statements below, one after another, each
// time it woke up - about twenty trips to the database before its first real question. Now the database remembers which
// version of the setup it has, and an instance that finds the current version skips straight to its work.
// IMPORTANT: change SCHEMA_VERSION whenever SCHEMA above changes, or the new setup will not run.
const SCHEMA_VERSION = '2026-11-15-bills';

// Runs one statement and returns the rows. The tables are made the first time.
const q = async (text, params) => {
  if (!ready) {
    ready = (async () => {
      try {
        const have = await raw("select value from app_settings where key = 'schema_version'");
        if (have[0] && have[0].value === SCHEMA_VERSION) return;
      } catch (e) { /* the settings table does not exist yet: this is a new database */ }
      for (const s of SCHEMA) await raw(s);
      await raw("insert into app_settings (key, value) values ('schema_version', $1) on conflict (key) do update set value = excluded.value", [SCHEMA_VERSION]);
    })().catch((e) => { ready = null; throw e; });
  }
  await ready;
  return raw(text, params);
};

const setTestDb = (fn) => { testDb = fn; ready = null; };

module.exports = { q, setTestDb, SCHEMA_VERSION };
