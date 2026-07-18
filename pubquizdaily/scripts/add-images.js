#!/usr/bin/env node
// scripts/add-images.js
//
// Finds quiz questions in the Google Sheet that don't have an image yet,
// searches Pexels for a free-to-use photo based on the QUESTION TEXT ONLY
// (never the correct answer or the options — we don't want the image
// search to accidentally give the game away), and writes the chosen
// image URL back into the sheet's "image" column (J).
//
// Safe to re-run: rows that already have an image are left untouched,
// so running this weekly after adding a new batch of questions only
// fills in images for the new rows.
//
// ── One-time setup ──────────────────────────────────────────────────
//   1. Get a free Pexels API key: https://www.pexels.com/api/
//   2. Create a Google Cloud service account with Sheets API access,
//      download its JSON key, and share your Google Sheet with the
//      service account's email address, set to Editor (not Viewer —
//      the read-only GOOGLE_API_KEY used elsewhere in this project
//      can't write to the sheet).
//   3. Copy image-search.config.example.json to image-search.config.json
//      (kept out of git) and fill in sheetId, pexelsApiKey, and the
//      full contents of the service account JSON key.
//
// ── Usage ────────────────────────────────────────────────────────────
//   node scripts/add-images.js                 only rows dated today or later
//   node scripts/add-images.js --all            also fill in past rows
//   node scripts/add-images.js --dry-run        show matches, don't write
//   node scripts/add-images.js --all --limit=190  stop after 190 Pexels
//                                                 lookups this run — useful
//                                                 for a big backfill, since
//                                                 Pexels' free tier defaults
//                                                 to a 200 request/hour cap.
//                                                 Already-imaged rows are
//                                                 always skipped, so just
//                                                 re-run the same command
//                                                 an hour later to continue
//                                                 where it left off.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_PATH = path.join(__dirname, '..', 'image-search.config.json');
const RESULTS_PATH = path.join(__dirname, '..', 'image-search-results.json');
const SHEET_TAB = 'multi';
const IMAGE_COLUMN = 'J'; // date | question | A | B | C | D | correct | explainer | weekly | image

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const INCLUDE_PAST = args.includes('--all');
const limitArg = args.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : Infinity;

async function main() {
  const config = loadConfig();
  const accessToken = await getAccessToken(config.googleServiceAccount);

  const rows = await fetchSheetRows(config.sheetId, accessToken);
  const todayISO = new Date().toISOString().slice(0, 10);

  const updates = [];
  const skipped = [];
  const results = [];
  let lookups = 0;
  let stoppedAtLimit = false;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const sheetRow = i + 2; // row 1 is the header
    const [date, question, , , , , , , , image] = row;

    if (!question || !question.trim()) continue;
    if (image && image.trim()) { skipped.push({ sheetRow, reason: 'already has an image' }); continue; }
    if (!INCLUDE_PAST && date && date.trim() < todayISO) { skipped.push({ sheetRow, reason: 'past date' }); continue; }

    if (lookups >= LIMIT) { stoppedAtLimit = true; break; }

    // IMPORTANT: only ever search on the question text. Never touch the
    // correct answer or the A–D options here, or the picture could give
    // the answer away before the player's even read the question.
    const query = buildSearchQuery(question);
    if (!query) { skipped.push({ sheetRow, reason: 'could not build a search query' }); continue; }

    lookups++;
    let photo;
    try {
      photo = await searchPexels(query, config.pexelsApiKey);
    } catch (err) {
      skipped.push({ sheetRow, reason: `Pexels error: ${err.message}` });
      continue;
    }

    if (!photo) { skipped.push({ sheetRow, reason: `no Pexels match for "${query}"` }); continue; }

    updates.push({ range: `${SHEET_TAB}!${IMAGE_COLUMN}${sheetRow}`, values: [[photo.imageUrl]] });
    results.push({
      sheetRow,
      date: (date || '').trim(),
      question: question.trim(),
      searchQuery: query,
      imageUrl: photo.imageUrl,
      pexelsPageUrl: photo.pageUrl,
      photographer: photo.photographer,
    });

    await sleep(250); // be polite to the API
  }

  if (updates.length && !DRY_RUN) {
    await batchWrite(config.sheetId, accessToken, updates);
  }

  console.log('');
  console.log(`${DRY_RUN ? '[DRY RUN] Would update' : 'Updated'} ${updates.length} row(s).`);
  if (skipped.length) {
    console.log(`Skipped ${skipped.length} row(s):`);
    skipped.forEach(s => console.log(`  row ${s.sheetRow}: ${s.reason}`));
  }
  if (stoppedAtLimit) {
    console.log('');
    console.log(`Stopped after ${lookups} Pexels lookup(s) — hit --limit=${LIMIT}.`);
    console.log('Run the exact same command again (later, if you\'re pacing around the Pexels hourly cap) to continue with the remaining rows.');
  }

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  console.log('');
  console.log(`Wrote details of ${results.length} chosen image(s) to ${path.basename(RESULTS_PATH)}`);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Missing config file: ${CONFIG_PATH}`);
    console.error('Copy image-search.config.example.json to image-search.config.json and fill it in.');
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  for (const key of ['sheetId', 'pexelsApiKey', 'googleServiceAccount']) {
    if (!config[key]) {
      console.error(`image-search.config.json is missing "${key}"`);
      process.exit(1);
    }
  }
  return config;
}

// ── Google auth: service account JWT-bearer flow (no extra dependencies) ──

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken(serviceAccount) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const unsigned = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(claim)))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = base64url(signer.sign(serviceAccount.private_key));
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Google auth failed: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

// ── Sheets ──────────────────────────────────────────────────────────

async function fetchSheetRows(sheetId, accessToken) {
  const range = encodeURIComponent(`${SHEET_TAB}!A2:J`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Failed to read sheet: ${await res.text()}`);
  const data = await res.json();
  return data.values || [];
}

async function batchWrite(sheetId, accessToken, updates) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'RAW', data: updates }),
  });
  if (!res.ok) throw new Error(`Failed to write sheet: ${await res.text()}`);
}

// ── Pexels ──────────────────────────────────────────────────────────
// Pexels is a curated/moderated library (not an open web image search),
// which is also why it's a safer default than scraping general search
// results — but the chosen images still get reviewed via the PDF step
// before anyone sees them.

async function searchPexels(query, apiKey) {
  const url = `https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`;
  const res = await fetch(url, { headers: { Authorization: apiKey } });
  if (!res.ok) throw new Error(await res.text());
  const data = await res.json();
  const photo = data.photos && data.photos[0];
  if (!photo) return null;
  return {
    imageUrl: photo.src.landscape || photo.src.large,
    pageUrl: photo.url,
    photographer: photo.photographer,
  };
}

// ── Search query builder — QUESTION TEXT ONLY, never the answer/options ──

const STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'from', 'by', 'with', 'is',
  'was', 'are', 'were', 'be', 'been', 'being', 'this', 'that', 'these',
  'those', 'which', 'who', 'whom', 'whose', 'what', 'when', 'where', 'why',
  'how', 'does', 'did', 'do', 'has', 'have', 'had', 'its', "it's", 'as',
  'and', 'or', 'but', 'if', 'than', 'then', 'not', 'following', 'considered',
  'called', 'known', 'named', 'name', 'term', 'also', 'many', 'much', 'most',
  'best', 'one', 'true', 'false', 'out', 'for', 'used', 'use', 'can', 'could',
  'would', 'should', 'into', 'about', 'above', 'below',
]);

function buildSearchQuery(questionText) {
  const words = questionText
    .replace(/[?"“”]/g, '')
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w && !STOPWORDS.has(w))
    .slice(0, 6);

  return words.join(' ').trim();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
