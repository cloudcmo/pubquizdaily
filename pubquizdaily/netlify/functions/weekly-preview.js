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

const BASE = 'https://pubquizdaily.com';
const WEEKLY_URL = `${BASE}/weekly.html`;
const MIN_SAMPLE = 4;                 // hide a % until at least this many answers
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

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
    const statText = avgPct !== null ? `Players are averaging <strong>${avgPct}%</strong> on these — how would you do?` : null;

    const subjectQ = pickSubjectQuestion(questions, fridayISO);
    const hero = (subjectQ && subjectQ.image) || (questions.find(q => q.image) || {}).image || null;

    const copy = await generateCopy(questions).catch(err => {
      console.error('AI copy failed, using fallback:', err);
      return fallbackCopy(questions);
    });

    // Clean email that Friday will send (unsubscribe placeholder swapped at send time).
    const cleanHtml = buildTeaserHtml({
      kicker: copy.kicker, headline: copy.headline, intro: copy.intro,
      hero, statText, fridayISO,
    });
    const subject = subjectQ ? subjectQ.question : "This week's Pub Quiz Daily Best-of 🍺";

    // Store what will be sent, so Friday sends exactly this.
    await putBlob(SITE_ID, TOKEN, `weekly-built-${fridayISO}`, { subject, html: cleanHtml, builtAt: new Date().toISOString() });
    // Fresh week starts uncancelled (clear any stale flag).
    await deleteBlob(SITE_ID, TOKEN, `weekly-cancel-${fridayISO}`);

    // Preview = the real email, wrapped with a cancel banner.
    const cancelUrl = `${BASE}/.netlify/functions/weekly-cancel?token=${encodeURIComponent(CANCEL_TOKEN)}&week=${fridayISO}`;
    const previewHtml = buildPreviewWrapper(cleanHtml.replace('%%UNSUB%%', '#'), { subject, fridayISO, cancelUrl });

    await sendEmail(RESEND_API_KEY, REPORT_EMAIL,
      `[Preview] ${subject}  —  sends 06:30 tomorrow`,
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
  for (const row of rows) {
    const isoDate = parseFlexDate((row[0] || '').trim());
    if (!isoDate) continue;
    const idx = (perDay[isoDate] = (perDay[isoDate] ?? -1) + 1);
    if (!validDates.has(isoDate)) continue;
    if ((row[8] || '').trim().toUpperCase() !== 'W') continue;
    const [, question, a, b, c, d, correct, explainer, , image] = row;
    if (!question || !a || !b || !c || !d || !correct) continue;
    out.push({ date: isoDate, index: idx, question: question.trim(), image: image ? image.trim() : null });
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

async function generateCopy(questions) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return fallbackCopy(questions);

  const list = questions.map((q, i) => `${i + 1}. ${q.question}`).join('\n');
  const prompt =
`You write short, witty teaser emails for "Pub Quiz Daily", a fun British daily pub quiz. Below are this week's Best-of questions. Write playful copy that entices readers to click through and play — WITHOUT revealing any answers.

Return ONLY minified JSON (no markdown) with keys:
"kicker": <=6 words, may include one tasteful emoji;
"headline": <=8 words, punchy;
"intro": 1-2 sentences, <=45 words, name-drop 2-3 of the most intriguing topics.

Questions:
${list}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.9, maxOutputTokens: 300 },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const data = await res.json();
  let text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  text = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  const parsed = JSON.parse(text);
  if (!parsed.kicker || !parsed.headline || !parsed.intro) throw new Error('AI copy missing fields');
  return {
    kicker: String(parsed.kicker).slice(0, 40),
    headline: String(parsed.headline).slice(0, 80),
    intro: String(parsed.intro).slice(0, 300),
  };
}

function fallbackCopy(questions) {
  return {
    kicker: 'The Friday Best-of 🍺',
    headline: "This week's finest",
    intro: `${questions.length} of the week's best questions, about ninety seconds of fun. See how many you'd have got.`,
  };
}

// ── HTML ─────────────────────────────────────────────────────────────────────

function buildTeaserHtml({ kicker, headline, intro, hero, statText, fridayISO }) {
  const heroBlock = hero ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td>
      <img src="${escapeAttr(hero)}" width="600" height="300" alt="This week's quiz" style="display:block;width:100%;max-width:600px;height:auto;border:0;">
    </td></tr></table>` : '';
  const statBlock = statText ? `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="padding-bottom:26px;"><tr>
        <td bgcolor="#edf4ef" style="background-color:#edf4ef;border-radius:8px;padding:12px 16px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#3f6b4c;">${statText}</td>
      </tr></table>` : '';
  const label = weekLabel(fridayISO);

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><meta http-equiv="X-UA-Compatible" content="IE=edge"><title>Pub Quiz Daily — Weekly Best-of</title></head>
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
  <tr><td style="padding:24px 8px;font-family:Arial,Helvetica,sans-serif;font-size:11px;line-height:1.7;color:#b3aea6;" align="center">
    Pub Quiz Daily · pubquizdaily.com<br>
    You're getting this because you signed up for the Friday Best-of. <a href="%%UNSUB%%" style="color:#b3aea6;text-decoration:underline;">Unsubscribe</a>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function buildPreviewWrapper(innerHtml, { subject, fridayISO, cancelUrl }) {
  const banner = `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#1a1a1a;"><tr><td align="center" style="padding:18px 16px;">
  <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;"><tr><td style="font-family:Arial,Helvetica,sans-serif;color:#ffffff;">
    <div style="font-size:13px;font-weight:700;letter-spacing:0.04em;">PREVIEW — this goes out to subscribers at 06:30 tomorrow (${weekLabel(fridayISO)})</div>
    <div style="font-size:13px;color:#c9c4bc;padding:6px 0 14px;">Subject line: "${escapeHtml(subject)}". Happy? Do nothing. Something wrong?</div>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#c0503a" style="background-color:#c0503a;border-radius:8px;">
      <a href="${escapeAttr(cancelUrl)}" style="display:inline-block;padding:11px 22px;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;">Cancel this week's send</a>
    </td></tr></table>
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
