// netlify/functions/groupie.js
// Fetches today's Groupie puzzle from the 'Groupie' tab of the Google Sheet
// Sheet columns: date | w1 | w2 | w3 | w4 | exp1 | w5 | w6 | w7 | w8 | exp2 | w9 | w10 | w11 | w12 | exp3 | w13 | w14 | w15 | w16 | exp4

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300',
  };

  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  const API_KEY  = process.env.GOOGLE_API_KEY;

  if (!SHEET_ID || !API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing environment variables' }) };
  }

  const requestedDate = event.queryStringParameters?.date || todayISO();

  try {
    const range = encodeURIComponent('Groupie!A:U'); // 21 columns: date + 4 groups of 5
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?key=${API_KEY}`;

    const res = await fetch(url);
    if (!res.ok) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Failed to fetch sheet' }) };
    }

    const data = await res.json();
    const rows = data.values || [];

    const matchingRow = rows.slice(1).find(row => {
      const cellDate = (row[0] || '').trim();
      return cellDate === requestedDate || parseFlexDate(cellDate) === requestedDate;
    });

    if (!matchingRow) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No puzzle for this date' }) };
    }

    const [
      date,
      w1, w2, w3, w4, exp1,
      w5, w6, w7, w8, exp2,
      w9, w10, w11, w12, exp3,
      w13, w14, w15, w16, exp4
    ] = matchingRow;

    // Validate all 16 words exist
    const words = [w1,w2,w3,w4,w5,w6,w7,w8,w9,w10,w11,w12,w13,w14,w15,w16];
    if (words.some(w => !w)) {
      return { statusCode: 422, headers, body: JSON.stringify({ error: 'Incomplete puzzle data' }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        date: requestedDate,
        groups: [
          { words: [w1,w2,w3,w4].map(w => w.trim()), explainer: (exp1||'').trim(), color: 0 },
          { words: [w5,w6,w7,w8].map(w => w.trim()), explainer: (exp2||'').trim(), color: 1 },
          { words: [w9,w10,w11,w12].map(w => w.trim()), explainer: (exp3||'').trim(), color: 2 },
          { words: [w13,w14,w15,w16].map(w => w.trim()), explainer: (exp4||'').trim(), color: 3 },
        ],
      }),
    };

  } catch (err) {
    console.error('Groupie function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function parseFlexDate(str) {
  if (!str) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return '';
}
