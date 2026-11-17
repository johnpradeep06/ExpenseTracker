'use strict';
// One place that talks to Google's Gemini, for both jobs (sorting stores, reading a bill photo).
//
// Google renames and retires models from time to time ("this model is no longer available to new users"). So each job has a
// short list of models to try in order: when one answers 404 (gone), the next is tried. An explicit setting (CATEGORY_MODEL
// or BILL_MODEL) is used on its own. Any other failure stops at once and says why, in Google's own words, which holds no secret.
const keyOf = () => String(process.env.GEMINI_API_KEY || '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
const configured = () => !!keyOf();

const timeout = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

// Asks Google which models this key can use, and picks the newest stable Flash-Lite (the cheapest, and free): so when Google
// retires a name the app finds the current one by itself. Remembered for an hour per server instance.
let found = { at: 0, list: [] };
const discover = async () => {
  if (Date.now() - found.at < 3600000 && found.list.length) return found.list;
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': keyOf() }, signal: timeout(8000) });
  if (!r.ok) return [];
  const j = await r.json();
  const ok = (m) => (m.supportedGenerationMethods || []).includes('generateContent');
  const version = (n) => { const m = /gemini-(\d+(?:\.\d+)?)-flash-lite$/.exec(n); return m ? Number(m[1]) : 0; };
  const names = (j.models || []).filter(ok).map((m) => String(m.name || '').replace(/^models\//, '')).filter((n) => version(n) > 0);   // stable names only: no -preview, no dates
  names.sort((a, b) => version(b) - version(a));
  found = { at: Date.now(), list: names.slice(0, 3) };
  return found.list;
};

// models: ['a', 'b'] -> the text of the answer. Throws an Error with .status and .detail.
const generate = async ({ models, parts, config, ms }, opts = {}) => {
  let last = null;
  for (const model of models) {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': keyOf() },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: config }),
      signal: timeout(ms || 24000)
    });
    if (r.ok) {
      const j = await r.json();
      const out = (((j.candidates || [])[0] || {}).content || {}).parts || [];
      return out.map((p) => p.text || '').join('');
    }
    let why = '';
    try { const j = await r.json(); why = String((j && j.error && (j.error.message || j.error.status)) || '').replace(/\s+/g, ' ').slice(0, 160); } catch (e) { /* no body */ }
    const err = new Error('the reader answered ' + r.status);
    err.status = r.status;
    err.detail = 'Google answered ' + r.status + (why ? ': ' + why : '');
    last = err;
    if (r.status !== 404) throw err;           // a bad key, no quota, a bad request: another model would not help
  }
  // Every name on the list is gone: ask Google what is current, and try those (once).
  if (last && last.status === 404 && !opts.noDiscover) {
    let names = [];
    try { names = (await discover()).filter((n) => !models.includes(n)); } catch (e) { /* keep the first error */ }
    if (names.length) return generate({ models: names, parts, config, ms }, { noDiscover: true });
  }
  throw last || new Error('no model to try');
};

module.exports = { configured, generate, keyOf, discover };
