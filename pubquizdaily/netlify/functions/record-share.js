// netlify/functions/record-share.js
// Records a share event for daily or weekly game

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const SITE_ID = process.env.NETLIFY_SITE_ID;
  const TOKEN   = process.env.NETLIFY_API_TOKEN;

  if (!SITE_ID || !TOKEN) {
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  let type, date;
  try {
    const body = JSON.parse(event.body || '{}');
    type = body.type || 'daily'; // 'daily' or 'weekly'
    date = body.date || todayISO();
  } catch {
    type = 'daily';
    date = todayISO();
  }

  const blobKey = `${type}/${date}`;
  const blobUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/quiz-shares/${blobKey}`;
  const authHeader = { 'Authorization': `Bearer ${TOKEN}` };

  try {
    let count = 0;
    const getRes = await fetch(blobUrl, { headers: authHeader });
    if (getRes.ok) {
      const data = await getRes.json();
      count = data.count || 0;
    }

    count += 1;

    await fetch(blobUrl, {
      method: 'PUT',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ count }),
    });

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, count }) };
  } catch (e) {
    console.error('record-share error:', e);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }
};

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
