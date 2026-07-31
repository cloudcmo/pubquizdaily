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
//
// The send logic lives in runBroadcast(), which is also used by the on-demand
// weekly-send-now.js endpoint. If a scheduled run SKIPS (cancelled / nothing
// built), it emails the admin so a silent no-send is never a surprise.

exports.handler = async function() {
  if (londonHour() !== 6) {
    console.log(`weekly-broadcast: not the 06:00 UK hour (London hour ${londonHour()}) — skipping`);
    return { statusCode: 200, body: 'Not the scheduled UK hour' };
  }

  const env = readEnv();
  if (!env) return { statusCode: 500, body: 'Missing env vars' };

  const fridayISO = londonDateISO();
  const r = await runBroadcast({ ...env, fridayISO, ignoreCancel: false });

  // Surface a skip so it's never silent again.
  if (env.REPORT_EMAIL && (r.status === 'cancelled' || r.status === 'nothing-built')) {
    const why = r.status === 'cancelled'
      ? `it was cancelled (the "Cancel this week's send" flag is set). If that wasn't you, it may have been an email link scanner. To send it anyway, open your weekly-send-now link.`
      : `no email was built for ${fridayISO}. Check the Thursday weekly-preview run, or rebuild it.`;
    await sendEmail(env.RESEND_API_KEY, env.REPORT_EMAIL,
      `[Pub Quiz Daily] Weekly NOT sent for ${fridayISO}`,
      `The Weekly Best-of for ${fridayISO} was not sent: ${why}`, null).catch(() => {});
  }

  console.log(`weekly-broadcast: ${fridayISO} -> ${r.status}`);
  return { statusCode: r.ok ? 200 : 500, body: r.status };
};

// Reads + validates the env this send needs. Returns null if a required one is
// missing. SEGMENT_ID is only required for a live (non-dry-run) send.
function readEnv() {
  const env = {
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    SEGMENT_ID:     process.env.RESEND_SEGMENT_ID,
    SITE_ID:        process.env.NETLIFY_SITE_ID,
    TOKEN:          process.env.NETLIFY_API_TOKEN,
    REPORT_EMAIL:   process.env.DAILY_REPORT_EMAIL,
    DRY_RUN:        process.env.WEEKLY_DRY_RUN === 'true',
  };
  if (!env.RESEND_API_KEY || !env.SITE_ID || !env.TOKEN) {
    console.error('weekly-broadcast: missing required env vars');
    return null;
  }
  if (!env.DRY_RUN && !env.SEGMENT_ID) {
    console.error('weekly-broadcast: missing RESEND_SEGMENT_ID');
    return null;
  }
  return env;
}

// Sends the stored Weekly Best-of for `fridayISO`. Shared by the Friday cron
// (respects the cancel flag) and weekly-send-now (ignoreCancel: true). Returns
// { ok, status, error? } where status is one of:
// already-sent | cancelled | nothing-built | dry-run | sent | failed.
async function runBroadcast({ RESEND_API_KEY, SEGMENT_ID, SITE_ID, TOKEN, REPORT_EMAIL, DRY_RUN, fridayISO, ignoreCancel }) {
  // De-dupe (retries / double-fire).
  if (await blobExists(SITE_ID, TOKEN, `weekly-sent-${fridayISO}`)) {
    return { ok: true, status: 'already-sent' };
  }
  // Cancelled via the preview link? (Skipped when the admin forces a manual send.)
  if (!ignoreCancel && await blobExists(SITE_ID, TOKEN, `weekly-cancel-${fridayISO}`)) {
    return { ok: true, status: 'cancelled' };
  }

  const built = await getBlob(SITE_ID, TOKEN, `weekly-built-${fridayISO}`);
  if (!built || !built.html || !built.subject) {
    return { ok: true, status: 'nothing-built' };
  }

  // Mark sent up-front so a retry / double-fire can't double-send.
  await putBlob(SITE_ID, TOKEN, `weekly-sent-${fridayISO}`, { sentAt: new Date().toISOString() });

  if (DRY_RUN) {
    const html = built.html.replace('%%UNSUB%%', '#');
    await sendEmail(RESEND_API_KEY, REPORT_EMAIL, `[TEST] ${built.subject}`, 'Dry-run of the weekly broadcast.', html);
    return { ok: true, status: 'dry-run' };
  }

  // Live: Resend substitutes {{{RESEND_UNSUBSCRIBE_URL}}} and skips unsubscribed.
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
    const err = await res.text();
    console.error('weekly-broadcast: broadcast failed:', err);
    // Roll back the sent-marker so a later retry can try again.
    await deleteBlob(SITE_ID, TOKEN, `weekly-sent-${fridayISO}`);
    return { ok: false, status: 'failed', error: err };
  }
  return { ok: true, status: 'sent' };
}

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

// Shared with weekly-send-now.js (requiring this file does not run the handler).
module.exports.runBroadcast = runBroadcast;
module.exports.readEnv = readEnv;
module.exports.londonDateISO = londonDateISO;
