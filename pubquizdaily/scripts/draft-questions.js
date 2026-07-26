#!/usr/bin/env node
// scripts/draft-questions.js
//
// Writes a batch of DRAFT quiz questions into the Pub Quiz Daily Google
// Sheet (the "multi" tab). Reads the rows from question-drafts.json in the
// repo root — each entry says exactly which sheet row it belongs on, plus
// the date, the question, the four options (A–D), the correct letter and an
// explainer.
//
// Pub Quiz Daily is always THREE questions per day. This script:
//   1. Writes columns B–H  (question | A | B | C | D | correct | explainer).
//   2. If a target row has no date in column A yet (i.e. you've run past the
//      pre-filled dates), it fills column A with the same auto-incrementing
//      formula you use — "=A{row-3}+1" on the first row of a day, "=A{row-1}"
//      on the two repeat rows — so the dates keep marching on 3-per-day.
//   3. Draws the start-of-day horizontal line: a thin black top border across
//      columns A–J on the first row of each day (matching the ones you draw
//      by hand), so the days stay easy to scan.
//
// It NEVER touches column I (weekly) or column J (image) — those stay for the
// assign-weekly / add-images steps. It never changes a date that's already
// there, and never overwrites a row that already has a question.
//
// SAFETY: before writing it re-reads the sheet and, for every target row,
//   • refuses to write the question if that row's question cell already has
//     text (so it can't overwrite a question you already have), and
//   • warns and skips if a date already in the sheet doesn't match the draft.
// Nothing is ever deleted.
//
// Reuses the SAME image-search.config.json as add-images.js (sheetId +
// googleServiceAccount with Editor access). No new setup.
//
// ── Usage ────────────────────────────────────────────────────────────
//   node scripts/draft-questions.js            apply the drafts
//   node scripts/draft-questions.js --dry-run  show what it WOULD do, write nothing

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_PATH = path.join(__dirname, '..', 'image-search.config.json');
const DRAFTS_PATH = path.join(__dirname, '..', 'question-drafts.json');
const SHEET_TAB = 'multi';
const LAST_COL_INDEX = 10; // A..J -> the day line spans columns A–J

const DRY_RUN = process.argv.slice(2).includes('--dry-run');

async function main() {
  const config = loadConfig();
  const drafts = JSON.parse(fs.readFileSync(DRAFTS_PATH, 'utf8'));
  if (!Array.isArray(drafts) || !drafts.length) {
    console.error(`No drafts found in ${path.basename(DRAFTS_PATH)}`);
    process.exit(1);
  }
  drafts.sort((a, b) => a.row - b.row);

  const accessToken = await getAccessToken(config.googleServiceAccount);
  const sheetId = await getTabId(config.sheetId, accessToken, SHEET_TAB);
  const rows = await fetchSheetRows(config.sheetId, accessToken); // A2:J, index 0 = sheet row 2

  const valueUpdatesRaw = [];       // B–H text, written RAW
  const dateUpdates = [];           // col A formulas, written USER_ENTERED
  const dayStartRows = [];          // rows that begin a day -> get the horizontal line
  const skipped = [];

  let prevDate = null;
  for (const d of drafts) {
    const idx = d.row - 2;
    const existing = rows[idx] || [];
    const existingDate = (existing[0] || '').trim();
    const existingQuestion = (existing[1] || '').trim();

    const isDayStart = d.date !== prevDate;
    prevDate = d.date;

    if (existingQuestion) {
      skipped.push(`row ${d.row}: already has a question ("${existingQuestion.slice(0, 40)}…") — left untouched`);
      continue;
    }
    if (existingDate && d.date && existingDate.slice(0, 10) !== d.date) {
      skipped.push(`row ${d.row}: sheet date "${existingDate}" ≠ draft date "${d.date}" — rows may have shifted, skipped for safety`);
      continue;
    }

    // Columns B–H: question | A | B | C | D | correct | explainer
    valueUpdatesRaw.push({
      range: `${SHEET_TAB}!B${d.row}:H${d.row}`,
      values: [[d.question, d.A, d.B, d.C, d.D, d.correct, d.explainer]],
    });

    // Fill column A only if it's empty (ran past the pre-filled dates).
    if (!existingDate) {
      const formula = isDayStart ? `=A${d.row - 3}+1` : `=A${d.row - 1}`;
      dateUpdates.push({ range: `${SHEET_TAB}!A${d.row}`, values: [[formula]] });
    }

    if (isDayStart) dayStartRows.push(d.row);
  }

  console.log('');
  console.log(`${DRY_RUN ? '[DRY RUN] Would apply' : 'Applying'}:`);
  console.log(`  • ${valueUpdatesRaw.length} question row(s) -> columns B–H`);
  console.log(`  • ${dateUpdates.length} new date formula(s) -> column A (only where empty)`);
  console.log(`  • ${dayStartRows.length} start-of-day line(s) -> ${dayStartRows.join(', ') || '(none)'}`);
  if (DRY_RUN) {
    valueUpdatesRaw.forEach(u => console.log(`      ${u.range}  ${JSON.stringify(u.values[0])}`));
    dateUpdates.forEach(u => console.log(`      ${u.range}  ${JSON.stringify(u.values[0])}`));
  }

  if (!DRY_RUN) {
    if (dateUpdates.length) await batchWriteValues(config.sheetId, accessToken, dateUpdates, 'USER_ENTERED');
    if (valueUpdatesRaw.length) await batchWriteValues(config.sheetId, accessToken, valueUpdatesRaw, 'RAW');
    if (dayStartRows.length) await drawDayLines(config.sheetId, accessToken, sheetId, dayStartRows);
    console.log('');
    console.log('Done. Open the sheet to review and edit as you like.');
  }

  if (skipped.length) {
    console.log('');
    console.log(`Skipped ${skipped.length} row(s):`);
    skipped.forEach(s => console.log(`  ${s}`));
  }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Missing config file: ${CONFIG_PATH}`);
    console.error('This script reuses the same image-search.config.json as add-images.js.');
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

// ── Google auth: service account JWT-bearer flow (same as add-images.js) ──

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

async function getTabId(sheetId, accessToken, tabName) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties(sheetId,title)`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Failed to read spreadsheet metadata: ${await res.text()}`);
  const data = await res.json();
  const tab = (data.sheets || []).find(s => s.properties && s.properties.title === tabName);
  if (!tab) throw new Error(`Could not find a tab named "${tabName}"`);
  return tab.properties.sheetId;
}

async function fetchSheetRows(sheetId, accessToken) {
  const range = encodeURIComponent(`${SHEET_TAB}!A2:J`);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Failed to read sheet: ${await res.text()}`);
  const data = await res.json();
  return data.values || [];
}

async function batchWriteValues(sheetId, accessToken, updates, valueInputOption) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption, data: updates }),
  });
  if (!res.ok) throw new Error(`Failed to write values: ${await res.text()}`);
}

// Draw the start-of-day line: thin black top border across columns A–J on
// each day-start row. Only the "top" border is set, so the interior grid on
// the option cells is left as-is. Re-running is harmless (same border).
async function drawDayLines(sheetId, accessToken, tabId, dayStartRows) {
  const black = { red: 0, green: 0, blue: 0 };
  const requests = dayStartRows.map(row => ({
    updateBorders: {
      range: {
        sheetId: tabId,
        startRowIndex: row - 1, // 0-based, inclusive
        endRowIndex: row,       // exclusive
        startColumnIndex: 0,
        endColumnIndex: LAST_COL_INDEX,
      },
      top: { style: 'SOLID', width: 1, color: black },
    },
  }));
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`Failed to draw day lines: ${await res.text()}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
