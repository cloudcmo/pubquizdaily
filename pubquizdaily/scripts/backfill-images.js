#!/usr/bin/env node
// scripts/backfill-images.js
//
// One-shot, self-pacing image backfill for Pub Quiz Daily.
//
// Finds quiz rows that have a question but no image yet, searches Pexels using
// the QUESTION TEXT ONLY (never the answer or the A–D options, so the picture
// can't give the game away), and writes the chosen image URL into column J.
//
// Built to finish the WHOLE backlog in one run you leave going for a few hours:
//   • Rate limit (HTTP 429): reads Pexels' reset time and SLEEPS until the
//     window re-opens, then carries on.
//   • Search queries are sanitised to plain keywords — no quotes/commas/colons
//     (a stray apostrophe trips Pexels' firewall and returns a 403 HTML page).
//   • Fallback ladder: if the full query finds nothing, it retries with fewer
//     keywords, then finally a safe generic term (quiz / mystery / question
//     mark / puzzle / wondering …) — so EVERY row ends up with an image.
//   • Safety: we never search adult terms, and every returned image is checked
//     against a not-safe-for-work word list (its description + page URL); any
//     hit is rejected and we fall back. Pexels is a moderated/curated library
//     to begin with. NOTE: this script can't *see* the pictures, so this is a
//     text/metadata screen — the image-review page is still the final human
//     eyeball before anything goes live.
//
// Safe and resumable: rows that already have an image are skipped, it writes to
// the sheet every few images, and it only ever touches column J.
//
// Reuses the same image-search.config.json as add-images.js.
//
// ── Usage ────────────────────────────────────────────────────────────
//   node scripts/backfill-images.js
//   node scripts/backfill-images.js --dry-run     show what it would search
//   node scripts/backfill-images.js --today-fwd   only rows dated today or later
//
// Keep the Mac awake for a long run:  caffeinate -i node scripts/backfill-images.js

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_PATH = path.join(__dirname, '..', 'image-search.config.json');
const RESULTS_PATH = path.join(__dirname, '..', 'image-search-results.json');
const SHEET_TAB = 'multi';
const IMAGE_COLUMN = 'J';
const FLUSH_EVERY = 20;
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;
const POLITE_DELAY_MS = 300;
const FORBIDDEN_RETRY_MS = 45 * 1000;
const MAX_FORBIDDEN_RETRIES = 3;

// Safe generic fall-backs, tried (in rotation) only when a row's own keywords
// find nothing. All wholesome, all on-theme for a quiz.
const SAFE_GENERICS = [
  'quiz', 'question mark', 'mystery', 'puzzle', 'thinking person',
  'pub quiz night', 'trivia', 'wondering', 'chalkboard', 'open book', 'lightbulb idea',
];

// Not-safe-for-work screen. Used to (a) strip such words from any search query
// and (b) reject any returned image whose description/URL contains them.
const NSFW = new Set([
  'nude', 'nudes', 'naked', 'nudity', 'nsfw', 'porn', 'porno', 'pornographic',
  'sex', 'sexy', 'sexual', 'erotic', 'erotica', 'lingerie', 'bikini', 'underwear',
  'thong', 'boudoir', 'topless', 'breast', 'breasts', 'nipple', 'nipples',
  'cleavage', 'butt', 'buttocks', 'booty', 'fetish', 'bdsm', 'kink', 'adult',
  'sensual', 'seductive', 'provocative', 'intimate', 'stripper', 'strip',
  'onlyfans', 'escort', 'suggestive', 'racy', 'lewd', 'nudist',
]);
const NSFW_RE = new RegExp(`\\b(${[...NSFW].join('|')})\\b`, 'i');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const TODAY_FWD_ONLY = args.includes('--today-fwd');

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }

async function main() {
  const config = loadConfig();
  let accessToken = await getAccessToken(config.googleServiceAccount);
  let tokenAt = Date.now();

  const rows = await fetchSheetRows(config.sheetId, accessToken);
  const todayISO = new Date().toISOString().slice(0, 10);

  const worklist = [];
  for (let i = 0; i < rows.length; i++) {
    const sheetRow = i + 2;
    const [date, question, , , , , , , , image] = rows[i];
    if (!question || !question.trim()) continue;
    if (image && image.trim()) continue;
    if (TODAY_FWD_ONLY && date && date.trim() < todayISO) continue;
    worklist.push({ sheetRow, date: (date || '').trim(), question: question.trim() });
  }

  log(`${worklist.length} row(s) still need an image.`);
  if (!worklist.length) { log('Nothing to do — all caught up.'); return; }

  if (DRY_RUN) {
    worklist.forEach(w => log(`  row ${w.sheetRow}: ladder -> ${JSON.stringify(buildQueryLadder(w.question, w.sheetRow).slice(0, 4))}`));
    log('[DRY RUN] no images written.');
    return;
  }

  const results = loadResults();
  let pending = [];
  let done = 0, genericFallbacks = 0, trulyNone = 0;

  for (const item of worklist) {
    if (Date.now() - tokenAt > 50 * 60 * 1000) { accessToken = await getAccessToken(config.googleServiceAccount); tokenAt = Date.now(); }

    const hit = await searchImage(item.question, item.sheetRow, config.pexelsApiKey);
    if (!hit) { trulyNone++; log(`  row ${item.sheetRow}: no safe image found even on fallback (left blank)`); continue; }
    if (hit.wasGeneric) genericFallbacks++;

    pending.push({ range: `${SHEET_TAB}!${IMAGE_COLUMN}${item.sheetRow}`, values: [[hit.imageUrl]] });
    results[item.sheetRow] = {
      sheetRow: item.sheetRow, date: item.date, question: item.question,
      searchQuery: hit.searchQuery, wasGenericFallback: hit.wasGeneric,
      imageUrl: hit.imageUrl, pexelsPageUrl: hit.pageUrl, photographer: hit.photographer, alt: hit.alt || '',
    };
    done++;

    if (pending.length >= FLUSH_EVERY) {
      await batchWrite(config.sheetId, accessToken, pending);
      saveResults(results);
      log(`  …saved ${done}/${worklist.length} (row ${item.sheetRow})`);
      pending = [];
    }
    await sleep(POLITE_DELAY_MS);
  }

  if (pending.length) { await batchWrite(config.sheetId, accessToken, pending); saveResults(results); }

  log('');
  log(`Finished. Imaged ${done} row(s) this run (${genericFallbacks} via a generic fallback term).`);
  if (trulyNone) log(`${trulyNone} row(s) still blank — tell Claude and we'll sort them by hand.`);
  log(`Details in ${path.basename(RESULTS_PATH)} (${Object.keys(results).length} total).`);
}

// Try a row's own keywords, then narrower, then a safe generic term.
async function searchImage(question, sheetRow, apiKey) {
  const ladder = buildQueryLadder(question, sheetRow);
  for (let li = 0; li < ladder.length; li++) {
    const q = ladder[li];
    const photo = await pexelsSearch(q, apiKey);
    if (photo && isSafeImage(photo)) {
      const wasGeneric = li >= ladder.length - SAFE_GENERICS.length;
      return { ...photo, searchQuery: q, wasGeneric };
    }
    // no photo, or photo failed the safety screen -> try the next, broader query
  }
  return null;
}

function buildQueryLadder(question, sheetRow) {
  const kws = keywords(question);
  const ladder = [];
  if (kws.length) ladder.push(kws.slice(0, 6).join(' '));
  if (kws.length > 3) ladder.push(kws.slice(0, 3).join(' '));
  if (kws.length > 1) ladder.push(kws[0]);
  // two safe generics, rotated by row so the fallbacks aren't all identical
  const g = SAFE_GENERICS;
  ladder.push(g[sheetRow % g.length]);
  ladder.push(g[(sheetRow + 5) % g.length]);
  return [...new Set(ladder.filter(Boolean))];
}

// One Pexels lookup, with rate-limit + firewall handling. Returns a photo obj
// or null (no result). Sleeps (does not give up) on 429.
async function pexelsSearch(query, apiKey) {
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`;
  let forbidden = 0;
  for (;;) {
    let res;
    try {
      res = await fetch(url, { headers: { Authorization: apiKey } });
    } catch (e) { log(`  network blip (${e.message}); retry in 30s`); await sleep(30000); continue; }

    if (res.status === 429) {
      const ms = cooldownFromHeaders(res.headers);
      log(`Rate limit hit. Sleeping ~${Math.round(ms / 60000)} min, resuming around ${new Date(Date.now() + ms).toLocaleTimeString()}…`);
      await sleep(ms);
      continue;
    }
    if (res.status === 403) {
      // Usually a firewall block. With sanitised queries this is rare; retry a
      // few times then give up on THIS query (the fallback ladder takes over).
      if (++forbidden > MAX_FORBIDDEN_RETRIES) { log(`  403 persists for "${query}"; moving on`); return null; }
      await sleep(FORBIDDEN_RETRY_MS);
      continue;
    }
    if (!res.ok) { log(`  Pexels error ${res.status} for "${query}"`); return null; }

    const data = await res.json();
    const remaining = parseInt(res.headers.get('x-ratelimit-remaining') ?? '', 10);
    const p = data.photos && data.photos[0];
    const photo = p ? { imageUrl: p.src.landscape || p.src.large, pageUrl: p.url, photographer: p.photographer, alt: p.alt || '' } : null;

    if (!Number.isNaN(remaining) && remaining <= 1) {
      const ms = cooldownFromHeaders(res.headers);
      log(`Quota exhausted this window. Sleeping until ~${new Date(Date.now() + ms).toLocaleTimeString()}…`);
      await sleep(ms);
    }
    return photo;
  }
}

// Reject anything whose description or page URL trips the NSFW word list.
function isSafeImage(photo) {
  const hay = `${photo.alt || ''} ${photo.pageUrl || ''}`;
  if (NSFW_RE.test(hay)) { log(`  rejected an image on safety screen (desc: "${(photo.alt || '').slice(0, 50)}")`); return false; }
  return true;
}

function cooldownFromHeaders(headers) {
  const reset = parseInt(headers.get('x-ratelimit-reset') ?? '', 10);
  if (!Number.isNaN(reset)) {
    const ms = reset * 1000 - Date.now() + 5000;
    if (ms > 0 && ms < 3 * 60 * 60 * 1000) return ms;
  }
  return DEFAULT_COOLDOWN_MS;
}

function loadResults() {
  try {
    const raw = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
    const byRow = {};
    if (Array.isArray(raw)) raw.forEach(r => { if (r && r.sheetRow) byRow[r.sheetRow] = r; });
    else if (raw && typeof raw === 'object') Object.assign(byRow, raw);
    return byRow;
  } catch { return {}; }
}
function saveResults(byRow) {
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(Object.values(byRow).sort((a, b) => a.sheetRow - b.sheetRow), null, 2));
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) { console.error(`Missing ${CONFIG_PATH} (reuses add-images' config).`); process.exit(1); }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  for (const k of ['sheetId', 'pexelsApiKey', 'googleServiceAccount']) if (!config[k]) { console.error(`config missing "${k}"`); process.exit(1); }
  return config;
}
function base64url(buf) { return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const claim = { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now };
  const unsigned = `${base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))}.${base64url(Buffer.from(JSON.stringify(claim)))}`;
  const s = crypto.createSign('RSA-SHA256'); s.update(unsigned); s.end();
  const jwt = `${unsigned}.${base64url(s.sign(sa.private_key))}`;
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }) });
  if (!res.ok) throw new Error(`Google auth failed: ${await res.text()}`);
  return (await res.json()).access_token;
}
async function fetchSheetRows(sheetId, token) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(`${SHEET_TAB}!A2:J`)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Failed to read sheet: ${await res.text()}`);
  return (await res.json()).values || [];
}
async function batchWrite(sheetId, token, updates) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`;
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ valueInputOption: 'RAW', data: updates }) });
  if (!res.ok) throw new Error(`Failed to write sheet: ${await res.text()}`);
}

// ── Keyword builder — QUESTION TEXT ONLY, stripped to plain words ─────
const STOPWORDS = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'from', 'by', 'with', 'is', 'was', 'are', 'were', 'be', 'been', 'being', 'this', 'that', 'these', 'those', 'which', 'who', 'whom', 'whose', 'what', 'when', 'where', 'why', 'how', 'does', 'did', 'do', 'has', 'have', 'had', 'its', "it's", 'as', 'and', 'or', 'but', 'if', 'than', 'then', 'not', 'following', 'considered', 'called', 'known', 'named', 'name', 'term', 'also', 'many', 'much', 'most', 'best', 'one', 'true', 'false', 'out', 'for', 'used', 'use', 'can', 'could', 'would', 'should', 'into', 'about', 'above', 'below']);
function keywords(questionText) {
  return questionText
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')   // strip quotes/commas/colons/etc — plain words only
    .split(/\s+/)
    .filter(w => w && w.length > 1 && !STOPWORDS.has(w) && !NSFW.has(w))
    .slice(0, 6);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => { console.error(err); process.exit(1); });
