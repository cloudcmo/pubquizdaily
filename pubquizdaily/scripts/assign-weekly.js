#!/usr/bin/env node
// scripts/assign-weekly.js
//
// The Archive page groups questions into calendar weeks (Monday–Sunday)
// and shows only the ones marked 'W' in column I. Recent weeks already
// have real hand-picked W's, but most of the historical archive never
// had any assigned.
//
// This script finds every calendar week that currently has ZERO rows
// marked 'W', randomly picks up to 7 of that week's questions, and
// writes 'W' into column I for them — so every week in the archive has
// a consistent round-up, not just the ones someone flagged by hand.
//
// Weeks that already have at least one 'W' are left completely alone
// (so any hand-picked weekly round-ups are never touched or overwritten).
// Safe to re-run — already-decided weeks are skipped every time.
//
// Uses the same image-search.config.json as scripts/add-images.js
// (same service account, needs Editor access on the sheet).
//
// Usage:
//   node scripts/assign-weekly.js            do it for real
//   node scripts/assign-weekly.js --dry-run  show what would be assigned

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_PATH = path.join(__dirname, '..', 'image-search.config.json');
const SHEET_TAB = 'multi';
const WEEKLY_COLUMN = 'I'; // date | question | A | B | C | D | correct | explainer | weekly | image

const DRY_RUN = process.argv.includes('--dry-run');
const MAX_PER_WEEK = 7;

async function main() {
  const config = loadConfig();
  const accessToken = await getAccessToken(config.googleServiceAccount);
  const rows = await fetchSheetRows(config.sheetId, accessToken);

  // Group valid rows by the Monday of their calendar week.
  const weeks = new Map(); // weekStart -> [{ sheetRow, isW }]
  rows.forEach((row, i) => {
    const sheetRow = i + 2; // row 1 is the header
    const [date, question, optA, optB, optC, optD, correct, , weekly] = row;
    const cellDate = (date || '').trim();
    if (!cellDate || !question || !question.trim()) return;
    if (!optA || !optB || !optC || !optD || !correct) return; // incomplete row

    const weekStart = getWeekStart(cellDate);
    if (!weekStart) return; // unparseable date, skip

    if (!weeks.has(weekStart)) weeks.set(weekStart, []);
    weeks.get(weekStart).push({
      sheetRow,
      isW: (weekly || '').trim().toUpperCase() === 'W',
    });
  });

  const updates = [];
  let weeksAssigned = 0;
  let weeksSkipped = 0;

  for (const [weekStart, weekRows] of weeks) {
    if (weekRows.some(r => r.isW)) { weeksSkipped++; continue; }

    const pool = weekRows.slice();
    shuffle(pool);
    const picks = pool.slice(0, MAX_PER_WEEK);

    picks.forEach(p => {
      updates.push({ range: `${SHEET_TAB}!${WEEKLY_COLUMN}${p.sheetRow}`, values: [['W']] });
    });

    weeksAssigned++;
    console.log(`Week of ${weekStart}: assigning W to ${picks.length} row(s) — ${picks.map(p => p.sheetRow).join(', ')}`);
  }

  if (updates.length && !DRY_RUN) {
    await batchWrite(config.sheetId, accessToken, updates);
  }

  console.log('');
  console.log(`${DRY_RUN ? '[DRY RUN] Would assign' : 'Assigned'} W to ${updates.length} row(s) across ${weeksAssigned} week(s).`);
  console.log(`${weeksSkipped} week(s) already had a W and were left alone.`);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// Monday of the ISO week containing this date, as YYYY-MM-DD (UTC-based
// to avoid local-timezone drift shifting a date into the wrong week).
function getWeekStart(dateStr) {
  const iso = parseFlexDate(dateStr);
  if (!iso) return null;
  const d = new Date(`${iso}T12:00:00Z`);
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function parseFlexDate(str) {
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Missing config file: ${CONFIG_PATH}`);
    console.error('This uses the same config as scripts/add-images.js — run that first if you haven\'t set it up.');
    process.exit(1);
  }
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  for (const key of ['sheetId', 'googleServiceAccount']) {
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

main().catch(err => {
  console.error(err);
  process.exit(1);
});
