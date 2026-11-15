// Tests of reading a bill's plain text into items (lib/billtext.js). Run: node test/billtext.test.js
'use strict';
const assert = require('assert');
const { parse } = require('../lib/billtext');
let pass = 0;
const ok = (c, l) => { assert.ok(c, l); pass++; console.log('  ok', l); };
const find = (r, re) => r.items.find((i) => re.test(i.name));

// 1. a Quebec grocery bill: decimal commas, tax flags, weight lines, a discount
const METRO = `METRO PLUS #204
1234 RUE SHERBROOKE O
MONTREAL QC H3A 1B9
TEL: 514-555-0123
2026-11-15 18:12
LAIT 2% 2L                5,49 FC
OEUFS GR A 12             4,29 FC
PAIN TRANCHE              3,19 FC
POULET ENTIER
   2,134 kg @ 5,81/kg      12,40 FC
BANANES
   1,200 kg @ 1,75/kg       2,10 FC
CHIPS LAYS BBQ 235G       4,99 FCT
COCA-COLA 12X355ML        7,99 FCT
BIERE MOLSON 12X355ML    21,99 FCT
RABAIS                    -1,00
SOUS-TOTAL               61,44
TPS 5% (R123456789)       1,75
TVQ 9,975% (1234567890)   3,49
TOTAL                    66,68
VISA ****4242            66,68
MONNAIE                   0,00
MERCI ET A BIENTOT`;
let r = parse(METRO);
ok(r.items.length === 9, 'the grocery bill gives its 8 items and the discount, no header, tax, card or change lines: ' + r.items.length);
ok(find(r, /LAIT/).price === 5.49 && find(r, /OEUFS/).price === 4.29, 'prices with a decimal comma are read right');
ok(find(r, /POULET/).price === 12.4 && find(r, /POULET/).name === 'POULET ENTIER', 'a price on the weight line below belongs to the item above, and the weight is not in the name');
ok(find(r, /BANANES/).price === 2.1, 'a second weight line works the same way');
ok(find(r, /CHIPS/).name === 'CHIPS LAYS BBQ 235G' && find(r, /CHIPS/).price === 4.99, 'tax flags (FCT) are not part of the name or the price');
ok(find(r, /BIERE/).price === 21.99, 'the beer is there: ' + (find(r, /BIERE/) || {}).name);
ok(r.items.some((i) => i.price === -1 && /Rabais/.test(i.name)), 'a discount line becomes a negative line');
ok(r.subtotal === 61.44 && r.tax === 5.24 && r.total === 66.68, 'subtotal 61.44, tax 5.24 (TPS + TVQ) and total 66.68 are found: ' + [r.subtotal, r.tax, r.total]);
ok(r.date === '2026-11-15' && /METRO/.test(r.store), 'the date and the store are found: ' + r.date + ' / ' + r.store);
ok(Math.round(r.items.reduce((s, i) => s + i.price, 0) * 100) / 100 === 61.44, 'the items add up to the printed subtotal');

// 2. a leading quantity ("2 YOGOURT")
r = parse(`IGA EXTRA FAMILLE LACROIX
2 YOGOURT NATURE 650G   9,98
1 SAC REUTILISABLE      0,99
CREME GLACEE VANILLE    6,49
SOUS-TOTAL             17,46
TPS                     0,05
TVQ                     0,10
TOTAL                  17,61`);
ok(r.items.length === 3 && find(r, /YOGOURT/).qty === 2 && find(r, /YOGOURT/).name === 'YOGOURT NATURE 650G', 'a leading quantity is a quantity, not part of the name');
ok(r.total === 17.61 && r.tax === 0.15, 'totals found when the bill has a different layout');

// 3. all the names first, then all the prices (some phones read a bill in columns)
r = parse(`SAQ EXPRESS 23099
VIN ROUGE PINOT 750ML
BIERE IPA 6X473
SAC
18,50
14,25
0,10
TOTAL 32,85`);
ok(r.items.length === 3 && find(r, /VIN/).price === 18.5 && find(r, /BIERE/).price === 14.25 && find(r, /SAC/).price === 0.1, 'names and prices read in two blocks are paired up in order');

// 4. a restaurant bill
r = parse(`Resto Chez Pierre
2026-11-14 20:41
POUTINE REGULIERE   12.50
BURGER BISTRO       17.25
COCA-COLA            3.50
SOUS-TOTAL          33.25
TPS                  1.66
TVQ                  3.32
TOTAL               38.23
POURBOIRE
VISA                38.23`);
ok(r.items.length === 3 && r.total === 38.23 && r.tax === 4.98, 'a restaurant bill with decimal points works too');

// 5. dollar signs, spacing, and a bill with no tax lines
r = parse(`DEPANNEUR CHEZ LOUIS
LAIT $5.49
PAIN  $3.19
TOTAL $8.68`);
ok(r.items.length === 2 && r.total === 8.68, 'dollar signs are fine, and a bill with no tax lines still gives its items');

// 6. things that must never be items
r = parse(`MAXI
TEL: 514-555-0199
CAISSE 04 CAISSIER 12
2026-11-15
LAIT 5,49
TOTAL 5,49
DEBIT 5,49
POINTS PC OPTIMUM 120
MERCI`);
ok(r.items.length === 1 && r.items[0].name === 'LAIT', 'phone numbers, the till, payment and loyalty lines are not items');
ok(parse('').items.length === 0 && parse('bonjour tout le monde').items.length === 0 && parse(null).items.length === 0, 'text with no bill in it gives no items');
ok(parse('x'.repeat(100000)).items.length === 0, 'a huge block of text is handled');

// 7. a real Winners bill (a phone photographed it): "89,99$ TQ" has a dollar sign AND a tax flag, the GST registration line is
// not a tax line, and the labels and amounts can come out of the phone's reader on separate lines
const WINNERS_ROWS = `WINNERS
DOWNTOWN MONTREAL
1500 MCGILL COLLEGE AVE.
H3A 3J5 MONTREAL QC
514-788-4949
GST NO.86032 6255 RT0001CA #07043
VENTE RÉGULIÈRE
9 - VÊT. EXT. HOMM 094320   89,99$ TQ
Sous-total   89,99$
QC TPS 5.000%   4,50$
QC TVQ 9.975%   8,98$
Total   103,47$
AMEX   103,47$
TRANSACTION RECORD
APPROVED
04-11-2026 20:13:50
Monnaie   0,00$`;
const WINNERS_COLS = WINNERS_ROWS.replace('094320   89,99$ TQ', '094320\n89,99$ TQ').replace('Sous-total   89,99$', '89,99$\nSous-total').replace('QC TPS 5.000%   4,50$\nQC TVQ 9.975%   8,98$', 'QC TPS 5.000%\nQC TVQ 9.975%\n4,50$\n8,98$').replace('Total   103,47$\nAMEX   103,47$', 'Total\n103,47$\nAMEX\n103,47$');
[['line by line', WINNERS_ROWS], ['labels and amounts apart', WINNERS_COLS]].forEach(([how, text]) => {
  r = parse(text);
  ok(r.store === 'WINNERS' && r.items.length === 1 && r.items[0].name === 'VÊT. EXT. HOMM' && r.items[0].price === 89.99, 'Winners (' + how + '): the one item, with its code and "9 -" taken off: ' + JSON.stringify(r.items));
  ok(r.subtotal === 89.99 && r.tax === 13.48 && r.total === 103.47, 'Winners (' + how + '): subtotal, tax and total: ' + r.subtotal + ' / ' + r.tax + ' / ' + r.total);
});

// 8. a Montreal grocery bill with Chinese characters above each name, weight lines, and a name in two languages
const NEWON_HEAD = `Marche Newon
1616 Rue Sainte-Catherine O.
Montreal, QC H3H 1L7
LI JIA
11/15/2026 2:38:50 PM`;
const NEWON_ROWS = `${NEWON_HEAD}
黄小椒
Poivron Jaune Petit $3.79
青羊角豆/秋葵
Gombo Vert
0.99 lb @ $2.98/lb $2.95
袋装菠菜叶
HARVEST FRESH SPINACH $3.59
中國蜜柚 白肉
POMELO AU MIEL $7.99
青羊角豆/秋葵
Gombo Vert
1.07 lb @ $2.98/lb $3.19
RIBOLTA G. ANGELENO PLUMS
RIBOLTA G. PRUNES ANGELENO $2.98
TOTAL $24.49
Visa $24.49
Item count: 6
Trans:230291 Terminal:050106015-001008`;
const NEWON_COLS = `Marche Newon
1616 Rue Sainte-Catherine O.
Montreal, QC H3H 1L7
11/15/2026 2:38:50 PM
LI JIA
黄小椒
Poivron Jaune Petit
青羊角豆/秋葵
Gombo Vert
0.99 lb @ $2.98/lb
袋装菠菜叶
HARVEST FRESH SPINACH
中國蜜柚 白肉
POMELO AU MIEL
青羊角豆/秋葵
Gombo Vert
1.07 lb @ $2.98/lb
RIBOLTA G. ANGELENO PLUMS
RIBOLTA G. PRUNES ANGELENO
$3.79
$2.95
$3.59
$7.99
$3.19
$2.98
TOTAL
Visa
$24.49
$24.49
Item count: 6`;
[['line by line', NEWON_ROWS], ['names first, then prices', NEWON_COLS]].forEach(([how, text]) => {
  r = parse(text);
  const sum = Math.round(r.items.reduce((t, i) => t + i.price, 0) * 100) / 100;
  ok(r.store === 'Marche Newon' && r.items.length === 6 && r.total === 24.49 && sum === 24.49, 'Newon (' + how + '): six items that add up to the $24.49 total: ' + r.items.length + ' items, ' + sum);
  ok(find(r, /POMELO/).price === 7.99 && find(r, /SPINACH/).price === 3.59 && r.items.filter((i) => /Gombo/.test(i.name)).map((i) => i.price).join() === '2.95,3.19', 'Newon (' + how + '): each price is on the right item, weights included');
});

console.log('\nALL PASSED:', pass);
