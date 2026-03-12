// netlify/functions/question.js
// Fetches today's quiz question from a published Google Sheet

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300', // cache for 5 minutes
  };

  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  const API_KEY  = process.env.GOOGLE_API_KEY;

  if (!SHEET_ID || !API_KEY) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Missing environment variables' }),
    };
  }

  // The date to look up — from query param or today's date
  const requestedDate = event.queryStringParameters?.date || todayISO();

  try {
    // Fetch the sheet data via Google Sheets API v4
    // Range: Sheet1!A:G — columns A (date) through G (correct answer)
    const range = encodeURIComponent('Sheet1!A:G');
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?key=${API_KEY}`;

    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.text();
      console.error('Sheets API error:', err);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Failed to fetch sheet' }) };
    }

    const data = await res.json();
    const rows = data.values || [];

    // Row 0 is the header row — skip it
    // Each row: [date, question, A, B, C, D, correct]
    const matchingRow = rows.slice(1).find(row => {
      const cellDate = (row[0] || '').trim();
      // Accept either YYYY-MM-DD or DD/MM/YYYY (Google Sheets sometimes formats dates)
      return cellDate === requestedDate || parseFlexDate(cellDate) === requestedDate;
    });

    if (!matchingRow) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'No question for this date' }),
      };
    }

    const [date, question, optA, optB, optC, optD, correct] = matchingRow;

    // Validate
    if (!question || !optA || !optB || !optC || !optD || !correct) {
      return {
        statusCode: 422,
        headers,
        body: JSON.stringify({ error: 'Incomplete question data in sheet' }),
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        date: requestedDate,
        question: question.trim(),
        options: [optA.trim(), optB.trim(), optC.trim(), optD.trim()],
        correct: correct.trim().toUpperCase(), // "A", "B", "C", or "D"
      }),
    };

  } catch (err) {
    console.error('Function error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal error' }),
    };
  }
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Handle DD/MM/YYYY → YYYY-MM-DD conversion if Google Sheets reformats the date
function parseFlexDate(str) {
  if (!str) return '';
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  // DD/MM/YYYY
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }
  return '';
}
