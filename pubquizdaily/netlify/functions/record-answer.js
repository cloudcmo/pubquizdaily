// netlify/functions/record-answer.js
// Records answers and returns stats using Netlify Blobs REST API

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  const SITE_ID = process.env.NETLIFY_SITE_ID;
  const TOKEN   = process.env.NETLIFY_API_TOKEN;

  if (!SITE_ID || !TOKEN) {
    console.error('Missing NETLIFY_SITE_ID or NETLIFY_API_TOKEN');
    return { statusCode: 200, headers, body: JSON.stringify({ total: 0, correctCount: 0 }) };
  }

  const date = (event.httpMethod === 'GET'
    ? event.queryStringParameters?.date
    : JSON.parse(event.body || '{}').date) || todayISO();

  const blobUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/quiz-stats/${date}`;
  const authHeader = { 'Authorization': `Bearer ${TOKEN}` };

  // GET — fetch current stats
  if (event.httpMethod === 'GET') {
    try {
      const res = await fetch(blobUrl, { headers: authHeader });
      if (res.status === 404) return { statusCode: 200, headers, body: JSON.stringify({ total: 0, correctCount: 0 }) };
      const data = await res.json();
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    } catch (e) {
      console.error('GET error:', e);
      return { statusCode: 200, headers, body: JSON.stringify({ total: 0, correctCount: 0 }) };
    }
  }

  // POST — record a new answer
  if (event.httpMethod === 'POST') {
    let correct = false;
    try {
      correct = JSON.parse(event.body || '{}').correct || false;
    } catch {}

    try {
      // Read current
      let stats = { total: 0, correctCount: 0 };
      const getRes = await fetch(blobUrl, { headers: authHeader });
      if (getRes.ok) {
        stats = await getRes.json();
      }

      // Increment
      stats.total += 1;
      if (correct) stats.correctCount += 1;

      // Write back
      await fetch(blobUrl, {
        method: 'PUT',
        headers: { ...authHeader, 'Content-Type': 'application/json' },
        body: JSON.stringify(stats),
      });

      return { statusCode: 200, headers, body: JSON.stringify(stats) };
    } catch (e) {
      console.error('POST error:', e);
      return { statusCode: 200, headers, body: JSON.stringify({ total: 0, correctCount: 0 }) };
    }
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
