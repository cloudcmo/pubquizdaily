// netlify/lib/weekly-picks.js
// Where auto-selected Weekly Best-of questions are remembered.
//
// Until 2026-08-18 the weekly auto-select wrote a "W" into column I of the
// sheet, which needed Editor access, which needed a Google Cloud service
// account. That was the last thing on the live site that depended on a Google
// Cloud project, so the picks moved here: a Netlify blob, alongside the quiz
// stats the site already keeps there.
//
// Nothing else changes. A "W" typed into the sheet by hand (or written by
// scripts/assign-weekly.js) still counts exactly as it did - the readers treat
// a question as weekly if the sheet says W OR this blob has it. So the two
// routes coexist and Carl can keep flagging questions in the sheet if he wants.
//
// Picks are keyed by date + question text rather than by sheet row, because
// row numbers shift if a row is ever inserted or deleted and would silently
// point at the wrong question. Question text does not move.

const STORE = 'weekly-picks';
const KEY = 'auto';
const RETAIN_DAYS = 400; // small blob; keeps the archive honest for over a year

function pickKey(date, question) {
  return `${(date || '').trim()}|${(question || '').trim().toLowerCase()}`;
}

function blobUrl() {
  const siteId = process.env.NETLIFY_SITE_ID;
  if (!siteId) throw new Error('NETLIFY_SITE_ID is not set');
  return `https://api.netlify.com/api/v1/blobs/${siteId}/${STORE}/${KEY}`;
}

function authHeader() {
  const token = process.env.NETLIFY_API_TOKEN;
  if (!token) throw new Error('NETLIFY_API_TOKEN is not set');
  return { Authorization: `Bearer ${token}` };
}

async function readPicks() {
  const res = await fetch(blobUrl(), { headers: authHeader() });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`weekly-picks read ${res.status}`);
  const data = await res.json();
  return Array.isArray(data && data.picks) ? data.picks : [];
}

// Readers must never take the site down over this: if the blob is unreachable
// the quiz still works off the sheet's own W flags, which is the behaviour the
// site had for its whole life before auto-select existed.
async function loadPickSet() {
  try {
    return new Set((await readPicks()).map((p) => pickKey(p.date, p.q)));
  } catch (e) {
    console.error('weekly-picks: could not load auto-picks, falling back to sheet W flags only:', e.message || e);
    return new Set();
  }
}

// Writers DO throw: the auto-select caller reports the failure rather than
// quietly producing an empty weekly.
async function addPicks(picks) {
  if (!picks || !picks.length) return;

  const existing = await readPicks();
  const seen = new Set(existing.map((p) => pickKey(p.date, p.q)));
  const at = new Date().toISOString();

  for (const p of picks) {
    const k = pickKey(p.date, p.question);
    if (seen.has(k)) continue;
    seen.add(k);
    existing.push({ date: p.date, q: (p.question || '').trim(), at });
  }

  const cutoff = new Date(Date.now() - RETAIN_DAYS * 86400000).toISOString().slice(0, 10);
  const kept = existing.filter((p) => (p.date || '') >= cutoff);

  const res = await fetch(blobUrl(), {
    method: 'PUT',
    headers: Object.assign({}, authHeader(), { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ picks: kept, updatedAt: at }),
  });
  if (!res.ok) throw new Error(`weekly-picks write ${res.status}: ${(await res.text()).slice(0, 120)}`);
}

module.exports = { pickKey, loadPickSet, addPicks, readPicks };
