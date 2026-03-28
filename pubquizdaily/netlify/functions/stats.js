// netlify/functions/stats.js
// Returns stats for all dates — password protected
// Blob keys format: YYYY-MM-DD-N (one per question per day)

exports.handler = async function(event) {
  const headers = { 'Content-Type': 'application/json' };

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
    const listUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/quiz-stats`;
    const listRes = await fetch(listUrl, { headers: authHeader });

    if (!listRes.ok) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Failed to list blobs' }) };
    }

    const listData = await listRes.json();
    const blobs = listData.blobs || [];

    // Fetch all blob data
    const rawResults = await Promise.all(
      blobs.map(async blob => {
        const key = blob.key;
        try {
          const res = await fetch(
            `https://api.netlify.com/api/v1/blobs/${SITE_ID}/quiz-stats/${key}`,
            { headers: authHeader }
          );
          if (!res.ok) return null;
          const data = await res.json();

          // Key format: YYYY-MM-DD-N (new) or YYYY-MM-DD (old single-question)
          const parts = key.split('-');
          let date, index;
          if (parts.length === 4) {
            date = parts.slice(0, 3).join('-');
            index = parseInt(parts[3]);
          } else {
            date = key;
            index = 0;
          }

          return { key, date, index, total: data.total || 0, correctCount: data.correctCount || 0 };
        } catch {
          return null;
        }
      })
    );

    // Group by date
    const byDate = {};
    rawResults.filter(Boolean).forEach(r => {
      if (!byDate[r.date]) byDate[r.date] = [];
      byDate[r.date].push(r);
    });

    const results = Object.entries(byDate).map(([date, qs]) => {
      qs.sort((a, b) => a.index - b.index);
      const players = Math.max(...qs.map(q => q.total));
      const correctCount = qs.reduce((s, q) => s + q.correctCount, 0);
      const total = qs.reduce((s, q) => s + q.total, 0);
      return {
        date,
        players,
        total,
        correctCount,
        questions: qs.map(q => ({ index: q.index, total: q.total, correctCount: q.correctCount })),
      };
    });

    results.sort((a, b) => b.date.localeCompare(a.date));

    return { statusCode: 200, headers, body: JSON.stringify({ stats: results }) };

  } catch (e) {
    console.error('Stats error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};
