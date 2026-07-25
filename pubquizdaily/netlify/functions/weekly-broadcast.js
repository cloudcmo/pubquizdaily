// netlify/functions/weekly-broadcast.js
// Friday ~06:30 UK: sends the Weekly Best-of that was built + previewed the
// evening before by weekly-preview.js — UNLESS it was cancelled via the
// one-click link. Sends as a Resend Broadcast to the Pub Quiz Daily segment.
//
// DST-proof: netlify.toml fires this at 05:30 AND 06:30 UTC on Fridays; the
// gate below only proceeds in the 06:xx Europe/London hour, so it's always
// ~06:30 UK year-round and exactly one firing sends.
//
// Testing: set WEEKLY_DRY_RUN=true to send the built email to DAILY_REPORT_EMAIL
// via a normal email instead of broadcasting to the segment.

exports.handler = async function() {
  if (londonHour() !== 6) {
    console.log(`weekly-broadcast: not the 06:00 UK hour (London hour ${londonHour()}) — skipping`);
    return { statusCode: 200, body: 'Not the scheduled UK hour' };
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const SEGMENT_ID     = process.env.RESEND_SEGMENT_ID;
  const SITE_ID        = process.env.NETLIFY_SITE_ID;
  const TOKEN          = process.env.NETLIFY_API_TOKEN;
  const REPORT_EMAIL   = process.env.DAILY_REPORT_EMAIL;
  const DRY_RUN        = process.env.WEEKLY_DRY_RUN === 'true';

  if (!RESEND_API_KEY || !SITE_ID || !TOKEN) {
    console.error('weekly-broadcast: missing required env vars');
    return { statusCode: 500, body: 'Missing env vars' };
  }
  if (!DRY_RUN && !SEGMENT_ID) {
    console.error('weekly-broadcast: missing RESEND_SEGMENT_ID');
    return { statusCode: 500, body: 'Missing RESEND_SEGMENT_ID' };
  }
  const authHeader = { 'Authorization': `Bearer ${TOKEN}` };
  const fridayISO = londonDateISO();

  try {
    // De-dupe (retries).
    if (await blobExists(SITE_ID, TOKEN, `weekly-sent-${fridayISO}`)) {
      console.log(`weekly-broadcast: already sent ${fridayISO} — skipping`);
      return { statusCode: 200, body: 'Already sent' };
    }

    // Cancelled via the preview link?
    if (await blobExists(SITE_ID, TOKEN, `weekly-cancel-${fridayISO}`)) {
      console.log(`weekly-broadcast: ${fridayISO} was cancelled — not sending`);
      return { statusCode: 200, body: 'Cancelled' };
    }

    // Load what was built + previewed last night.
    const built = await getBlob(SITE_ID, TOKEN, `weekly-built-${fridayISO}`);
    if (!built || !built.html || !built.subject) {
      console.error(`weekly-broadcast: no built email for ${fridayISO}`);
      if (REPORT_EMAIL) {
        await sendEmail(RESEND_API_KEY, REPORT_EMAIL,
          '[Pub Quiz Daily] Weekly not sent — nothing was built',
          `No preview was built for Friday ${fridayISO}, so nothing was sent. Check the Thursday weekly-preview run.`, null).catch(() => {});
      }
      return { statusCode: 200, body: 'Nothing built' };
    }

    // Mark sent up-front so a retry can't double-send.
    await putBlob(SITE_ID, TOKEN, `weekly-sent-${fridayISO}`, { sentAt: new Date().toISOString() });

    if (DRY_RUN) {
      const html = built.html.replace('%%UNSUB%%', '#');
      await sendEmail(RESEND_API_KEY, REPORT_EMAIL, `[TEST] ${built.subject}`, 'Dry-run of the weekly broadcast.', html);
      console.log(`weekly-broadcast: DRY RUN sent to ${REPORT_EMAIL}`);
      return { statusCode: 200, body: 'Dry run OK' };
    }

    // Live: Resend broadcasts substitute {{{RESEND_UNSUBSCRIBE_URL}}} and skip
    // unsubscribed/suppressed contacts automatically.
    const html = built.html.replace('%%UNSUB%%', '{{{RESEND_UNSUBSCRIBE_URL}}}');
    const res = await fetch('https://api.resend.com/broadcasts', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        segment_id: SEGMENT_ID,
        from: 'Pub Quiz Daily <hello@pubquizdaily.com>',
        name: `Weekly Best-of — ${fridayISO}`,
        subject: built.subject,
        html,
        send: true,
      }),
    });
    if (!res.ok) {
      console.error('weekly-broadcast: broadcast failed:', await res.text());
      // Roll back the sent-marker so a later retry can try again.
      await deleteBlob(SITE_ID, TOKEN, `weekly-sent-${fridayISO}`);
      return { statusCode: 500, body: 'Broadcast failed' };
    }

    console.log(`weekly-broadcast: sent ${fridayISO}`);
    return { statusCode: 200, body: 'OK' };

  } catch (e) {
    console.error('weekly-broadcast error:', e);
    return { statusCode: 500, body: 'Internal error' };
  }
};

// ── helpers ──
async function blobExists(siteId, token, key) {
  const r = await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/quiz-meta/${key}`, { headers: { 'Authorization': `Bearer ${token}` } });
  return r.ok;
}
async function getBlob(siteId, token, key) {
  const r = await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/quiz-meta/${key}`, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!r.ok) return null;
  return r.json();
}
async function putBlob(siteId, token, key, obj) {
  await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/quiz-meta/${key}`, {
    method: 'PUT', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(obj),
  });
}
async function deleteBlob(siteId, token, key) {
  try { await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/quiz-meta/${key}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${token}` } }); } catch {}
}
async function sendEmail(apiKey, to, subject, text, html) {
  const body = { from: 'Pub Quiz Daily <hello@pubquizdaily.com>', to: [to], subject, text };
  if (html) body.html = html;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Resend send failed: ${await res.text()}`);
}
function londonHour() {
  return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hour12: false }).format(new Date()), 10);
}
function londonDateISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
