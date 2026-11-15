// Tests of the merchant pipeline (public/merchants.js) with real-looking card strings. Run: node test/merchants.test.js
'use strict';
const assert = require('assert');
const m = require('../public/merchants.js');
let pass = 0;
const ok = (c, l) => { assert.ok(c, l); pass++; };
const eq = (raw, name, cat) => {
  const r = m.clean(raw);
  ok(r.name === name && r.category === cat, JSON.stringify(raw) + ' -> ' + JSON.stringify([r.name, r.category]) + ' (wanted ' + JSON.stringify([name, cat]) + ')');
};

// more Montreal stores
eq('ROMADOS 5101', 'Romados', 'Dining & Coffee');
eq('BENNY ET CO LAVAL', 'Benny & Co.', 'Dining & Coffee');
eq('BIXI ABONNEMENT', 'BIXI', 'Transport');
eq('MONDOU 1203', 'Mondou', 'Shopping');
eq('SIX FLAGS LA RONDE', 'La Ronde', 'Entertainment');
eq('CIRQUE DU SOLEIL MONTREAL', 'Cirque du Soleil', 'Entertainment');
eq('DELTA AIR LINES 006', 'Delta', 'Travel');
eq('HELLOFRESH CANADA', 'HelloFresh', 'Groceries');

// the strings that started this
eq('Saq23028faubourg Ste-Cat', 'SAQ', 'Entertainment');
eq('SAQ 23028 FAUBOURG STE-CAT', 'SAQ', 'Entertainment');
eq('SAQ EXPRESS 23099 MONTREAL QC', 'SAQ', 'Entertainment');
eq('Société des alcools du Québec', 'SAQ', 'Entertainment');
eq('MARCHE THARSNIO 4411 MONTREAL', 'Marche Tharsnio', 'Groceries');
eq('Marché Tharsnio', 'Marché Tharsnio', 'Groceries');

// groceries
eq('MARCHÉ TRADITION ST-LAURENT', 'Marché Tradition', 'Groceries');
eq('PROVIGO LE MARCHE 8841', 'Provigo', 'Groceries');
eq('METRO PLUS #204 MONTREAL QC', 'Metro', 'Groceries');
eq('IGA EXTRA FAMILLE FOURNIER', 'IGA', 'Groceries');
eq('SUPER C LONGUEUIL QC', 'Super C', 'Groceries');
eq('MAXI & CIE 8123', 'Maxi', 'Groceries');
eq('ADONIS #5', 'Adonis', 'Groceries');
eq('COSTCO WHOLESALE #123', 'Costco', 'Groceries');
eq('COSTCO GAS #123', 'Costco Gas', 'Transport');
eq('EPICERIE LA BONNE FOURCHETTE 2210 MTL', 'Epicerie la Bonne Fourchette', 'Groceries');
eq('Fruiterie 440 Laval', 'Fruiterie 440', 'Groceries');
eq('BOUCHERIE ST-JEAN', 'Boucherie St-Jean', 'Groceries');

// dining
eq('TIM HORTONS #4567 MONTREAL QC', 'Tim Hortons', 'Dining & Coffee');
eq('Tim Hortons, Montréal, QC', 'Tim Hortons', 'Dining & Coffee');
eq('TIMS 8812', 'Tim Hortons', 'Dining & Coffee');
eq("MCDONALD'S #1234", "McDonald's", 'Dining & Coffee');
eq('MCDONALDS 33012 LAVAL', "McDonald's", 'Dining & Coffee');
eq('STARBUCKS COFFEE 12301', 'Starbucks', 'Dining & Coffee');
eq('ST-HUBERT RESTAURANT 9023', 'St-Hubert', 'Dining & Coffee');
eq('LA BELLE PROVINCE #44', 'La Belle Province', 'Dining & Coffee');
eq('SUBWAY #12345', 'Subway', 'Dining & Coffee');
eq('A&W #5521', 'A&W', 'Dining & Coffee');
eq('SQ *CAFE MYRIADE', 'Cafe Myriade', null);
eq('BOULANGERIE ST-VIATEUR 1234 MTL', 'Boulangerie St-Viateur', 'Dining & Coffee');
eq('ST-VIATEUR BAGEL', 'St-Viateur Bagel', 'Dining & Coffee');
eq('Pharmacie Chez Marie 123', 'Pharmacie Chez Marie 123', 'Health & Personal Care');
eq('PATISSERIE DE GASPE', 'Patisserie de Gaspe', 'Dining & Coffee');
eq('Première Moisson Atwater', 'Première Moisson', 'Dining & Coffee');

// delivery, transport, travel
eq('UBER *EATS HELP.UBER.COM', 'Uber Eats', 'Food Delivery');
eq('UBER   *TRIP HELP.UBER.COM', 'Uber', 'Transport');
eq('DOORDASH*PIZZA', 'DoorDash', 'Food Delivery');
eq('STM-OPUS RECHARGE', 'STM', 'Transport');
eq('STM 5555', 'STM', 'Transport');
eq('PETRO-CANADA 12345 LAVAL', 'Petro-Canada', 'Transport');
eq('ULTRAMAR #4471', 'Ultramar', 'Transport');
eq('BIXI MONTREAL', 'BIXI', 'Transport');
eq('STATIONNEMENT PLACE VILLE MARIE', 'Stationnement Place Ville Marie', 'Transport');
eq('AIR CANADA 0142385', 'Air Canada', 'Travel');
eq('VIA RAIL CANADA', 'Via Rail', 'Travel');

// snacks, shopping, health, bills, subscriptions, entertainment
eq('COUCHE-TARD #2145', 'Couche-Tard', 'Snacks');
eq('DEPANNEUR CHEZ LOUIS', 'Depanneur Chez Louis', 'Snacks');
eq('7-ELEVEN STORE 40213', '7-Eleven', 'Snacks');
eq('DOLLARAMA #812', 'Dollarama', 'Shopping');
eq('AMZN Mktp CA*2K4HX', 'Amazon', 'Shopping');
eq('AMAZON.CA PRIME', 'Prime Video', 'Subscriptions & Software');
eq('RENAUD-BRAY MONTREAL', 'Renaud-Bray', 'Shopping');
eq('IKEA MONTREAL', 'IKEA', 'Shopping');
eq('SIMONS', 'Simons', 'Shopping');
eq('CANADIAN TIRE #078', 'Canadian Tire', 'Shopping');
eq('JEAN COUTU #123', 'Jean Coutu', 'Health & Personal Care');
eq('PHARMAPRIX 9005', 'Pharmaprix', 'Health & Personal Care');
eq('PHARMACIE BRUNET 889', 'Brunet', 'Health & Personal Care');
eq('CLINIQUE DENTAIRE MONT-ROYAL', 'Clinique Dentaire Mont-Royal', 'Health & Personal Care');
eq('HYDRO-QUEBEC', 'Hydro-Québec', 'Bills & Utilities');
eq('VIDEOTRON LTEE', 'Vidéotron', 'Bills & Utilities');
eq('BELL MOBILITE', 'Bell', 'Bills & Utilities');
eq('NETFLIX.COM', 'Netflix', 'Subscriptions & Software');
eq('CINEPLEX #9132', 'Cineplex', 'Entertainment');
eq('LOTO-QUEBEC', 'Loto-Québec', 'Entertainment');

// unknown stores keep their own words, tidied, with no category made up
eq('MYSTERY SHOP 4411 RUE X MONTREAL QC', 'Mystery Shop', null);
eq('LemFi', 'LemFi', null);
eq('Chez Pierre & Fils', 'Chez Pierre & Fils', null);
eq('', 'Unknown', null);
eq('   ', 'Unknown', null);

// things that must NOT be caught by a short word
ok(m.clean('METROPOLITAN SPA').category !== 'Groceries', 'Metropolitan is not Metro');
ok(m.clean('UBERALLES GMBH').category === null, 'only the word Uber is Uber, not any word starting with it');
ok(m.clean('BARBERSHOP').name !== 'Bar', 'barbershop is not a bar');
ok(m.clean('Subwaytile Co').category === null, 'Subwaytile is not Subway');

// the same store written many ways comes out the same, and cleaning twice changes nothing
const variants = ['Saq23028faubourg Ste-Cat', 'SAQ 23028', 'saq express 23099 montreal qc', 'SAQ'];
ok(new Set(variants.map((v) => m.clean(v).name)).size === 1, 'every spelling of the SAQ gives one name');
ok(new Set(variants.map((v) => m.keyOf(v))).size === 1, 'and one key');
const all = ['MARCHE THARSNIO 4411 MONTREAL', 'TIM HORTONS #4567 MONTREAL QC', 'Mystery Shop 4411 Rue X', "McDonald's", 'SQ *CAFE MYRIADE', 'Fruiterie 440 Laval', 'Chez Pierre & Fils'];
ok(all.every((x) => m.clean(m.clean(x).name).name === m.clean(x).name), 'cleaning a clean name changes nothing');
ok(m.clean('UBER *EATS').name !== m.clean('UBER *TRIP').name, 'Uber Eats and Uber stay apart');

// every category it can return is one the app knows
const used = new Set();
['SAQ', 'METRO', 'TIM HORTONS', 'UBER EATS', 'STM', 'AIR CANADA', 'NETFLIX', 'DOLLARAMA', 'JEAN COUTU', 'HYDRO-QUEBEC', 'CINEPLEX', 'COUCHE-TARD'].forEach((x) => used.add(m.clean(x).category));
ok([...used].every((c) => m.CATS.includes(c)), 'every category it returns is one the app has');
ok(m.brands > 450, 'the store list is big: ' + m.brands + ' patterns');

// speed: thousands of rows with a few hundred different stores is instant, because each one is worked out once
const t0 = Date.now();
for (let i = 0; i < 20000; i++) m.clean('STORE ' + (i % 300) + ' MONTREAL QC');
ok(Date.now() - t0 < 600, 'a big list of purchases is fast (' + (Date.now() - t0) + ' ms for 20000)');

console.log('\nALL PASSED:', pass);
