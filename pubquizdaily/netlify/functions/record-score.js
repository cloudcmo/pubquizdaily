// netlify/functions/record-score.js
// How the whole pub scored today, for the "Better than X% of the pub" line on
// the bar tab and in the share text (12 Nov 2026).
//
// One blob per day in its own store, quiz-scores/YYYY-MM-DD, holding
// { counts: { "0": n, "1": n, "2": n, "3": n } }. Kept out of quiz-stats on
// purpose: stats.js and daily-report.js read every key in quiz-stats and expect
// the YYYY-MM-DD-N per-question shape.
//
// POST { date, score, n }  -> records one finished game (the page sends it once
//                             per browser per day) and returns the counts
// GET  ?date=YYYY-MM-DD    -> returns the counts
// Daily play only; the page never posts archive plays.

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  const empty = { statusCode: 200, headers, body: JSON.stringify({ counts: {} }) };

  const SITE_ID = process.env.NETLIFY_SITE_ID;
  const TOKEN = process.env.NETLIFY_API_TOKEN;
  if (!SITE_ID || !TOKEN) return empty;
  const auth = { Authorization: `Bearer ${TOKEN}` };

  let date, score, n;
  if (event.httpMethod === 'GET') {
    date = event.queryStringParameters?.date;
  } else if (event.httpMethod === 'POST') {
    try {
      const b = JSON.parse(event.body || '{}');
      date = b.date; score = b.score; n = b.n;
    } catch { return empty; }
  } else {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return empty;
  const url = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/quiz-scores/${date}`;

  try {
    let data = { counts: {} };
    const res = await fetch(url, { headers: auth });
    if (res.ok) data = await res.json();
    if (!data.counts) data.counts = {};

    if (event.httpMethod === 'POST') {
      // Only today's (or yesterday's, for a game finished just after midnight) date
      const today = new Date().toISOString().slice(0, 10);
      const y = new Date(); y.setUTCDate(y.getUTCDate() - 1);
      const ok = date === today || date === y.toISOString().slice(0, 10);
      if (ok && Number.isInteger(score) && Number.isInteger(n) && n > 0 && n <= 10 && score >= 0 && score <= n) {
        data.counts[score] = (data.counts[score] || 0) + 1;
        await fetch(url, {
          method: 'PUT',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        });
      }
    }
    return { statusCode: 200, headers, body: JSON.stringify(data) };
  } catch (e) {
    console.error('record-score error:', e);
    return empty;
  }
};
