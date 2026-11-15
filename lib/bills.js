'use strict';
// Turns what the AI reader said about a bill into clean, checked items. The model's answer is never trusted as it comes:
// every number is re-read, lines that are not items are dropped, a few things the app is sure about are corrected, and
// the items are added up against the purchase so a misread bill is flagged instead of silently saved.
const merchants = require('../public/merchants.js');

const r2 = (n) => Math.round(n * 100) / 100;
const fold = (s) => String(s === undefined || s === null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const clean = (v, max) => String(v === undefined || v === null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, max || 80);

// A number from the model, with a French decimal comma allowed. null when it is not a number.
const num = (v) => {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const t = String(v === undefined || v === null ? '' : v).replace(/\s/g, '').replace(/\$/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
};

// Lines that are never purchased items, whatever the model said.
const NOT_AN_ITEM = /^(sous[- ]?total|subtotal|total|tps|tvq|tvh|gst|qst|hst|pst|taxes?|visa|mastercard|master card|amex|american express|debit|debit card|interac|comptant|cash|argent|monnaie|change|carte|card|points?|aeroplan|pc optimum|merci|thank you|balance|solde|paiement|payment|approuve|approved|rendu)\b/;

// Things nobody could call necessary, whatever the model guessed.
const ALCOHOL = /\b(biere|bieres|beer|vin|vins|wine|vodka|whisky|whiskey|rhum|rum|gin|tequila|cidre|cider|spiritueux|liqueur|alcool|champagne|prosecco|bud light|budweiser|molson|labatt|corona|heineken|stella artois|sleeman|coors|modelo|cooler|seltzer|pinot|merlot|cabernet|chardonnay|sauvignon)\b/;
const REMEMBER_ALL = new Set(['SAQ', 'LCBO']);

// The same product on two bills gets the same key, however it was spelled or abbreviated.
const itemKey = (name) => fold(name).replace(/\b\d+([.,]\d+)?\s*(g|kg|ml|l|lb|oz|un|x|pk|pqt)\b/g, ' ').replace(/[^a-z]+/g, ' ').trim().slice(0, 28);

// raw: what the model returned. ctx: { store, amount (the purchase amount), memory: { itemKey: 'need'|'fun' } }
const normalize = (raw, ctx) => {
  const c = ctx || {};
  const store = merchants.clean(c.store || (raw && raw.store) || '');
  const allFun = store.how === 'brand' && REMEMBER_ALL.has(store.name);
  const list = raw && Array.isArray(raw.items) ? raw.items.slice(0, 120) : [];
  const items = [];
  list.forEach((it) => {
    if (!it || typeof it !== 'object') return;
    const name = clean(it.name, 80);
    const price = num(it.price);
    if (!name || price === null || price === 0 || Math.abs(price) > 5000) return;
    if (NOT_AN_ITEM.test(fold(name).trim())) return;
    const qty = Math.min(Math.max(num(it.qty) || 1, 1), 999);
    let kind = it.kind === 'need' || it.kind === 'fun' ? it.kind : 'unk';
    let how = kind === 'unk' ? 'unsure' : 'reader';
    if (ALCOHOL.test(fold(name))) { kind = 'fun'; how = 'rule'; }
    if (allFun && price > 0) { kind = 'fun'; how = 'store'; }
    const remembered = c.memory && c.memory[itemKey(name)];
    if (remembered === 'need' || remembered === 'fun') { kind = remembered; how = 'remembered'; }
    items.push({ name, qty, price: r2(price), kind, how });
  });
  const itemsTotal = r2(items.reduce((s, i) => s + i.price, 0));
  const tax = num(raw && raw.tax);
  const total = num(raw && raw.total);
  const expected = num(c.amount);
  // The bill agrees with the purchase when items plus tax (or the bill's own total) land within a few cents of it.
  let matches = null;
  let diff = null;
  if (expected !== null && expected > 0 && items.length) {
    const guess = r2(itemsTotal + (tax || 0));
    const best = [guess, total === null ? guess : total].map((x) => r2(Math.abs(x - expected))).sort((a, b) => a - b)[0];
    diff = best;
    matches = best <= Math.max(0.06, expected * 0.01);
  }
  return { store: store.name, items, subtotal: num(raw && raw.subtotal), tax: tax === null ? null : r2(tax), total: total === null ? null : r2(total), itemsTotal, matches, diff };
};

// Spreads the purchase amount over the items in proportion to their prices, so tax and rounding are shared out and the
// pieces always add up to the amount paid. Returns one allocation per item, in order.
const allocate = (prices, amount) => {
  const sum = r2(prices.reduce((s, p) => s + p, 0));
  if (!(amount > 0) || !(sum > 0)) return prices.map((p) => r2(p));
  const scale = amount / sum;
  const out = prices.map((p) => r2(p * scale));
  const off = r2(amount - out.reduce((s, p) => s + p, 0));
  let big = 0;
  out.forEach((p, i) => { if (Math.abs(p) > Math.abs(out[big])) big = i; });
  out[big] = r2(out[big] + off);
  return out;
};

module.exports = { normalize, allocate, itemKey, num, r2 };
