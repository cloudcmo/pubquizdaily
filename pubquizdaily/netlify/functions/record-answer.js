// netlify/functions/record-answer.js
// Records a player's answer and returns today's stats
// Uses Netlify Blobs for persistent storage (no database needed)

const { getStore } = require('@netlify/blobs');

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  const store = getStore('quiz-stats');

  // GET — just fetch today's stats (for returning players)
  if (event.httpMethod === 'GET') {
    const date = event.queryStringParameters?.date || todayISO();
    try {
      const raw = await store.get(date);
      if (!raw) return { statusCode: 200, headers, body: JSON.stringify({ total: 0, correctCount: 0 }) };
      return { statusCode: 200, headers, body: raw };
    } catch (e) {
      return { statusCode: 200, headers, body: JSON.stringify({ total: 0, correctCount: 0 }) };
    }
  }

  // POST — record a new answer
  if (event.httpMethod === 'POST') {
    let body;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const { date, correct } = body;
    if (!date) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing date' }) };

    try {
      // Read current counts
      let stats = { total: 0, correctCount: 0 };
      const raw = await store.get(date);
      if (raw) stats = JSON.parse(raw);

      // Increment
      stats.total += 1;
      if (correct) stats.correctCount += 1;

      // Save back
      await store.set(date, JSON.stringify(stats));

      return { statusCode: 200, headers, body: JSON.stringify(stats) };
    } catch (e) {
      console.error('Blob error:', e);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Storage error' }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
