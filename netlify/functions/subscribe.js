// netlify/functions/subscribe.js
// Adds an email address to Mailchimp audience

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const API_KEY   = process.env.MAILCHIMP_API_KEY;
  const AUDIENCE  = process.env.MAILCHIMP_AUDIENCE_ID;
  const DC        = process.env.MAILCHIMP_DC; // e.g. "us21"

  if (!API_KEY || !AUDIENCE || !DC) {
    console.error('Missing Mailchimp env vars');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server configuration error' }) };
  }

  let email;
  try {
    email = JSON.parse(event.body || '{}').email;
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) };
  }

  if (!email || !email.includes('@')) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid email address' }) };
  }

  try {
    const url = `https://${DC}.api.mailchimp.com/3.0/lists/${AUDIENCE}/members`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email_address: email.toLowerCase().trim(),
        status: 'subscribed',
        tags: ['pub-quiz-daily'],
      }),
    });

    const data = await res.json();

    // 400 with title "Member Exists" means already subscribed — treat as success
    if (res.ok || data.title === 'Member Exists') {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
    }

    console.error('Mailchimp error:', data);
    return { statusCode: 400, headers, body: JSON.stringify({ error: data.detail || 'Could not subscribe' }) };

  } catch (err) {
    console.error('Subscribe error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
