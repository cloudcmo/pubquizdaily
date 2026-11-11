#!/usr/bin/env node
// scripts/christmas-swap.js  (11 Nov 2026)
//
// Puts the December Christmas questions into the "multi" tab of the Pub Quiz
// Daily sheet, following Carl's rule: at least one Christmas question every
// day of December, and all three on 20 to 27 December.
//
// Reads christmas-questions.json in the repo root. Each entry names a day and
// a slot (0, 1 or 2 = first, second or third question of that day) and the
// start of the question it replaces ("replaces").
//
// Nothing is lost: every question it takes out of December is moved, in
// order, to the first empty days after the last filled day (early January),
// with its image. The weekly Best-of mark (column I) stays on the December
// day, so a Christmas question takes it over. Christmas rows have no image yet
// (add-images.js can fill them).
//
// SAFETY
//   • Before touching anything it saves the whole tab to
//     _backups/multi-before-christmas-<time>.json.
//   • A slot whose question doesn't start with the expected text is skipped,
//     not overwritten (so a question you've edited by hand is left alone).
//   • A slot that already holds its Christmas question is skipped, so running
//     it twice does nothing the second time.
//   • The moved questions only go into rows with no question in them.
//
// Uses the same image-search.config.json as add-images.js / draft-questions.js.
//
//   node scripts/christmas-swap.js --dry-run   show what it WOULD do
//   node scripts/christmas-swap.js             do it

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'image-search.config.json');
const QUESTIONS_PATH = path.join(ROOT, 'christmas-questions.json');
const TAB = 'multi';
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const xmas = JSON.parse(fs.readFileSync(QUESTIONS_PATH, 'utf8'));
  const token = await getAccessToken(config.googleServiceAccount);
  const tabId = await getTabId(config.sheetId, token, TAB);
  const rows = await readRows(config.sheetId, token); // index 0 = sheet row 2

  // Day -> its sheet row numbers, in order
  const dayRows = {};
  rows.forEach((r, i) => {
    const d = (r[0] || '').trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) (dayRows[d] = dayRows[d] || []).push(i + 2);
  });
  const cell = (row, col) => ((rows[row - 2] || [])[col] || '').trim();

  const writes = [];   // { range, values }
  const moved = [];    // B..J of each question taken out of December
  const skipped = [];
  let done = 0;

  for (const q of xmas) {
    const row = (dayRows[q.date] || [])[q.slot];
    if (!row) { skipped.push(`${q.date} Q${q.slot + 1}: no such row`); continue; }
    const current = cell(row, 1);
    if (current === q.question) { done++; continue; }
    if (!current.startsWith(q.replaces)) {
      skipped.push(`${q.date} Q${q.slot + 1} (row ${row}): expected "${q.replaces}...", found "${current.slice(0, 50)}"`);
      continue;
    }
    const old = rows[row - 2] || [];
    // The weekly Best-of mark stays with the day; the image goes with its question
    const vals = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(c => old[c] || '');
    vals[7] = '';
    moved.push({ from: `${q.date} Q${q.slot + 1}`, values: vals });
    writes.push({ range: `${TAB}!B${row}:J${row}`, values: [[q.question, q.A, q.B, q.C, q.D, q.correct, q.explainer, old[8] || '', '']] });
  }

  // Where the moved questions go: the rows straight after the last question
  let last = 0;
  rows.forEach((r, i) => { if ((r[1] || '').trim()) last = i + 2; });
  const start = last + 1;
  const formulas = [];
  const dayStarts = [];
  if (moved.length) {
    const prevDate = cell(last, 0).slice(0, 10), startDate = cell(start, 0).slice(0, 10);
    if (startDate && startDate === prevDate) throw new Error(`Row ${start} is not the start of a new day (${startDate}); stopping.`);
    for (let k = 0; k < moved.length; k++) {
      const row = start + k;
      if (cell(row, 1)) throw new Error(`Row ${row} already has a question; stopping before writing anything.`);
      writes.push({ range: `${TAB}!B${row}:J${row}`, values: [moved[k].values] });
      if (!cell(row, 0)) formulas.push({ range: `${TAB}!A${row}`, values: [[k % 3 === 0 ? `=A${row - 3}+1` : `=A${row - 1}`]] });
      if (k % 3 === 0) dayStarts.push(row);
    }
  }

  console.log('');
  console.log(`${DRY_RUN ? '[DRY RUN] Would put' : 'Putting'} ${moved.length} Christmas question(s) into December` + (done ? ` (${done} already there)` : ''));
  if (moved.length) {
    const firstDay = cell(start, 0).slice(0, 10) || `row ${start}`;
    console.log(`and move the ${moved.length} question(s) they replace to rows ${start} to ${start + moved.length - 1} (from ${firstDay}).`);
  }
  if (DRY_RUN) {
    xmas.forEach(q => console.log(`  ${q.date} Q${q.slot + 1}: ${q.question}`));
    console.log('');
    moved.forEach((m, k) => console.log(`  row ${start + k} <- ${m.from}: ${m.values[0].slice(0, 70)}`));
  }
  if (skipped.length) {
    console.log('');
    console.log(`Skipped ${skipped.length}:`);
    skipped.forEach(s => console.log('  ' + s));
  }
  if (DRY_RUN || !writes.length) return;

  const backupDir = path.join(ROOT, '_backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, `multi-before-christmas-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(backup, JSON.stringify(rows));
  console.log('');
  console.log(`Backup of the whole tab: ${path.relative(ROOT, backup)}`);

  if (formulas.length) await batchWrite(config.sheetId, token, formulas, 'USER_ENTERED');
  await batchWrite(config.sheetId, token, writes, 'RAW');
  if (dayStarts.length) await drawDayLines(config.sheetId, token, tabId, dayStarts);
  console.log('Done. Open the sheet to check December and early January.');
}

// ── Google auth and Sheets (same as draft-questions.js) ──

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const head = base64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = base64url(Buffer.from(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token', exp: now + 3600, iat: now,
  })));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${head}.${claim}`);
  const jwt = `${head}.${claim}.${base64url(signer.sign(sa.private_key))}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!res.ok) throw new Error(`Google auth failed: ${await res.text()}`);
  return (await res.json()).access_token;
}

async function getTabId(sheetId, token, name) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}?fields=sheets.properties(sheetId,title)`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Failed to read spreadsheet: ${await res.text()}`);
  const tab = ((await res.json()).sheets || []).find(s => s.properties.title === name);
  if (!tab) throw new Error(`No tab called "${name}"`);
  return tab.properties.sheetId;
}

async function readRows(sheetId, token) {
  const range = encodeURIComponent(`${TAB}!A2:J`);
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${range}`,
    { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Failed to read sheet: ${await res.text()}`);
  return (await res.json()).values || [];
}

async function batchWrite(sheetId, token, data, valueInputOption) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption, data }),
  });
  if (!res.ok) throw new Error(`Failed to write: ${await res.text()}`);
}

async function drawDayLines(sheetId, token, tabId, rowsList) {
  const black = { red: 0, green: 0, blue: 0 };
  const requests = rowsList.map(row => ({
    updateBorders: {
      range: { sheetId: tabId, startRowIndex: row - 1, endRowIndex: row, startColumnIndex: 0, endColumnIndex: 10 },
      top: { style: 'SOLID', width: 1, color: black },
    },
  }));
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sheetId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) throw new Error(`Failed to draw day lines: ${await res.text()}`);
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
