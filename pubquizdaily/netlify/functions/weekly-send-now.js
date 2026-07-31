// netlify/functions/weekly-send-now.js
// On-demand "send the weekly NOW" fallback, for when the scheduled Friday
// broadcast didn't fire (e.g. a missed cron, or a spurious cancel). Reuses the
// exact same send logic as weekly-broadcast.js.
//
//   /.netlify/functions/weekly-send-now?token=YOUR_WEEKLY_CANCEL_TOKEN
//
// Safe by design: a bare GET only shows a confirmation page (so link scanners
// can't trigger a real send); the send happens on POST when you press the button.
// It bypasses the hour gate and ignores the cancel flag (you're deliberately
// choosing to send), but still respects the "already sent" marker so it can't
// double-send. Targets TODAY's date as the Friday key.

const wb = require('./weekly-broadcast');

exports.handler = async function(event) {
  const htmlHeaders = { 'Content-Type': 'text/html; charset=utf-8' };

  const token = event.queryStringParameters?.token;
  const SEND_TOKEN = process.env.WEEKLY_SEND_TOKEN || process.env.WEEKLY_CANCEL_TOKEN;
  if (!SEND_TOKEN || token !== SEND_TOKEN) {
    return { statusCode: 403, headers: htmlHeaders, body: page('Not allowed', 'That link is invalid.') };
  }

  const env = wb.readEnv();
  if (!env) {
    return { statusCode: 500, headers: htmlHeaders, body: page('Configuration error', 'The send endpoint is missing environment variables.') };
  }

  const fridayISO = wb.londonDateISO();

  // Safe GET: confirmation page only.
  if ((event.httpMethod || 'GET').toUpperCase() !== 'POST') {
    const action = `/.netlify/functions/weekly-send-now?token=${encodeURIComponent(token)}`;
    return {
      statusCode: 200, headers: htmlHeaders,
      body: page('Send the weekly now?',
        `This sends the stored Weekly Best-of for <strong>${fridayISO}</strong> to all subscribers immediately, even if it was cancelled. Only use this if the scheduled 06:30 send did not go out.
        <form method="POST" action="${action}" style="margin:22px 0 0;">
          <button type="submit" style="display:inline-block;background:#4a7c59;color:#fff;border:none;border-radius:9px;padding:13px 26px;font-size:15px;font-weight:700;cursor:pointer;font-family:-apple-system,Arial,sans-serif;">Yes, send it now</button>
        </form>`),
    };
  }

  // POST = send it.
  const r = await wb.runBroadcast({ ...env, fridayISO, ignoreCancel: true });
  const messages = {
    'sent':          ['Sent ✓', `The Weekly Best-of for ${fridayISO} is going out to your subscribers now.`],
    'already-sent':  ['Already sent', `The Weekly Best-of for ${fridayISO} was already sent, so nothing was sent again.`],
    'nothing-built': ['Nothing to send', `No email was built for ${fridayISO}. Rebuild it first (weekly-rebuild), then try again.`],
    'dry-run':       ['Dry run', `WEEKLY_DRY_RUN is on, so a test copy went to your report address instead of subscribers.`],
    'failed':        ['Send failed', `Resend rejected the send: ${String(r.error || '').replace(/\s+/g, ' ').slice(0, 200)}`],
  };
  const [title, body] = messages[r.status] || ['Result', r.status];
  return { statusCode: r.ok ? 200 : 500, headers: htmlHeaders, body: page(title, body) };
};

function page(title, body) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title} — Pub Quiz Daily</title></head>
<body style="margin:0;background:#faf9f7;font-family:-apple-system,Arial,sans-serif;color:#1a1a1a;">
<div style="max-width:460px;margin:12vh auto;padding:0 24px;text-align:center;">
  <div style="font-family:Georgia,serif;font-size:22px;font-weight:700;margin-bottom:8px;">Pub Quiz Daily</div>
  <div style="background:#fff;border:1px solid #e7e3dc;border-radius:14px;padding:30px 26px;">
    <div style="font-family:Georgia,serif;font-size:22px;margin-bottom:10px;">${title}</div>
    <div style="font-size:15px;line-height:1.6;color:#4a4a4a;margin:0;">${body}</div>
  </div>
</div>
</body></html>`;
}
