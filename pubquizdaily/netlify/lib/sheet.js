// netlify/lib/sheet.js
// Reads a tab of the quiz Google Sheet with no Google Cloud credentials at all.
//
// This replaced the Sheets API (`sheets.googleapis.com/v4/.../values/<range>?key=`)
// on 2026-08-18, when Carl's Google Cloud trial was expiring: an API key belongs
// to a Cloud project, and a project attached to a lapsed billing account can be
// suspended, which would have taken the whole site's question supply with it.
//
// The API key only ever worked because the sheet is shared "anyone with the
// link can view" - API keys cannot read private sheets. That same sharing makes
// Google's visualisation CSV endpoint readable, so we ask for the tab as CSV
// and parse it. No key, no project, no billing, nothing to expire.
//
// fetchSheetRows() returns the same shape the Sheets API did - an array of row
// arrays, header row included, trailing empty cells trimmed - so callers that
// used `(await res.json()).values` only had to change how they get the rows.

const CSV_ORIGIN = 'https://docs.google.com/spreadsheets/d';

// Google's CSV export applies the sheet's display formatting, which is what
// `values.get` returned by default too (valueRenderOption=FORMATTED_VALUE), so
// dates and text arrive in exactly the same form as before.
function sheetCsvUrl(sheetId, tab) {
  return `${CSV_ORIGIN}/${encodeURIComponent(sheetId)}/gviz/tq` +
         `?tqx=out:csv&sheet=${encodeURIComponent(tab)}`;
}

// RFC 4180: fields may be quoted, quoted fields may contain commas, newlines
// and doubled quotes. Google emits CRLF between rows and quotes every field,
// but parse the general case so a hand-edited cell can't break the site.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += ch; i++; continue;
    }

    if (ch === '"') { quoted = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }

    field += ch; i++;
  }
  // Whatever is left when the text runs out is the final field of the final row.
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  return rows;
}

// The Sheets API omitted trailing empty cells from each row and trailing empty
// rows from the range. The CSV pads every row out to the widest column in the
// tab, so trim it back to keep `row.length` meaning what it used to.
function trimTrailingBlanks(rows) {
  const out = rows.map((row) => {
    let end = row.length;
    while (end > 0 && String(row[end - 1]).trim() === '') end--;
    return row.slice(0, end);
  });
  while (out.length && out[out.length - 1].length === 0) out.pop();
  return out;
}

async function fetchSheetRows(sheetId, tab) {
  if (!sheetId) throw new Error('GOOGLE_SHEET_ID is not set');

  const res = await fetch(sheetCsvUrl(sheetId, tab));
  if (!res.ok) throw new Error(`Sheet CSV ${res.status} for tab "${tab}"`);

  const text = await res.text();
  // A sign-in page or an error comes back as HTML, and would otherwise parse
  // into nonsense rows and look like an empty quiz. Fail loudly instead.
  if (/^\s*</.test(text)) {
    throw new Error(`Sheet CSV for tab "${tab}" returned HTML, not CSV - check the sheet is still shared "anyone with the link can view"`);
  }

  return trimTrailingBlanks(parseCsv(text));
}

module.exports = { fetchSheetRows, parseCsv, trimTrailingBlanks, sheetCsvUrl };
