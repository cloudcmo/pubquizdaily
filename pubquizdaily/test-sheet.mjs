// test-sheet.mjs - integration checks for the Google-Cloud-free sheet path.
// Run with: npm test   (no network, no credentials, no Netlify CLI needed)
//
// Added 2026-08-18 with the change that took the site off the Google Sheets
// API. Everything here would have passed before that change too, apart from
// the auto-select picks, which used to be written back into the sheet.
// Stubs global fetch: the Google CSV endpoint serves a fixture, the Netlify
// Blobs REST API is an in-memory store. No network, no credentials.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
const check = (n, c) => { c ? (pass++, console.log('  ok -', n)) : (fail++, console.log('FAIL -', n)); };

const iso = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const TODAY = iso(0), D1 = iso(-1), D2 = iso(-2), D3 = iso(-3), OLD = iso(-200), ANCIENT = iso(-500);

// ── the fixture sheet ────────────────────────────────────────────────────────
const q = (date, n, w) => [date, `Question ${n}?`, 'A opt', 'B opt', 'C opt', 'D opt', 'A',
  `Explainer, with a comma and "quotes" for ${n}`, w || '', `https://img/${n}.jpg`];
const MULTI = [
  ['date', 'question', 'A', 'B', 'C', 'D', 'correct', 'explainer', 'weekly', 'image'],
  q(TODAY, 't1'), q(TODAY, 't2'),
  q(D1, 'a', 'W'),          // flagged in the sheet, the old way
  q(D1, 'b'),               // will be an auto-pick, held in the blob
  q(D2, 'c'),
  q(D3, 'd'),
  q(OLD, 'ancient', 'W'),   // outside every window
];
const GROUPIE = [
  ['date', ...Array.from({ length: 20 }, (_, i) => `c${i}`)],
  [TODAY, ...Array.from({ length: 20 }, (_, i) => `word${i}`)],
];

// Google pads every row to the widest column and quotes everything.
function toCsv(rows) {
  const width = Math.max(...rows.map(r => r.length)) + 4; // trailing blank columns, as Google sends
  return rows
    .map(r => Array.from({ length: width }, (_, i) => `"${String(r[i] ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\r\n') + '\r\n';
}

// ── fetch stub ───────────────────────────────────────────────────────────────
const blobs = new Map();
const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push(u);

  if (u.includes('googleapis.com')) throw new Error('a Google Cloud API was called: ' + u);

  if (u.startsWith('https://docs.google.com/spreadsheets/')) {
    const tab = decodeURIComponent(new URL(u).searchParams.get('sheet'));
    const rows = tab === 'Groupie' ? GROUPIE : MULTI;
    return { ok: true, status: 200, text: async () => toCsv(rows) };
  }

  if (u.startsWith('https://api.netlify.com/api/v1/blobs/')) {
    const key = u.replace('https://api.netlify.com/api/v1/blobs/', '');
    if ((opts.method || 'GET') === 'PUT') { blobs.set(key, opts.body); return { ok: true, status: 200, text: async () => '' }; }
    if (!blobs.has(key)) return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
    return { ok: true, status: 200, json: async () => JSON.parse(blobs.get(key)), text: async () => blobs.get(key) };
  }

  throw new Error('unexpected fetch: ' + u);
};

process.env.GOOGLE_SHEET_ID = 'SHEET123';
process.env.NETLIFY_SITE_ID = 'SITE123';
process.env.NETLIFY_API_TOKEN = 'TOK123';

const body = (r) => JSON.parse(r.body);

// ── sheet reader ─────────────────────────────────────────────────────────────
const { fetchSheetRows } = require('./netlify/lib/sheet.js');
{
  const rows = await fetchSheetRows('SHEET123', 'multi');
  check('reader returns header + every row', rows.length === MULTI.length);
  check('reader trims the padding back to 10 columns', rows[0].length === 10);
  check('commas and quotes inside a cell survive', rows[1][7] === MULTI[1][7]);
  check('a blank weekly cell stays blank', rows[2][8] === '');
  check('no Google Cloud endpoint was touched', !calls.some(c => c.includes('googleapis.com')));
}

// ── question ─────────────────────────────────────────────────────────────────
{
  const r = await require('./netlify/functions/question.js').handler({ queryStringParameters: {} });
  check('question: 200 for today', r.statusCode === 200);
  check('question: both of today\'s questions', body(r).questions.length === 2);
  const old = await require('./netlify/functions/question.js').handler({ queryStringParameters: { date: OLD } });
  check('question: retention window still enforced', old.statusCode === 404);
}

// ── groupie ──────────────────────────────────────────────────────────────────
{
  const r = await require('./netlify/functions/groupie.js').handler({ queryStringParameters: {} });
  check('groupie: 200 for today', r.statusCode === 200);
  check('groupie: 21-column row read correctly', JSON.stringify(body(r)).includes('word19'));
}

// ── more ─────────────────────────────────────────────────────────────────────
{
  const r = await require('./netlify/functions/more.js').handler({});
  check('more: 200', r.statusCode === 200);
}

// ── weekly: sheet W flags only, before any auto-pick ──────────────────────────
{
  const r = await require('./netlify/functions/weekly.js').handler({ queryStringParameters: {} });
  check('weekly: only the sheet-flagged question', body(r).questions.length === 1);
  check('weekly: it is the right one', body(r).questions[0].question === 'Question a?');
}

// ── the picks blob ───────────────────────────────────────────────────────────
const picks = require('./netlify/lib/weekly-picks.js');
{
  check('no picks blob yet', (await picks.loadPickSet()).size === 0);
  await picks.addPicks([{ date: D1, question: 'Question b?' }]);
  const set = await picks.loadPickSet();
  check('pick saved', set.size === 1);
  check('pick matches on date + question, case-insensitively', set.has(picks.pickKey(D1, 'question B?')));
  await picks.addPicks([{ date: D1, question: 'Question b?' }]);
  check('adding the same pick twice does not duplicate', (await picks.loadPickSet()).size === 1);
  await picks.addPicks([{ date: ANCIENT, question: 'Question ancient?' }]);
  const stored = JSON.parse(blobs.get('SITE123/weekly-picks/auto'));
  check('picks older than the retention window are pruned', !stored.picks.some(p => p.date === ANCIENT));
}

// ── weekly again: sheet flag + blob pick together ─────────────────────────────
{
  delete require.cache[require.resolve('./netlify/functions/weekly.js')];
  const r = await require('./netlify/functions/weekly.js').handler({ queryStringParameters: {} });
  const qs = body(r).questions.map(x => x.question).sort();
  check('weekly: sheet flag and blob pick both count', qs.length === 2);
  check('weekly: the auto-picked one is included', qs.includes('Question b?'));
}

// ── archive: same overlay ────────────────────────────────────────────────────
{
  const r = await require('./netlify/functions/archive.js').handler({ queryStringParameters: {} });
  check('archive: 200', r.statusCode === 200);
  const json = JSON.stringify(body(r));
  check('archive: counts the blob pick as weekly', json.includes(D1));
}

// ── a broken sheet must fail loudly, not serve nonsense ──────────────────────
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '<html><body>Sign in</body></html>' });
  let msg = '';
  try { await fetchSheetRows('SHEET123', 'multi'); } catch (e) { msg = e.message; }
  check('an HTML sign-in page throws instead of parsing', /returned HTML/.test(msg));
  globalThis.fetch = realFetch;
}

// ── the blob being unreachable must not take the quiz down ───────────────────
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.netlify.com')) return { ok: false, status: 500, text: async () => 'boom' };
    return realFetch(url, opts);
  };
  check('picks failing to load degrades to an empty set', (await picks.loadPickSet()).size === 0);
  delete require.cache[require.resolve('./netlify/functions/weekly.js')];
  const r = await require('./netlify/functions/weekly.js').handler({ queryStringParameters: {} });
  check('weekly still serves the sheet-flagged question', r.statusCode === 200 && body(r).questions.length === 1);
  globalThis.fetch = realFetch;
}

// ── weekly-preview: auto-select writes to the blob, never to Google ──────────
{
  blobs.clear();
  const wp = require('./netlify/functions/weekly-preview.js');
  const fridayISO = D1; // window = D2..D8, none of which carry a W
  const out = await wp.fetchWeeklyQuestions({ SHEET_ID: 'SHEET123', fridayISO, SITE_ID: 'SITE123', TOKEN: 'TOK123' });
  check('auto-select returned questions', out.length > 0);
  check('auto-select recorded its picks in the blob', blobs.has('SITE123/weekly-picks/auto'));
  const saved = JSON.parse(blobs.get('SITE123/weekly-picks/auto')).picks;
  check('every returned question is in the blob', out.every(o => saved.some(p => p.q === o.question && p.date === o.date)));
  check('still no Google Cloud call anywhere', !calls.some(c => c.includes('googleapis.com')));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
