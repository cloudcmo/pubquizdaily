// netlify/functions/weekly-cancel.js
// "Cancel this week's send", linked from the Thursday preview email.
//
// IMPORTANT: a bare GET does NOT cancel anything — it only shows a confirmation
// page. Email link scanners / prefetchers routinely fetch links in emails (a GET
// used to be enough to silently cancel a send). The cancellation only happens
// when the button on that page is pressed, which is a POST — scanners don't POST.

exports.handler = async function(event) {
  const htmlHeaders = { 'Content-Type': 'text/html; charset=utf-8' };

  const SITE_ID      = process.env.NETLIFY_SITE_ID;
  const TOKEN        = process.env.NETLIFY_API_TOKEN;
  const CANCEL_TOKEN = process.env.WEEKLY_CANCEL_TOKEN;

  if (!SITE_ID || !TOKEN || !CANCEL_TOKEN) {
    return { statusCode: 500, headers: htmlHeaders, body: page('Configuration error', 'The cancel endpoint is missing environment variables.') };
  }

  const token = event.queryStringParameters?.token;
  const week  = event.queryStringParameters?.week;

  if (token !== CANCEL_TOKEN) {
    return { statusCode: 403, headers: htmlHeaders, body: page('Not allowed', 'That cancel link is invalid.') };
  }
  if (!week || !/^\d{4}-\d{2}-\d{2}$/.test(week)) {
    return { statusCode: 400, headers: htmlHeaders, body: page('Bad request', 'Missing or invalid week.') };
  }

  // Safe GET: just show a confirmation page. A link scanner or prefetch stops here
  // and cancels nothing.
  if ((event.httpMethod || 'GET').toUpperCase() !== 'POST') {
    const action = `/.netlify/functions/weekly-cancel?token=${encodeURIComponent(token)}&week=${encodeURIComponent(week)}`;
    return { statusCode: 200, headers: htmlHeaders, body: confirmPage(week, action) };
  }

  // POST = a real person pressed the button. Now actually cancel.
  try {
    await fetch(`https://api.netlify.com/api/v1/blobs/${SITE_ID}/quiz-meta/weekly-cancel-${week}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ cancelled: true, cancelledAt: new Date().toISOString() }),
    });
    return {
      statusCode: 200,
      headers: htmlHeaders,
      body: page('Cancelled ✓', `The Weekly Best-of for Friday ${week} will <strong>not</strong> be sent. Next Friday resumes as normal.`),
    };
  } catch (e) {
    console.error('weekly-cancel error:', e);
    return { statusCode: 500, headers: htmlHeaders, body: page('Something went wrong', 'Could not record the cancellation. Try again, or pause the send in Netlify.') };
  }
};

function confirmPage(week, action) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Cancel this week's send? — Pub Quiz Daily</title></head>
<body style="margin:0;background:#faf9f7;font-family:-apple-system,Arial,sans-serif;color:#1a1a1a;">
<div style="max-width:460px;margin:12vh auto;padding:0 24px;text-align:center;">
  <div style="font-family:Georgia,serif;font-size:22px;font-weight:700;margin-bottom:8px;">Pub Quiz Daily</div>
  <div style="background:#fff;border:1px solid #e7e3dc;border-radius:14px;padding:30px 26px;">
    <div style="font-family:Georgia,serif;font-size:22px;margin-bottom:10px;">Cancel Friday's send?</div>
    <p style="font-size:15px;line-height:1.6;color:#4a4a4a;margin:0 0 22px;">This stops the Weekly Best-of for Friday ${week} from going out to subscribers. Nothing is cancelled until you press the button below.</p>
    <form method="POST" action="${action}" style="margin:0;">
      <button type="submit" style="display:inline-block;background:#c0503a;color:#fff;border:none;border-radius:9px;padding:13px 26px;font-size:15px;font-weight:700;cursor:pointer;font-family:-apple-system,Arial,sans-serif;">Yes, cancel Friday's send</button>
    </form>
    <p style="font-size:13px;color:#a49f97;margin:18px 0 0;">Changed your mind? Just close this page and the send goes out as normal.</p>
  </div>
</div>
</body></html>`;
}

function page(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title} — Pub Quiz Daily</title></head>
<body style="margin:0;background:#faf9f7;font-family:-apple-system,Arial,sans-serif;color:#1a1a1a;">
<div style="max-width:460px;margin:12vh auto;padding:0 24px;text-align:center;">
  <div style="font-family:Georgia,serif;font-size:22px;font-weight:700;margin-bottom:8px;">Pub Quiz Daily</div>
  <div style="background:#fff;border:1px solid #e7e3dc;border-radius:14px;padding:30px 26px;">
    <div style="font-family:Georgia,serif;font-size:22px;margin-bottom:10px;">${title}</div>
    <p style="font-size:15px;line-height:1.6;color:#4a4a4a;margin:0;">${body}</p>
  </div>
</div>
</body></html>`;
}
