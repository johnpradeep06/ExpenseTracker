'use strict';
// A person's own categories (Rent, Phone, Daycare...) and the stores they asked to always go to one of them.
// Checked here before anything is stored: names, icons and kinds are cleaned, nothing unknown is kept.
const merchants = require('../public/merchants.js');

const BUILT_IN = merchants.CATS.concat(['Other']);
const KINDS = ['need', 'fun', 'unk'];
const MAX_CATS = 20;
const MAX_RULES = 100;
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const text = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max);

// An icon is one emoji (a few characters at most). Anything else becomes the default.
const iconOf = (v) => {
  const t = String(v || '').trim();
  const chars = Array.from(t);
  return chars.length >= 1 && chars.length <= 4 && /\p{Extended_Pictographic}/u.test(t) ? t : '🏷️';
};

// input: { cats: [{ name, icon, kind }], rules: { storeKey: categoryName }, ruleNames: { storeKey: 'Store name' } } -> { value } or { error }
const clean = (input) => {
  const b = input || {};
  const list = Array.isArray(b.cats) ? b.cats : [];
  if (list.length > MAX_CATS) return { error: 'You can have up to ' + MAX_CATS + ' categories of your own' };
  const cats = [];
  const seen = new Set(BUILT_IN.map(fold));
  for (const it of list) {
    const name = text(it && it.name, 24);
    if (!name) return { error: 'Give each category a name' };
    if (seen.has(fold(name))) return { error: '"' + name + '" is already a category. Choose a different name' };
    seen.add(fold(name));
    cats.push({ name, icon: iconOf(it.icon), kind: KINDS.includes(it.kind) ? it.kind : 'unk' });
  }
  const names = new Set(cats.map((c) => c.name).concat(BUILT_IN.filter((n) => n !== 'Other')));    // a store can be sent to one of the app's own categories too
  const rules = {};
  const src = b.rules && typeof b.rules === 'object' && !Array.isArray(b.rules) ? b.rules : {};
  Object.keys(src).slice(0, MAX_RULES).forEach((k) => {
    const key = text(k, 60);
    if (key && names.has(src[k])) rules[key] = src[k];     // a rule for a category that no longer exists is dropped
  });
  // The store's name as the person knows it, for showing the list of remembered stores (only for stores that have a rule).
  const ruleNames = {};
  const shown = b.ruleNames && typeof b.ruleNames === 'object' && !Array.isArray(b.ruleNames) ? b.ruleNames : {};
  Object.keys(rules).forEach((k) => { const n = text(shown[k], 60); if (n) ruleNames[k] = n; });
  return { value: { cats, rules, ruleNames } };
};

module.exports = { clean, BUILT_IN, MAX_CATS };
