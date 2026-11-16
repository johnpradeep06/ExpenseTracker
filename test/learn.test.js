// Tests of learning from a person's own marks (lib/learn.js). Run: node test/learn.test.js
'use strict';
const assert = require('assert');
const { build } = require('../lib/learn');
let pass = 0;
const ok = (c, l) => { assert.ok(c, l); pass++; console.log('  ok', l); };
const eq = (a, b, l) => { assert.deepStrictEqual(a, b, l + ' (got ' + JSON.stringify(a) + ')'); pass++; console.log('  ok', l); };
const m = (key, category, mark, n) => Array.from({ length: n }, () => ({ key, category, mark }));

eq(build([]), { stores: {}, cats: {}, marks: 0 }, 'no marks, nothing learned');
eq(build(m('timhortons', 'Dining & Coffee', 'fun', 1)).stores, {}, 'one mark is not a habit yet');
eq(build(m('timhortons', 'Dining & Coffee', 'fun', 2)).stores, { timhortons: 'fun' }, 'the same store marked the same way twice is a habit');
eq(build(m('metro', 'Groceries', 'need', 3).concat(m('metro', 'Groceries', 'fun', 1))).stores, { metro: 'need' }, 'three in four is still a habit');
eq(build(m('metro', 'Groceries', 'need', 2).concat(m('metro', 'Groceries', 'fun', 1))).stores, {}, 'two in three is not (a store you mark both ways is left to the app)');
eq(build(m('a', 'Shopping', 'need', 1).concat(m('b', 'Shopping', 'need', 1), m('c', 'Shopping', 'need', 1))).cats, {}, 'three marks are not enough for a category habit');
eq(build(['a', 'b', 'c', 'd'].flatMap((k) => m(k, 'Shopping', 'need', 1))).cats, { Shopping: 'need' }, 'four marks the same way across different stores make a category habit');
eq(build(['a', 'b', 'c', 'd', 'e'].flatMap((k, i) => m(k, 'Shopping', i === 4 ? 'fun' : 'need', 1))).cats, { Shopping: 'need' }, 'four in five is a habit');
eq(build(['a', 'b', 'c', 'd', 'e'].flatMap((k, i) => m(k, 'Shopping', i >= 3 ? 'fun' : 'need', 1))).cats, {}, 'three in five is not');
eq(build([{ key: 'x', category: 'Other', mark: '' }, { key: 'y', category: 'Other', mark: 'maybe' }, null, undefined]).marks, 0, 'anything that is not a real mark is ignored');
eq(build(m('', 'Other', 'fun', 4)).stores, {}, 'a payment with no store name teaches no store habit');
eq(build(m('a', 'Other', 'fun', 4)).marks, 4, 'it counts the marks');
console.log('\nALL PASSED:', pass);
