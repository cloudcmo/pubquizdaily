// netlify/functions/question.js
// Fetches all quiz questions for a given date from the 'multi' tab of the Google Sheet
// Sheet columns: date | question | A | B | C | D | correct | explainer | weekly | image
//
// Retention window (added 2026-07-07, Carl's request): to limit copyright
// exposure from internet-sourced images used to illustrate questions, this
// endpoint only serves dates within the last CUTOFF_DAYS days. There is no
// static archive any more (archive.html and the pre-rendered weekly pages
// were removed 2026-07-07) — this dynamic route is now the ONLY way to view
// a past date, so this cutoff is the sole enforcement point for the
// retention window.
const CUTOFF_DAYS = parseInt(process.env.CUTOFF_DAYS || '10', 10);

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=60',
  };

  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  const API_KEY  = process.env.GOOGLE_API_KEY;

  if (!SHEET_ID || !API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing environment variables' }) };
  }

  const requestedDate = event.queryStringParameters?.date || todayISO();

  // Reject dates outside the retention window before touching the sheet at
  // all — old images/questions should be unreachable, not just unlinked.
  if (requestedDate < cutoffDateISO(CUTOFF_DAYS)) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'This date is no longer available' }) };
  }

  try {
    const range = encodeURIComponent('multi!A:J');
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?key=${API_KEY}`;

    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.text();
      console.error('Sheets API error:', err);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Failed to fetch sheet' }) };
    }

    const data = await res.json();
    const rows = data.values || [];

    // Find all rows matching the requested date
    const matchingRows = rows.slice(1).filter(row => {
      const cellDate = (row[0] || '').trim();
      return cellDate === requestedDate || parseFlexDate(cellDate) === requestedDate;
    });

    if (matchingRows.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No questions for this date' }) };
    }

    // Map each row to a question object
    const questions = matchingRows.map((row, index) => {
      const [date, question, optA, optB, optC, optD, correct, explainer, weekly, image] = row;

      if (!question || !optA || !optB || !optC || !optD || !correct) return null;

      return {
        index,
        question: question.trim(),
        options: [optA.trim(), optB.trim(), optC.trim(), optD.trim()],
        correct: correct.trim().toUpperCase(),
        explainer: explainer ? explainer.trim() : null,
        weekly: (weekly || '').trim().toUpperCase() === 'W',
        image: image ? image.trim() : null,
      };
    }).filter(Boolean);

    if (questions.length === 0) {
      return { statusCode: 422, headers, body: JSON.stringify({ error: 'Incomplete question data in sheet' }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ date: requestedDate, questions }),
    };

  } catch (err) {
    console.error('Function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Oldest ISO date (inclusive) still within the retention window.
function cutoffDateISO(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function parseFlexDate(str) {
  if (!str) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return '';
}
