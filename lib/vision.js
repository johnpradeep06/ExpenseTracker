'use strict';
// Reads one store bill from a photo with an AI vision model, and returns what it found as plain data.
//
// Which company's model is used depends on which key is set on the server:
//   ANTHROPIC_API_KEY  -> Claude   (model: BILL_MODEL, default claude-haiku-5-5)
//   GEMINI_API_KEY     -> Gemini   (model: BILL_MODEL, default gemini-2.5-flash)
// With neither, bill scanning is simply switched off (configured() is false) and nothing else changes.
//
// The photo is sent to the model once, for this one question, and is never stored by this app. The model's answer is
// treated as untrusted text: lib/bills.js checks and cleans every number before anything is shown or saved.
// A key pasted into a settings page often carries a stray space, a line break or quotes around it. None of those belong to the
// key, and any of them makes the provider answer "key not valid", so they are taken off.
const env = (k) => String(process.env[k] || '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();

const PROMPT = `You read ONE store receipt from a photo. It is from Quebec or elsewhere in Canada, usually in French (sometimes English, or both).
Extract only what is printed. Reply with ONLY a JSON object, no explanation and no code fences:
{"store": string, "date": "YYYY-MM-DD" or "", "items": [{"name": string, "qty": number, "price": number, "kind": "need" | "fun" | "unk"}], "subtotal": number or null, "tax": number or null, "total": number or null}

Rules:
- "name" is the item as printed (tidy the spacing only). "price" is that line's total in dollars. "qty" is 1 when not shown.
- Decimal commas are decimals: 4,99 means 4.99.
- List ONLY purchased items. Do NOT list subtotal, TPS, TVQ, GST, QST, HST, tax, total, payment lines (VISA, MASTERCARD, DEBIT, INTERAC, COMPTANT, CASH), change (MONNAIE), loyalty or points lines, store address or phone, cashier or terminal lines, or any card number.
- A discount line (RABAIS, ECONOMIE, COUPON, or a negative amount) belongs to the item above it: list it as its own line with a negative price, named like the item plus " (rabais)".
- A weight line like "1,234 kg @ 4,99/kg" belongs to the item above it: use the line total as the price.
- A deposit line (CONSIGNE, DEPOT) is an item with kind "unk".
- "kind": "need" for food you cook at home, basic household and hygiene supplies, medicine, and everyday essentials. "fun" for alcohol, chips and snacks, candy, soft drinks and energy drinks, desserts and ice cream, and restaurant or take-out food. "unk" when you are not sure.
- Never invent an item or a price. If a line is unreadable, leave it out.
- If the image is not a receipt or cannot be read, reply {"items":[],"error":"not a receipt"}.`;

const configured = () => !!(env('ANTHROPIC_API_KEY') || env('GEMINI_API_KEY'));
const provider = () => (env('ANTHROPIC_API_KEY') ? 'anthropic' : env('GEMINI_API_KEY') ? 'gemini' : '');

const timeout = () => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(24000) : undefined);

const askAnthropic = async (image, mime, text) => {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: env('BILL_MODEL') || 'claude-haiku-5-5',
      max_tokens: 3000,
      temperature: 0,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mime, data: image } }, { type: 'text', text }] }]
    }),
    signal: timeout()
  });
  if (!r.ok) throw new Error('the reader answered ' + r.status);
  const j = await r.json();
  return (j.content || []).map((c) => c.text || '').join('');
};

const askGemini = async (image, mime, text) => {
  const model = env('BILL_MODEL') || 'gemini-2.5-flash';
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': env('GEMINI_API_KEY') },
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: mime, data: image } }, { text }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' }
    }),
    signal: timeout()
  });
  if (!r.ok) throw new Error('the reader answered ' + r.status);
  const j = await r.json();
  const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map((p) => p.text || '').join('');
};

// The model's answer as an object, however it wrapped it.
const extractJson = (text) => {
  const t = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('the reader did not answer with data');
  return JSON.parse(t.slice(a, b + 1));
};

// Tests swap in a fake reader here, so no real photo or key is ever needed.
let fake = null;
const setReader = (fn) => { fake = fn; };

// { image: base64 (no prefix), mime, hint: { store, amount } } -> the parsed object from the model
const readBill = async ({ image, mime, hint }) => {
  if (fake) return fake({ image, mime, hint });
  if (!configured()) throw new Error('bill scanning is not switched on');
  const note = hint && (hint.store || hint.amount)
    ? '\n\nFor reference only (do not copy it): this purchase was logged as ' + (hint.store ? 'store "' + String(hint.store).slice(0, 60) + '"' : 'a store') + (hint.amount ? ' with a card amount of about $' + Number(hint.amount).toFixed(2) : '') + '.'
    : '';
  const text = PROMPT + note;
  const answer = provider() === 'anthropic' ? await askAnthropic(image, mime, text) : await askGemini(image, mime, text);
  return extractJson(answer);
};

module.exports = { configured, provider, readBill, setReader, extractJson, PROMPT };
