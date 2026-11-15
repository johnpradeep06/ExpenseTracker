'use strict';
// Turns the plain text of a bill (what the iPhone's own text reader gets from a photo) into items, with rules only: no AI
// and no network. It copes with the things Quebec bills do: decimal commas (5,49), tax flags after a price (5.49 FC),
// weight lines ("1,234 kg @ 4,99/kg"), "2 X 3,49" quantity lines, discounts, a price on the line below its name, and
// the tax, total and card lines at the bottom (which are never items).
const fold = (s) => String(s === undefined || s === null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const r2 = (n) => Math.round(n * 100) / 100;
const money = (digits, negative) => { const v = Number(String(digits).replace(',', '.')); return isFinite(v) ? (negative ? -v : v) : null; };

// "name .... 5,49 FC"  -> name, sign, amount, optional tax flag. The LAST price on the line is the line's price.
const NAME_PRICE = /^(.*\S)\s+(-?)\s*\$?\s*(\d{1,4}[.,]\d{2})(-?)\s*(?:\$\s*)?(?:[A-Za-z]{1,3})?\s*$/;
const PRICE_ONLY = /^\s*(-?)\s*\$?\s*(\d{1,4}[.,]\d{2})(-?)\s*(?:\$\s*)?(?:[A-Za-z]{1,3})?\s*$/;
const WEIGHT_LINE = /\d+([.,]\d+)?\s*(kg|g|lb|lbs)\b.*[@x]|[@]\s*\$?\d+[.,]\d{2}\s*\/\s*(kg|lb|g)|^\s*\d+\s*(x|@)\s*\$?\d+[.,]\d{2}/i;

const SUBTOTAL = /^(sous[- ]?total|subtotal|sub total)\b/;
const TOTAL = /^(total|montant total|total a payer|a payer|montant a payer|balance due|amount due|grand total)\b/;
const TAX = /\b(tps|tvq|tvh|gst|qst|hst|pst|tax|taxe|taxes)\b/;
const PAYMENT = /\b(visa|mastercard|master card|mc|amex|american express|debit|interac|comptant|cash|argent|monnaie|change|carte|card|paiement|payment|approuve|approved|rendu|points?|aeroplan|pc optimum)\b/;
const NOT_ITEM = /^(merci|thank you|tel|telephone|caisse|caissier|cashier|terminal|ref|reference|no\.?|numero|date|heure|facture|invoice|recu|receipt|solde|balance)\b/;

// Lines at the top or bottom of a bill that are about the store or the card, never about a purchased item.
const JUNK = /^(vente|sale|achat|purchase|regular|reguliere|bienvenue|welcome|transaction|expires|expire|auth|aid|application|approved|approuve|contactless|sans contact|no\.?\s*de|numero|downtown|centre|succursale)\b|\b(h\d[a-z]\s?\d[a-z]\d|[a-z]\d[a-z]\s?\d[a-z]\d)\b|\b\d{3}[-. ]\d{3}[-. ]\d{4}\b|\b(ave|avenue|rue|boul|boulevard|street|st\.|chemin|montreal|quebec|qc)\b.*\b(qc|h\d[a-z])\b|\b(gst|tps|tvq|rt\d+)\s*(no|#)|\*{3,}/;

const clean = (s) => String(s || '').replace(/\s{2,}/g, ' ').trim();

// An item's name with the noise taken off: barcodes, weights, a leading quantity, trailing tax flags.
const nameOf = (raw) => {
  let n = String(raw || '');
  n = n.replace(/\d+([.,]\d+)?\s*(kg|g|lb|lbs)\s*@.*$/i, ' ').replace(/\b\d+\s*[x@]\s*\$?\d+[.,]\d{2}.*$/i, ' ');
  n = n.replace(/\b\d{6,}\b/g, ' ').replace(/[.]{2,}|[_*]{2,}/g, ' ');
  n = n.trim().replace(/^\d{1,3}\s*[-–]\s*(?=[A-Za-zÀ-ÿ])/, '');
  let qty = 1;
  const lead = /^(\d{1,2})\s+(?=[A-Za-zÀ-ÿ])/.exec(n.trim());
  if (lead) { qty = Number(lead[1]); n = n.trim().slice(lead[0].length); }
  n = n.replace(/\s+[FCTPDM]{1,3}$/, '').replace(/\s*[#*]+\s*$/, '');
  return { name: clean(n).slice(0, 80), qty: qty > 0 ? qty : 1 };
};

const parse = (text) => {
  const lines = String(text || '').replace(/ /g, ' ').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 400);
  const out = { store: '', date: '', items: [], subtotal: null, tax: null, total: null };
  const dateAt = /\b(20\d{2})[-/.](0[1-9]|1[0-2])[-/.](0[1-9]|[12]\d|3[01])\b/;
  for (const l of lines) { const d = dateAt.exec(l); if (d) { out.date = d[1] + '-' + d[2] + '-' + d[3]; break; } }
  const header = lines.find((l) => /[A-Za-zÀ-ÿ]{3,}/.test(l) && !PRICE_ONLY.test(l)) || '';
  out.store = clean(header.replace(/[#*].*$/, '')).slice(0, 60);

  let inItems = true;       // items are printed above the first subtotal / tax / total line
  let pending = null;       // a name that has no price yet (the price is on the line below)
  let block = false;        // names and prices come in two separate blocks, not line by line
  const names = [];         // names without a price and prices without a name, for the fallback below
  const prices = [];
  const waiting = [];       // labels (subtotal / tax / total) whose amount is printed on a later line
  let taxSum = 0;
  let sawTax = false;
  const push = (rawName, amount) => {
    const { name, qty } = nameOf(rawName);
    if (!/[A-Za-zÀ-ÿ]{2,}/.test(name) || amount === null || amount === 0 || Math.abs(amount) > 5000) return;
    out.items.push({ name, qty, price: r2(amount) });
  };

  for (const line of lines) {
    const f = fold(line);
    const np = NAME_PRICE.exec(line);
    const amt = np ? money(np[3], np[2] === '-' || np[4] === '-') : (PRICE_ONLY.test(line) ? (() => { const m = PRICE_ONLY.exec(line); return money(m[2], m[1] === '-' || m[3] === '-'); })() : null);
    // "GST NO. 86032 6255 RT0001CA" is the store's tax registration, not a tax line: it has no amount and must not end the items.
    if (amt === null && (/\b(gst|tps|tvq|qst|hst|tvh|taxe?s?)\b.*(\bno\b|n°|#|\d{5})/.test(f) || /\brt\d{4}/.test(f))) { pending = null; continue; }
    if (SUBTOTAL.test(f)) {
      if (amt !== null) out.subtotal = r2(amt);
      else {
        // the amount may be the lone price just above (items add up to it), or on a line below
        const sum = r2(out.items.reduce((t, i) => t + i.price, 0));
        if (prices.length && Math.abs(prices[prices.length - 1] - sum) < 0.01) out.subtotal = r2(prices.pop());
        else waiting.push('subtotal');
      }
      inItems = false; pending = null; continue;
    }
    if (TOTAL.test(f) && !SUBTOTAL.test(f)) { if (amt !== null) out.total = r2(amt); else waiting.push('total'); inItems = false; pending = null; continue; }
    if (TAX.test(f)) { if (amt !== null) { taxSum += amt; sawTax = true; } else waiting.push('tax'); inItems = false; pending = null; continue; }
    if (!inItems) {
      if (waiting.length && amt !== null && PRICE_ONLY.test(line)) {
        const w = waiting.shift();
        if (w === 'subtotal') out.subtotal = r2(amt);
        else if (w === 'total') out.total = r2(amt);
        else { taxSum += amt; sawTax = true; }
      }
      continue;
    }
    if (PAYMENT.test(f) && !/[a-z]{4,}.*[a-z]{4,}/.test(f.replace(PAYMENT, ''))) { pending = null; continue; }
    if (NOT_ITEM.test(f) || (!np && !PRICE_ONLY.test(line) && JUNK.test(f))) { pending = null; continue; }

    if (np) {
      const label = np[1];
      const weighty = WEIGHT_LINE.test(label);
      const hasName = /[A-Za-zÀ-ÿ]{2,}/.test(label.replace(/\d+([.,]\d+)?\s*(kg|g|lb|lbs)\b/gi, ''));
      if (weighty && pending) { push(pending, amt); pending = null; continue; }        // "  1,234 kg @ 4,99/kg   6,15" under its name
      if (weighty && !hasName && out.items.length) continue;                              // a weight line with no price of its own
      if (!hasName) continue;
      if (amt < 0 && out.items.length) { out.items.push({ name: clean('Rabais ' + out.items[out.items.length - 1].name).slice(0, 80), qty: 1, price: r2(amt) }); pending = null; continue; }
      push(label, amt);
      pending = null;
      continue;
    }
    if (PRICE_ONLY.test(line)) {
      if (pending && !block) { push(pending, amt); names.pop(); pending = null; } else prices.push(amt);
      continue;
    }
    if (WEIGHT_LINE.test(line)) continue;
    if (line === header) continue;
    if (/[A-Za-zÀ-ÿ]{2,}/.test(line) && !/\d{3}[-. ]\d{3}[-. ]\d{4}/.test(line)) {
      if (pending) block = true;      // two names in a row: the prices are not under their names
      pending = line;
      names.push(line);
    }
  }
  if (sawTax) out.tax = r2(taxSum);
  // Some phones put every name first and every price after. When that is what we got, pair them up in order.
  if (out.items.length < 2 && names.length >= 2 && names.length === prices.length) names.forEach((n, i) => push(n, prices[i]));
  // A bill that printed no tax line may still show tax as the gap between its subtotal and total.
  if (out.tax === null && out.subtotal !== null && out.total !== null && out.total > out.subtotal) out.tax = r2(out.total - out.subtotal);
  if (out.total === null && out.items.length) out.total = r2(out.items.reduce((s, i) => s + i.price, 0) + (out.tax || 0));
  return out;
};

module.exports = { parse, nameOf };
