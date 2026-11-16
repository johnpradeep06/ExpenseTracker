'use strict';
// Learning from a person's own marks. Every time someone marks a purchase necessary or unnecessary, the app looks at all
// their marks and works out two habits:
//   - a STORE habit: they marked this store the same way at least twice, and at least 3 times in 4 (Tim Hortons: unnecessary)
//   - a CATEGORY habit: at least 4 marks in a category, at least 4 in 5 the same way (their Shopping is mostly necessary)
// The next payment without a mark of its own then starts from the habit instead of the app's general guess. A mark the
// person made always wins, and nothing here leaves the server: no AI company is involved, it is plain counting.
const MIN_STORE = 2;
const STORE_SHARE = 0.75;
const MIN_CAT = 4;
const CAT_SHARE = 0.8;

const tally = (map, key, mark) => {
  const t = map[key] || (map[key] = { need: 0, fun: 0 });
  t[mark] += 1;
};
const decide = (map, min, share) => {
  const out = {};
  Object.keys(map).forEach((k) => {
    const { need, fun } = map[k];
    const n = need + fun;
    if (n < min) return;
    if (need / n >= share) out[k] = 'need';
    else if (fun / n >= share) out[k] = 'fun';
  });
  return out;
};

// rows: [{ key (the store), category, mark: 'need' | 'fun' }] -> { stores, cats, marks }
const build = (rows) => {
  const stores = {};
  const cats = {};
  let marks = 0;
  (rows || []).forEach((r) => {
    if (!r || (r.mark !== 'need' && r.mark !== 'fun')) return;
    marks += 1;
    if (r.key) tally(stores, r.key, r.mark);
    if (r.category) tally(cats, r.category, r.mark);
  });
  return { stores: decide(stores, MIN_STORE, STORE_SHARE), cats: decide(cats, MIN_CAT, CAT_SHARE), marks };
};

module.exports = { build, MIN_STORE, STORE_SHARE, MIN_CAT, CAT_SHARE };
