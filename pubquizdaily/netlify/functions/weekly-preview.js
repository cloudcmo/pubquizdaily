// netlify/functions/weekly-preview.js
// Thursday ~18:30 UK: builds the upcoming Friday "Weekly Best-of" teaser and
// emails a PREVIEW to the admin, 12 hours before the real send, with a
// one-click "cancel this week" button. The built email is stored so Friday's
// broadcast sends exactly what was previewed.
//
// DST-proof: netlify.toml fires this at 17:30 AND 18:30 UTC on Thursdays; the
// gate below only proceeds when it's the 18:xx hour in Europe/London, so
// exactly one firing runs and it's always ~18:30 UK year-round.
//
// The email is a TEASER whose only job is the click-through to the weekly page.
// Intro copy is written by an AI model from the week's questions (with a
// templated fallback). Subject line is one of the actual questions. Stats are
// percentages only.
//
// It also carries a small "New game" promo for Whenly (the daily guess-the-year
// game). The promo looks at the questions live on Whenly for the SEND day (the
// Friday), teases 2-3 of them without revealing any years, and links out to
// whenly.co.uk. Everything Whenly is best-effort: any failure just drops the
// promo block — it must never hold up the Pub Quiz Daily email.

const crypto = require('crypto');

const BASE = 'https://pubquizdaily.com';
const WEEKLY_URL = `${BASE}/weekly.html`;
const MIN_SAMPLE = 4;                 // hide a % until at least this many answers
// How many questions to auto-pick for the week when nobody flagged any "W"
// in the sheet (Carl's manual weekly-picking step is retired as of 2026-08-13
// — see WEEKLY_AUTO_SELECT_COUNT usage in fetchWeeklyQuestions below).
const WEEKLY_AUTO_SELECT_COUNT = 11;
// Gemini model fallback chain. Honour GEMINI_MODEL if set, then try current
// models in turn. Old model names get retired by Google (gemini-1.5-flash is
// gone), so we never hard-depend on a single one — and if all fail we fall back
// to templated copy and say why in the admin preview.
// Preferred models tried first (fast path). If all fail, callGemini discovers
// what the key can actually use via ListModels. GEMINI_MODEL env overrides.
const GEMINI_MODELS = [process.env.GEMINI_MODEL, 'gemini-flash-latest', 'gemini-2.0-flash', 'gemini-flash-lite-latest'].filter(Boolean);

// ── What Word promo (best-effort; never blocks the main email) ──
const WHATWORD_URL = process.env.WHATWORD_URL || 'https://what-word.carl-b82.workers.dev';
// The What Word admin token lets the Thursday-evening build read FRIDAY's
// puzzle (the API refuses future dates to everyone else). Set this on the
// Netlify site: WHATWORD_ADMIN_TOKEN = contents of whatword's .admin-token.
const WHATWORD_ADMIN_TOKEN = process.env.WHATWORD_ADMIN_TOKEN;

// ── Groupie promo (best-effort; never blocks the main email) ──
const GROUPIE_URL = process.env.GROUPIE_URL || 'https://groupie.fun';
// The Groupie admin token lets the Thursday-evening build read FRIDAY's grid
// (the API refuses future dates to everyone else). Set this on the Netlify
// site: GROUPIE_ADMIN_TOKEN = contents of groupie's .admin-token.
const GROUPIE_ADMIN_TOKEN = process.env.GROUPIE_ADMIN_TOKEN;

// ── Whenly promo (best-effort; never blocks the main email) ──
const WHENLY_URL = 'https://whenly.co.uk';
// The same published Google Sheet CSV the Whenly site reads live. Overridable
// via env in case the publish URL ever changes.
const WHENLY_CSV_URL = process.env.WHENLY_CSV_URL ||
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vRKuWEwG1PTSq_Dw__0dwml7T-1tyo7803kRMp_-SMlyxflp1x4MjUZw9HNUKfUysfwoPtOAjLrIwHn/pub?output=csv';

exports.handler = async function() {
  // ── DST-proof gate: only the ~18:xx UK firing proceeds ──
  if (londonHour() !== 18) {
    console.log(`weekly-preview: not the 18:00 UK hour (London hour ${londonHour()}) — skipping`);
    return { statusCode: 200, body: 'Not the scheduled UK hour' };
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const SHEET_ID       = process.env.GOOGLE_SHEET_ID;
  const API_KEY        = process.env.GOOGLE_API_KEY;
  const SITE_ID        = process.env.NETLIFY_SITE_ID;
  const TOKEN          = process.env.NETLIFY_API_TOKEN;
  const REPORT_EMAIL   = process.env.DAILY_REPORT_EMAIL;
  const CANCEL_TOKEN   = process.env.WEEKLY_CANCEL_TOKEN;

  if (!RESEND_API_KEY || !SHEET_ID || !API_KEY || !SITE_ID || !TOKEN || !REPORT_EMAIL || !CANCEL_TOKEN) {
    console.error('weekly-preview: missing required env vars');
    return { statusCode: 500, body: 'Missing env vars' };
  }
  const authHeader = { 'Authorization': `Bearer ${TOKEN}` };

  // Friday = tomorrow (in UK time). Window = the 7 days before Friday.
  const fridayISO = addDaysISO(londonDateISO(), 1);

  try {
    const questions = await fetchWeeklyQuestions({ SHEET_ID, API_KEY, fridayISO, SITE_ID, TOKEN });
    if (questions.length === 0) {
      console.log('weekly-preview: no W questions for this week — nothing to build.');
      // Tell the admin so a blank Friday isn't a surprise.
      await sendEmail(RESEND_API_KEY, REPORT_EMAIL,
        '[Pub Quiz Daily] No weekly questions this week',
        'Heads up: no questions are flagged "W" for the week ending Thursday, so no Friday Best-of will be built or sent. Flag some in the sheet if that\'s not intended.',
        null);
      return { statusCode: 200, body: 'No weekly questions' };
    }

    const avgPct = weeklyAvgPct(questions);
    const statText = avgPct !== null ? `Players are averaging <strong>${avgPct}%</strong> on these. How would you do?` : null;

    const subjectQ = pickSubjectQuestion(questions, fridayISO);
    const hero = (subjectQ && subjectQ.image) || (questions.find(q => q.image) || {}).image || null;

    let aiIntroNote;
    const copy = await generateCopy(questions)
      .then(c => { aiIntroNote = `intro copy generated by ${c._model}`; return c; })
      .catch(err => {
        console.error('AI copy failed, using fallback:', err.message);
        aiIntroNote = `intro copy FELL BACK to template: ${err.message}`;
        return fallbackCopy(questions);
      });

    // Whenly cross-promo — teases the SEND day's live Whenly questions. Fully
    // best-effort: on any error we get null and the block is simply omitted.
    const whenlyPromo = await buildWhenlyPromo(fridayISO).catch(err => {
      console.error('Whenly promo failed, omitting block:', err);
      return null;
    });
    const aiWhenlyNote = whenlyPromo ? whenlyPromo.note : 'no Whenly promo this week';

    // What Word cross-promo — teases the SEND day's three words. Same
    // best-effort contract as Whenly: any failure just omits the block.
    const whatwordPromo = await buildWhatWordPromo(fridayISO).catch(err => {
      console.error('What Word promo failed, omitting block:', err);
      return null;
    });
    const aiWhatWordNote = whatwordPromo ? whatwordPromo.note : 'no What Word promo this week';

    // Groupie cross-promo — teases the SEND day's sixteen-word grid. Same
    // best-effort contract as the others: any failure just omits the block.
    const groupiePromo = await buildGroupiePromo(fridayISO).catch(err => {
      console.error('Groupie promo failed, omitting block:', err);
      return null;
    });
    const aiGroupieNote = groupiePromo ? groupiePromo.note : 'no Groupie promo this week';

    // Clean email that Friday will send (unsubscribe placeholder swapped at send time).
    const cleanHtml = buildTeaserHtml({
      kicker: copy.kicker, headline: copy.headline, intro: copy.intro,
      hero, statText, fridayISO, whenlyPromo, whatwordPromo, groupiePromo,
    });
    const subject = subjectQ ? subjectQ.question : "This week's Pub Quiz Daily Best-of 🍺";

    // Store what will be sent, so Friday sends exactly this.
    await putBlob(SITE_ID, TOKEN, `weekly-built-${fridayISO}`, { subject, html: cleanHtml, builtAt: new Date().toISOString() });
    // Fresh week starts uncancelled (clear any stale flag).
    await deleteBlob(SITE_ID, TOKEN, `weekly-cancel-${fridayISO}`);

    // Preview = the real email, wrapped with a cancel banner.
    const cancelUrl = `${BASE}/.netlify/functions/weekly-cancel?token=${encodeURIComponent(CANCEL_TOKEN)}&week=${fridayISO}`;
    const previewHtml = buildPreviewWrapper(cleanHtml.replace('%%UNSUB%%', '#'), { subject, fridayISO, cancelUrl, aiIntroNote, aiWhenlyNote, aiWhatWordNote, aiGroupieNote });

    await sendEmail(RESEND_API_KEY, REPORT_EMAIL,
      `[Preview] ${subject}  (sends 06:30 tomorrow)`,
      `Preview of tomorrow's Weekly Best-of (sends 06:30 UK).\nSubject: ${subject}\nTo cancel this week's send, open: ${cancelUrl}`,
      previewHtml);

    console.log(`weekly-preview: built + previewed for ${fridayISO} (${questions.length} questions)`);
    return { statusCode: 200, body: 'Preview sent' };

  } catch (e) {
    console.error('weekly-preview error:', e);
    return { statusCode: 500, body: 'Internal error' };
  }
};

// ── Content ──────────────────────────────────────────────────────────────────

async function fetchWeeklyQuestions({ SHEET_ID, API_KEY, fridayISO, SITE_ID, TOKEN }) {
  const validDates = new Set();
  for (let i = 1; i <= 7; i++) validDates.add(addDaysISO(fridayISO, -i)); // last Fri..Thu

  const range = encodeURIComponent('multi!A:J');
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?key=${API_KEY}`);
  if (!res.ok) throw new Error(`Sheets API ${res.status}`);
  const rows = ((await res.json()).values || []).slice(1);

  // per-day index (position within that date, in sheet order) = the N in the stats key
  const perDay = {};
  const out = [];
  const candidates = []; // every complete row in the window, W or not — the auto-select pool
  rows.forEach((row, i) => {
    const isoDate = parseFlexDate((row[0] || '').trim());
    if (!isoDate) return;
    const idx = (perDay[isoDate] = (perDay[isoDate] ?? -1) + 1);
    if (!validDates.has(isoDate)) return;
    const [, question, a, b, c, d, correct, explainer, , image] = row;
    if (!question || !a || !b || !c || !d || !correct) return;
    const sheetRow = i + 2; // rows[] had the header row sliced off
    candidates.push({ sheetRow, date: isoDate, index: idx, question: question.trim(), image: image ? image.trim() : null });
    if ((row[8] || '').trim().toUpperCase() === 'W') {
      out.push({ date: isoDate, index: idx, question: question.trim(), image: image ? image.trim() : null });
    }
  });

  // Nobody flagged any "W" questions this week (Carl no longer does this by
  // hand) — automatically pick WEEKLY_AUTO_SELECT_COUNT at random from the
  // week's complete questions and write "W" back into the sheet for them, so
  // the archive/weekly.html game and this email agree on the same picks, and
  // next week's auto-select (or a human flagging early) is unaffected.
  if (out.length === 0 && candidates.length > 0) {
    const pool = candidates.slice();
    shuffleInPlace(pool);
    const picks = pool.slice(0, WEEKLY_AUTO_SELECT_COUNT);
    try {
      await writeWeeklyFlags(SHEET_ID, picks.map(p => p.sheetRow));
      console.log(`weekly-preview: auto-selected ${picks.length} question(s) for the week ending ${addDaysISO(fridayISO, -1)} (rows ${picks.map(p => p.sheetRow).join(', ')})`);
      out.push(...picks.map(({ sheetRow, ...q }) => q));
    } catch (e) {
      console.error('weekly-preview: auto-select W write failed:', e.message || e);
      // Fall through with out still empty — caller treats this the same as
      // "nothing to build" rather than silently sending unflagged content.
    }
  }

  out.sort((x, y) => x.date.localeCompare(y.date));

  // attach stats
  const authHeader = { 'Authorization': `Bearer ${TOKEN}` };
  await Promise.all(out.map(async q => {
    try {
      const r = await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/quiz-stats/${q.date}-${q.index}`, { headers: authHeader });
      if (!r.ok) return;
      const d = await r.json();
      q.total = d.total || 0; q.correctCount = d.correctCount || 0;
    } catch { /* ignore */ }
  }));
  return out;
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ── Sheet writes (auto-select fallback only) ────────────────────────────────
// Everything else in this file only READS the sheet via GOOGLE_API_KEY. Writing
// the auto-picked "W" flags needs Editor access, so this uses the same service
// account already granted Editor on the sheet for scripts/draft-questions.js
// and scripts/assign-weekly.js (GOOGLE_SERVICE_ACCOUNT_JSON = that account's
// JSON key, set as a Netlify secret). If it's not configured, the auto-select
// caller catches the error and treats it as nothing-to-build.

let _sheetsAccessToken; // { token, exp } — reused across calls within a cold start
async function getSheetsAccessToken() {
  if (_sheetsAccessToken && _sheetsAccessToken.exp > Date.now() / 1000 + 60) {
    return _sheetsAccessToken.token;
  }
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set — cannot write to the sheet');
  const serviceAccount = JSON.parse(raw);

  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };
  const base64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unsigned = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(claim)))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = base64url(signer.sign(serviceAccount.private_key));
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!res.ok) throw new Error(`Google auth failed: ${await res.text()}`);
  const data = await res.json();
  _sheetsAccessToken = { token: data.access_token, exp: now + (data.expires_in || 3600) };
  return data.access_token;
}

// Writes 'W' into column I of the "multi" tab for the given sheet row numbers.
async function writeWeeklyFlags(sheetId, sheetRows) {
  if (!sheetRows.length) return;
  const accessToken = await getSheetsAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      valueInputOption: 'RAW',
      data: sheetRows.map(row => ({ range: `multi!I${row}`, values: [['W']] })),
    }),
  });
  if (!res.ok) throw new Error(`Failed to write W flags: ${await res.text()}`);
}

function weeklyAvgPct(questions) {
  let c = 0, t = 0;
  for (const q of questions) if ((q.total || 0) >= MIN_SAMPLE) { c += q.correctCount; t += q.total; }
  return t >= MIN_SAMPLE ? Math.round((c / t) * 100) : null;
}

function pickSubjectQuestion(questions, fridayISO) {
  const short = questions.filter(q => q.question.length <= 62);
  const pool = short.length ? short : questions;
  const week = weekOfYear(fridayISO);
  return pool[week % pool.length];
}

// Ask the API which models THIS key can actually call for generateContent.
// Model availability varies by project/account (new projects get 404
// "no longer available to new users" for older names), so we discover rather
// than hard-depend on a list.
async function listGenerateModels(key) {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=1000`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => (m.name || '').replace(/^models\//, ''))
      .filter(Boolean);
  } catch { return []; }
}

// Prefer newer, general Flash models; avoid preview/experimental and non-text.
function rankModel(a, b) {
  const score = n => {
    let s = 0;
    if (/latest/.test(n)) s += 1000;
    if (/flash/.test(n)) s += 500;
    if (/lite/.test(n)) s -= 40;
    if (/preview|exp|thinking|image|tts|audio|embedding|vision/.test(n)) s -= 300;
    const m = n.match(/gemini-(\d+(?:\.\d+)?)/);
    if (m) s += parseFloat(m[1]) * 10;
    return s;
  };
  return score(b) - score(a);
}

// Try one model. Disables "thinking" (thinkingBudget:0) so the token budget goes
// to the answer, not hidden reasoning — current Flash models otherwise return
// truncated/empty text. Uses a generous ceiling. If a model rejects thinkingConfig
// (400), retries it without that field. Returns { ok, text } or { ok:false, err }.
async function tryModel(model, prompt, generationConfig, key) {
  const big = Math.max(generationConfig.maxOutputTokens || 0, 2048);
  const configs = [
    { ...generationConfig, maxOutputTokens: big, thinkingConfig: { thinkingBudget: 0 } },
    { ...generationConfig, maxOutputTokens: big },
  ];
  let err = 'not tried';
  for (const cfg of configs) {
    let res;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: cfg }) }
      );
    } catch (e) { err = e.message; break; }
    if (!res.ok) {
      err = `${res.status} ${(await res.text()).replace(/\s+/g, ' ').slice(0, 90)}`;
      if (res.status === 400 && cfg.thinkingConfig) continue; // maybe the thinking field; retry without it
      break;
    }
    const cand = (await res.json())?.candidates?.[0];
    const text = (cand?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '').trim();
    if (text) return { ok: true, text };
    err = `empty (finishReason ${cand?.finishReason || '?'})`;
    if (cfg.thinkingConfig) continue; // truncated by thinking; the no-think retry may help
    break;
  }
  return { ok: false, err };
}

// Calls Gemini for `prompt`. Tries the preferred models first, then whatever the
// key reports it can use (Flash preferred). Returns { text, model }. On total
// failure, throws with every attempt AND the list of models the key can use, so
// the admin preview names exactly what to switch to.
let _workingModel = null; // remembered across calls so the 2nd call skips discovery

async function callGemini(prompt, generationConfig) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  const tried = new Set();
  const attempts = [];
  // Fast path: the last-known-good model first, then the preferred list.
  for (const model of [_workingModel, ...GEMINI_MODELS]) {
    if (!model || tried.has(model)) continue;
    tried.add(model);
    const r = await tryModel(model, prompt, generationConfig, key);
    if (r.ok) { _workingModel = model; return { text: r.text, model }; }
    attempts.push(`${model} -> ${r.err}`);
  }
  // Discovery: whatever this key can actually use (Flash preferred).
  const avail = await listGenerateModels(key);
  for (const model of avail.filter(n => !tried.has(n)).sort(rankModel).slice(0, 6)) {
    tried.add(model);
    const r = await tryModel(model, prompt, generationConfig, key);
    if (r.ok) { _workingModel = model; return { text: r.text, model }; }
    attempts.push(`${model} -> ${r.err}`);
  }
  const availNote = avail.length ? ` | key can use: ${avail.slice(0, 14).join(', ')}` : ' | ListModels returned nothing';
  throw new Error(attempts.join(' ; ') + availNote);
}

async function generateCopy(questions) {
  const list = questions.map((q, i) => `${i + 1}. ${q.question}`).join('\n');
  const prompt =
`You write short, witty teaser emails for "Pub Quiz Daily", a fun British daily pub quiz. Below are this week's Best-of questions. Write lean, punchy copy that entices readers to click through and play, WITHOUT revealing any answers. Never use em dashes ("—"); use short sentences, commas or full stops instead.

Return ONLY minified JSON (no markdown) with keys:
"kicker": <=6 words, may include one tasteful emoji;
"headline": <=8 words, punchy;
"intro": 1-2 sentences, <=45 words, name-drop 2-3 of the most intriguing topics.

Questions:
${list}`;

  const { text: raw, model } = await callGemini(prompt, { temperature: 0.9, maxOutputTokens: 800 });
  let text = raw.replace(/```json/gi, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(text);
  if (!parsed.kicker || !parsed.headline || !parsed.intro) throw new Error('AI copy missing fields');
  return {
    kicker: noEmDash(String(parsed.kicker)).slice(0, 40),
    headline: noEmDash(String(parsed.headline)).slice(0, 80),
    intro: noEmDash(String(parsed.intro)).slice(0, 300),
    _model: model,
  };
}

function fallbackCopy(questions) {
  return {
    kicker: 'The Friday Best-of 🍺',
    headline: "This week's finest",
    intro: `${questions.length} of the week's best questions, about ninety seconds of fun. See how many you'd have got.`,
  };
}

// ── Whenly cross-promo ───────────────────────────────────────────────────────

// Returns { teaser } for the send day's Whenly questions, or null if there's
// nothing to show / anything goes wrong. `teaser` is one short sentence that
// name-drops 2-3 of the day's topics and never reveals a year.
async function buildWhenlyPromo(fridayISO) {
  const questions = await fetchWhenlyQuestions(fridayISO);
  if (!questions.length) {
    console.log('weekly-preview: no Whenly questions for', fridayISO, '— omitting promo.');
    return null;
  }
  try {
    const { text, model } = await generateWhenlyTeaser(questions);
    return { teaser: text, note: `Whenly teaser generated by ${model}` };
  } catch (err) {
    console.error('Whenly AI teaser failed, using fallback:', err.message);
    return { teaser: fallbackWhenlyTeaser(questions), note: `Whenly teaser FELL BACK to template: ${err.message}` };
  }
}

// Reads the same published CSV the Whenly site reads live, and returns the rows
// dated for the given day (the day the reader will actually play). Shape:
// { category, question }.
async function fetchWhenlyQuestions(dayISO) {
  const res = await fetch(WHENLY_CSV_URL);
  if (!res.ok) throw new Error(`Whenly CSV ${res.status}`);
  const rows = parseCsv(await res.text());
  return rows
    .filter(r => (r.date || '').trim() === dayISO && (r.question || '').trim())
    .map(r => ({ category: (r.category || '').trim(), question: r.question.trim() }));
}

// Minimal CSV parser matching the one on the Whenly site (quoted fields, no
// embedded newlines). Handles \r\n line endings from Google's published CSV.
function parseCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').trim().split('\n');
  if (lines.length < 2) return [];
  const splitLine = line => {
    const vals = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') inQ = !inQ;
      else if (c === ',' && !inQ) { vals.push(cur); cur = ''; }
      else cur += c;
    }
    vals.push(cur);
    return vals;
  };
  const headers = splitLine(lines[0]).map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
  return lines.slice(1).map(line => {
    const vals = splitLine(line);
    const obj = {};
    headers.forEach((h, i) => obj[h] = (vals[i] || '').trim().replace(/^"|"$/g, ''));
    return obj;
  });
}

async function generateWhenlyTeaser(questions) {
  const list = questions.map((q, i) => `${i + 1}. ${q.question}`).join('\n');
  const prompt =
`"Whenly" is a fast, addictive British daily "guess the year" game: you're shown a historical event and you pin the year. Below are TODAY's Whenly questions. Write punchy promo copy that SELLS the game and makes people want to play right now.

Aim for 2 short, punchy sentences (<=35 words total). Name-drop 2-3 of today's most intriguing events, then throw down a challenge (e.g. "How sharp is your timeline?", "Think you can place them?").

STRICT RULES:
- NEVER state or hint at any year, decade or date. The whole game is guessing the year.
- Never use em dashes ("—"). Use full stops and commas.
- Refer to the events themselves (e.g. "the Falklands task force", "the ZX Spectrum", "Charles and Diana's wedding").
- Lean and forward, not passive. No preamble, no quotes, no markdown. Return ONLY the copy itself.

Today's questions:
${list}`;

  const { text: raw, model } = await callGemini(prompt, { temperature: 0.9, maxOutputTokens: 400 });
  let text = noEmDash(raw.replace(/```/g, '').replace(/^["']|["']$/g, '').trim());
  if (!text) throw new Error('empty Whenly teaser');
  // Reject implausibly short/truncated output (e.g. "From the") so we use the
  // clean template instead of rendering a fragment.
  if (text.length < 25) throw new Error(`Whenly teaser too short: ${JSON.stringify(text)}`);
  // Belt-and-braces: if the model leaks a 3-4 digit year anywhere, fall back to
  // the year-free template rather than spoil the game.
  if (/\b\d{3,4}\b/.test(text)) throw new Error('Whenly teaser leaked a year');
  return { text: text.slice(0, 240), model };
}

// Year-free fallback, used only if the AI teaser is unavailable. Deliberately
// generic: naming the events well is exactly what the AI does, and a clumsy
// half-parsed sentence would be worse than a clean one. Never leaks a year.
function fallbackWhenlyTeaser(questions) {
  const n = questions.length;
  const word = num => ({ 1: 'One', 2: 'Two', 3: 'Three' }[num] || String(num));
  const events = `${word(n)} event${n === 1 ? '' : 's'} today.`;
  const years = `${word(n)} year${n === 1 ? '' : 's'} to pin down.`;
  return `${events} ${years} Think you can place them?`;
}

// ── What Word cross-promo ────────────────────────────────────────────────────

// Returns { teaser, note } for the send day's What Word edition, or null.
// `teaser` is 1-2 short sentences that name-drop 2-3 of the day's words and
// never reveal what any of them mean — naming the words is the hook, defining
// them is the spoiler.
async function buildWhatWordPromo(fridayISO) {
  const questions = await fetchWhatWordQuestions(fridayISO);
  if (!questions.length) {
    console.log('weekly-preview: no What Word puzzle for', fridayISO, '— omitting promo.');
    return null;
  }
  try {
    const { text, model } = await generateWhatWordTeaser(questions);
    return { teaser: text, note: `What Word teaser generated by ${model}` };
  } catch (err) {
    console.error('What Word AI teaser failed, using fallback:', err.message);
    return { teaser: fallbackWhatWordTeaser(questions), note: `What Word teaser FELL BACK to template: ${err.message}` };
  }
}

// Reads the send day's puzzle from the What Word API. The admin token allows
// fetching tomorrow's (future) puzzle; without it this still works when the
// build day and send day are the same.
async function fetchWhatWordQuestions(dayISO) {
  const headers = WHATWORD_ADMIN_TOKEN ? { 'Authorization': `Bearer ${WHATWORD_ADMIN_TOKEN}` } : {};
  const res = await fetch(`${WHATWORD_URL}/api/puzzle?date=${dayISO}`, { headers });
  if (!res.ok) throw new Error(`What Word API ${res.status}`);
  const data = await res.json();
  return (data.questions || []).map(q => ({
    word: (q.word || '').trim(),
    type: (q.type || '').trim(),
    correct: (q.options && q.options[q.answer]) ? String(q.options[q.answer]) : '',
  })).filter(q => q.word);
}

async function generateWhatWordTeaser(questions) {
  const list = questions.map((q, i) => `${i + 1}. ${q.word} (${q.type} question)`).join('\n');
  const prompt =
`"What Word" is a daily game for people who love unusual words: three obscure but real English words a day, multiple choice, and every answer teaches you something. Below are the words in the day's edition. Write punchy promo copy that makes word-lovers want to play right now.

Aim for 2 short sentences (<=35 words total). Name-drop two or three of the day's words themselves, then throw down a challenge (e.g. "Know all three?", "How deep does your dictionary go?").

STRICT RULES:
- NEVER reveal or hint at what any word means, where it comes from, or which answer is right. Naming the words is the hook. Defining them is a spoiler.
- Never use em dashes ("—"). Use full stops and commas.
- No preamble, no quotes, no markdown. Return ONLY the copy itself.

The day's words:
${list}`;

  const { text: raw, model } = await callGemini(prompt, { temperature: 0.9, maxOutputTokens: 400 });
  let text = noEmDash(raw.replace(/```/g, '').replace(/^["']|["']$/g, '').trim());
  if (!text) throw new Error('empty What Word teaser');
  if (text.length < 25) throw new Error(`What Word teaser too short: ${JSON.stringify(text)}`);
  // Belt-and-braces: if the copy contains any correct answer, it's a spoiler —
  // use the clean template instead.
  const lower = text.toLowerCase();
  for (const q of questions) {
    if (q.correct && q.correct.length >= 8 && lower.includes(q.correct.toLowerCase())) {
      throw new Error(`What Word teaser leaked an answer (${q.word})`);
    }
  }
  return { text: text.slice(0, 240), model };
}

// Answer-free fallback: the words themselves are safe to name and are the
// whole appeal, so the template can use them directly.
function fallbackWhatWordTeaser(questions) {
  const words = questions.map(q => q.word).slice(0, 3);
  const listed = words.length > 1
    ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
    : words[0];
  return `Today's three: ${listed}. Four choices each, and every answer teaches you something. How many do you actually know?`;
}

// ── Groupie cross-promo ──────────────────────────────────────────────────────

// Returns { teaser, note } for the send day's Groupie grid, or null.
// `teaser` is 1-2 short sentences that name a few of the grid's words WITHOUT
// revealing any group, category name, or which words belong together — the
// sorting is the whole game, so any hint of a grouping is a spoiler.
async function buildGroupiePromo(fridayISO) {
  const groups = await fetchGroupieGrid(fridayISO);
  if (!groups.length) {
    console.log('weekly-preview: no Groupie grid for', fridayISO, '— omitting promo.');
    return null;
  }
  try {
    const { text, model } = await generateGroupieTeaser(groups);
    return { teaser: text, note: `Groupie teaser generated by ${model}` };
  } catch (err) {
    console.error('Groupie AI teaser failed, using fallback:', err.message);
    return { teaser: fallbackGroupieTeaser(groups), note: `Groupie teaser FELL BACK to template: ${err.message}` };
  }
}

// Reads the send day's grid from the Groupie API. The admin token allows
// fetching tomorrow's (future) grid; without it this still works when the
// build day and send day are the same.
async function fetchGroupieGrid(dayISO) {
  const headers = GROUPIE_ADMIN_TOKEN ? { 'Authorization': `Bearer ${GROUPIE_ADMIN_TOKEN}` } : {};
  const res = await fetch(`${GROUPIE_URL}/api/puzzle?date=${dayISO}`, { headers });
  if (!res.ok) throw new Error(`Groupie API ${res.status}`);
  const data = await res.json();
  return (data.groups || []).map(g => ({
    name: (g.name || '').trim(),
    words: (g.words || []).map(w => String(w).trim()).filter(Boolean),
  })).filter(g => g.name && g.words.length === 4);
}

async function generateGroupieTeaser(groups) {
  // The model sees the full solution so it can pick intriguing words from
  // DIFFERENT groups — but the rules forbid it from betraying any of it.
  const list = groups.map((g, i) => `Group ${i + 1} (SECRET name: "${g.name}"): ${g.words.join(', ')}`).join('\n');
  const prompt =
`"Groupie" is a daily British puzzle, sixteen words on a grid that the player must sort into four hidden groups of four, with red herrings everywhere. Below is the day's grid WITH ITS SECRET SOLUTION. Write punchy promo copy that makes people want to play right now.

Aim for 2 short sentences (<=35 words total). Name 3 or 4 of the grid's most intriguing words, each chosen from a DIFFERENT group, then throw down a challenge (e.g. "Can you see how they connect?", "Four lives. Good luck.").

STRICT RULES:
- NEVER state or hint at any group's name, theme or category. The sorting is the whole game.
- NEVER suggest that any two words you mention are connected, similar, or belong together. List them as strangers.
- Never name more than one word from the same group.
- Write the grid words in CAPITALS, exactly as given.
- Never use em dashes ("—"). Use full stops and commas.
- No preamble, no quotes, no markdown. Return ONLY the copy itself.

The day's grid (all of this is secret except the sixteen words themselves):
${list}`;

  const { text: raw, model } = await callGemini(prompt, { temperature: 0.9, maxOutputTokens: 400 });
  let text = noEmDash(raw.replace(/```/g, '').replace(/^["']|["']$/g, '').trim());
  if (!text) throw new Error('empty Groupie teaser');
  if (text.length < 25) throw new Error(`Groupie teaser too short: ${JSON.stringify(text)}`);
  const lower = text.toLowerCase();
  // Belt-and-braces 1: leaking a group name (or a decent chunk of one) is the
  // cardinal spoiler — fall back to the clean template instead.
  for (const g of groups) {
    const name = g.name.toLowerCase().replace(/_+/g, ' ').trim();
    if (name.length >= 4 && lower.includes(name)) {
      throw new Error(`Groupie teaser leaked a group name ("${g.name}")`);
    }
  }
  // Belt-and-braces 2: naming 2+ words from the same group invites the reader
  // to connect them — exactly what the copy must not do.
  for (const g of groups) {
    const named = g.words.filter(w => new RegExp(`\\b${escapeRegExp(w.toLowerCase())}\\b`).test(lower));
    if (named.length >= 2) {
      throw new Error(`Groupie teaser named ${named.length} words from one group (${named.join(', ')})`);
    }
  }
  return { text: text.slice(0, 240), model };
}

// Spoiler-free fallback: one word from each of three different groups, listed
// as strangers. Naming scattered words never betrays a grouping.
function fallbackGroupieTeaser(groups) {
  const picks = groups.slice(0, 3).map((g, i) => g.words[i % g.words.length]);
  const listed = `${picks.slice(0, -1).join(', ')} and ${picks[picks.length - 1]}`;
  return `Sixteen words, four hidden groups, and ${listed} are all on today's grid. Four lives to sort the lot. Where do they belong?`;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── HTML ─────────────────────────────────────────────────────────────────────

function buildTeaserHtml({ kicker, headline, intro, hero, statText, fridayISO, whenlyPromo, whatwordPromo, groupiePromo }) {
  const heroBlock = hero ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td>
      <img src="${escapeAttr(hero)}" width="600" height="300" alt="This week's quiz" style="display:block;width:100%;max-width:600px;height:auto;border:0;">
    </td></tr></table>` : '';
  const statBlock = statText ? `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="padding-bottom:26px;"><tr>
        <td bgcolor="#edf4ef" style="background-color:#edf4ef;border-radius:8px;padding:12px 16px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#3f6b4c;">${statText}</td>
      </tr></table>` : '';
  const label = weekLabel(fridayISO);
  const promoBlock = (whenlyPromo && whenlyPromo.teaser) ? `
  <tr><td style="padding:18px 8px 4px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f3efe7;border:1px solid #e7e3dc;border-radius:14px;"><tr><td style="padding:22px 26px;">
      <div style="font-family:Georgia,'Times New Roman',serif;font-size:19px;line-height:1.3;color:#1a1a1a;font-weight:700;padding-bottom:10px;"><span style="color:#c9772f;">New:</span> Whenly - The Daily Guess the Year Game</div>
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#4a4a4a;padding-bottom:16px;">${escapeHtml(whenlyPromo.teaser)}</div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td align="center" bgcolor="#c9772f" style="background-color:#c9772f;border-radius:9px;">
          <a href="${WHENLY_URL}" style="display:inline-block;padding:12px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">Give it a go →</a>
        </td>
      </tr></table>
    </td></tr></table>
  </td></tr>` : '';

  const whatwordBlock = (whatwordPromo && whatwordPromo.teaser) ? `
  <tr><td style="padding:${promoBlock ? '10px' : '18px'} 8px 4px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f5efe2;border:1px solid #e7e3dc;border-radius:14px;"><tr><td style="padding:22px 26px;">
      <div style="font-family:Georgia,'Times New Roman',serif;font-size:19px;line-height:1.3;color:#2c3f68;font-weight:700;padding-bottom:10px;"><span style="color:#ff48b0;">New:</span> What Word - Three Unusual Words a Day</div>
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#4a4a4a;padding-bottom:16px;">${escapeHtml(whatwordPromo.teaser)}</div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td align="center" bgcolor="#3d5588" style="background-color:#3d5588;border-radius:9px;">
          <a href="${WHATWORD_URL}" style="display:inline-block;padding:12px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">Play today's three →</a>
        </td>
      </tr></table>
    </td></tr></table>
  </td></tr>` : '';

  // Groupie block wears the game's vector-arcade skin: near-black panel,
  // neon-cyan frame, magenta accent, amber button. Email-safe inline styles.
  const groupieBlock = (groupiePromo && groupiePromo.teaser) ? `
  <tr><td style="padding:${(promoBlock || whatwordBlock) ? '10px' : '18px'} 8px 4px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#0a0c14;border:2px solid #00c2cc;border-radius:14px;"><tr><td style="padding:22px 26px;">
      <div style="font-family:'Courier New',Courier,monospace;font-size:19px;line-height:1.3;color:#00f0ff;font-weight:700;letter-spacing:0.04em;padding-bottom:10px;"><span style="color:#ff2bd6;">New:</span> GROUPIE - Your Daily Four Play</div>
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#c9d8de;padding-bottom:16px;">${escapeHtml(groupiePromo.teaser)}</div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td align="center" bgcolor="#ffd23f" style="background-color:#ffd23f;border-radius:9px;">
          <a href="${GROUPIE_URL}" style="display:inline-block;padding:12px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:700;color:#0a0c14;text-decoration:none;">Play today's grid →</a>
        </td>
      </tr></table>
    </td></tr></table>
  </td></tr>` : '';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="X-UA-Compatible" content="IE=edge"><title>Pub Quiz Daily: Weekly Best-of</title></head>
<body style="margin:0;padding:0;background-color:#faf9f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#faf9f7;"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;">
  <tr><td style="padding:4px 8px 22px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td align="left" style="font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:700;color:#1a1a1a;">Pub Quiz Daily</td>
      <td align="right" style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#8a857d;letter-spacing:0.04em;">FRIDAY BEST-OF · ${label}</td>
    </tr></table>
  </td></tr>
  <tr><td style="background-color:#ffffff;border:1px solid #e7e3dc;border-radius:16px;padding:0;overflow:hidden;">
    ${heroBlock}
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:32px 36px 36px;">
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.09em;text-transform:uppercase;color:#4a7c59;padding-bottom:12px;">${escapeHtml(kicker)}</div>
      <div style="font-family:Georgia,'Times New Roman',serif;font-size:28px;line-height:1.25;color:#1a1a1a;font-weight:700;padding-bottom:16px;">${escapeHtml(headline)}</div>
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.65;color:#4a4a4a;padding-bottom:22px;">${escapeHtml(intro)}</div>
      ${statBlock}
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td align="center" bgcolor="#4a7c59" style="background-color:#4a7c59;border-radius:10px;">
          <a href="${WEEKLY_URL}" style="display:inline-block;padding:15px 34px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:700;color:#ffffff;text-decoration:none;">Play this week's quiz →</a>
        </td>
      </tr></table>
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#a49f97;padding-top:14px;">Free · No login · One email a week</div>
    </td></tr></table>
  </td></tr>
  ${promoBlock}
  ${whatwordBlock}
  ${groupieBlock}
  <tr><td style="padding:24px 8px;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.7;color:#b3aea6;" align="center">
    Pub Quiz Daily · pubquizdaily.com<br>
    You're getting this because you signed up for the Friday Best-of. <a href="%%UNSUB%%" style="color:#b3aea6;text-decoration:underline;">Unsubscribe</a>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function buildPreviewWrapper(innerHtml, { subject, fridayISO, cancelUrl, aiIntroNote, aiWhenlyNote, aiWhatWordNote, aiGroupieNote }) {
  const diag = (aiIntroNote || aiWhenlyNote || aiWhatWordNote || aiGroupieNote) ? `
    <div style="font-size:11px;color:#8f8a82;padding-top:14px;line-height:1.7;border-top:1px solid #333;margin-top:14px;">
      <span style="color:#b3aea6;font-weight:700;">AI diagnostics (this line is only in your preview):</span><br>
      ${escapeHtml(aiIntroNote || '')}<br>${escapeHtml(aiWhenlyNote || '')}<br>${escapeHtml(aiWhatWordNote || '')}<br>${escapeHtml(aiGroupieNote || '')}
    </div>` : '';
  const banner = `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#1a1a1a;"><tr><td align="center" style="padding:18px 16px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;"><tr><td style="font-family:Arial,Helvetica,sans-serif;color:#ffffff;">
    <div style="font-size:13px;font-weight:700;letter-spacing:0.04em;">PREVIEW: this goes out to subscribers at 06:30 tomorrow (${weekLabel(fridayISO)})</div>
    <div style="font-size:13px;color:#c9c4bc;padding:6px 0 14px;">Subject line: "${escapeHtml(subject)}". Happy? Do nothing. Something wrong?</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#c0503a" style="background-color:#c0503a;border-radius:8px;">
      <a href="${escapeAttr(cancelUrl)}" style="display:inline-block;padding:11px 22px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">Cancel this week's send</a>
    </td></tr></table>${diag}
  </td></tr></table>
</td></tr></table>`;
  // Insert the banner right after <body ...>
  return innerHtml.replace(/(<body[^>]*>)/i, `$1${banner}`);
}

// ── Small helpers ──────────────────────────────────────────────────────────────

async function sendEmail(apiKey, to, subject, text, html) {
  const body = { from: 'Pub Quiz Daily <hello@pubquizdaily.com>', to: [to], subject, text };
  if (html) body.html = html;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Resend send failed: ${await res.text()}`);
}

async function putBlob(siteId, token, key, obj) {
  await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/quiz-meta/${key}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });
}
async function deleteBlob(siteId, token, key) {
  try {
    await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/quiz-meta/${key}`, {
      method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` },
    });
  } catch { /* ignore */ }
}

function londonHour() {
  return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hour12: false }).format(new Date()), 10);
}
function londonDateISO() {
  // en-CA gives YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDaysISO(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekLabel(fridayISO) {
  const start = new Date(`${addDaysISO(fridayISO, -7)}T12:00:00Z`);
  const end = new Date(`${addDaysISO(fridayISO, -1)}T12:00:00Z`);
  const f = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${f(start)}–${f(end)}`;
}
function weekOfYear(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.floor((d - start) / (7 * 24 * 3600 * 1000));
}
function parseFlexDate(str) {
  if (!str) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ── Shared with the on-demand rebuild endpoint (weekly-rebuild.js) ──
// weekly-rebuild reuses these exact functions so its output can never drift
// from the scheduled Thursday build. Requiring this file does not run the
// scheduled handler (no top-level side effects).
module.exports.BASE = BASE;
module.exports.fetchWeeklyQuestions = fetchWeeklyQuestions;
module.exports.weeklyAvgPct = weeklyAvgPct;
module.exports.pickSubjectQuestion = pickSubjectQuestion;
module.exports.generateCopy = generateCopy;
module.exports.fallbackCopy = fallbackCopy;
module.exports.buildWhenlyPromo = buildWhenlyPromo;
module.exports.buildWhatWordPromo = buildWhatWordPromo;
module.exports.buildGroupiePromo = buildGroupiePromo;
module.exports.buildTeaserHtml = buildTeaserHtml;
module.exports.buildPreviewWrapper = buildPreviewWrapper;
module.exports.putBlob = putBlob;
module.exports.deleteBlob = deleteBlob;
module.exports.sendEmail = sendEmail;
module.exports.addDaysISO = addDaysISO;
module.exports.londonDateISO = londonDateISO;
module.exports.escapeHtml = escapeHtml;

// House rule: no em dashes anywhere in our copy. Backstop for AI-written text.
// Replaces em dashes with a comma and tidies the resulting punctuation/spacing.
function noEmDash(s) {
  return String(s)
    .replace(/\s*—\s*/g, ', ')       // em dash -> comma
    .replace(/,\s*,/g, ',')           // collapse doubled commas
    .replace(/\s+([.,;:!?])/g, '$1')  // no space before punctuation
    .replace(/\s{2,}/g, ' ')          // collapse runs of spaces
    .trim();
}
