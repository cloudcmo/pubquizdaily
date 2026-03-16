// netlify/functions/stats.js
// Returns stats for all dates — password protected

exports.handler = async function(event) {
  const headers = {
    'Content-Type': 'application/json',
  };

  // Simple password check
  const STATS_PASSWORD = process.env.STATS_PASSWORD;
  const supplied = event.queryStringParameters?.password;

  if (!STATS_PASSWORD || supplied !== STATS_PASSWORD) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorised' }) };
  }

  const SITE_ID = process.env.NETLIFY_SITE_ID;
  const TOKEN   = process.env.NETLIFY_API_TOKEN;

  if (!SITE_ID || !TOKEN) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing env vars' }) };
  }

  const authHeader = { 'Authorization': `Bearer ${TOKEN}` };

  try {
    // List all blobs in quiz-stats store
    const listUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/quiz-stats`;
    const listRes = await fetch(listUrl, { headers: authHeader });

    if (!listRes.ok) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Failed to list blobs' }) };
    }

    const listData = await listRes.json();
    const blobs = listData.blobs || [];

    // Fetch each date's stats
    const results = await Promise.all(
      blobs.map(async blob => {
        const date = blob.key;
        try {
          const res = await fetch(
            `https://api.netlify.com/api/v1/blobs/${SITE_ID}/quiz-stats/${date}`,
            { headers: authHeader }
          );
          if (!res.ok) return { date, total: 0, correctCount: 0 };
          const data = await res.json();
          return { date, total: data.total || 0, correctCount: data.correctCount || 0 };
        } catch {
          return { date, total: 0, correctCount: 0 };
        }
      })
    );

    // Sort newest first
    results.sort((a, b) => b.date.localeCompare(a.date));

    return { statusCode: 200, headers, body: JSON.stringify({ stats: results }) };

  } catch (e) {
    console.error('Stats error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
