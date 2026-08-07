// netlify/functions/weekly-watchdog.js
// Friday ~08:00 UK: safety net for the 06:30 weekly-broadcast send.
//
// WHY THIS EXISTS: on 2026-08-07 Netlify never ran the scheduled 06:30
// weekly-broadcast invocation. Because the function never executed, nothing
// could email a warning either — a silent no-send. This watchdog runs 90
// minutes later and, if the email was built but neither sent nor cancelled,
// SENDS IT (and emails the admin that the fallback fired). A missed cron now
// self-heals instead of failing silently.
//
// Safe by design, using the same runBroadcast() as the 06:30 run:
//   - already sent   -> does nothing (the normal case every healthy Friday)
//   - cancelled      -> does NOT send (honours a real cancellation); emails a reminder
//   - nothing built  -> does not send; emails a warning about the Thursday build
//   - otherwise      -> sends exactly once (the sent-marker blocks double-sends)
//
// DST-proof like the others: fires at 07:00 AND 08:00 UTC on Fridays; only the
// firing where the Europe/London hour is 8 proceeds.

const wb = require('./weekly-broadcast');

exports.handler = async function() {
  if (wb.londonHour() !== 8) {
    console.log(`weekly-watchdog: not the 08:00 UK hour — skipping`);
    return { statusCode: 200, body: 'Not the scheduled UK hour' };
  }

  const env = wb.readEnv();
  if (!env) return { statusCode: 500, body: 'Missing env vars' };

  const fridayISO = wb.londonDateISO();

  // The normal case: the 06:30 send happened. Stay silent, do nothing.
  if (await wb.blobExists(env.SITE_ID, env.TOKEN, `weekly-sent-${fridayISO}`)) {
    console.log(`weekly-watchdog: ${fridayISO} already sent — all good`);
    return { statusCode: 200, body: 'already-sent' };
  }

  // Not sent by 08:00 — the 06:30 run was missed or died. Try to send now,
  // still honouring a genuine cancellation.
  const r = await wb.runBroadcast({ ...env, fridayISO, ignoreCancel: false });

  const subjects = {
    'sent':          `[Pub Quiz Daily] 06:30 send was MISSED — the 08:00 watchdog sent it`,
    'already-sent':  null, // raced with a late 06:30 run; nothing to report
    'cancelled':     `[Pub Quiz Daily] Weekly NOT sent for ${fridayISO} (cancelled)`,
    'nothing-built': `[Pub Quiz Daily] Weekly NOT sent for ${fridayISO} (nothing built)`,
    'dry-run':       `[Pub Quiz Daily] Watchdog ran as DRY RUN for ${fridayISO}`,
    'failed':        `[Pub Quiz Daily] Watchdog send FAILED for ${fridayISO}`,
  };
  const bodies = {
    'sent':          `The scheduled 06:30 send did not happen this morning (missed Netlify invocation). The 08:00 watchdog has sent the Weekly Best-of for ${fridayISO} to subscribers now. No action needed, but worth a glance at the Netlify function logs.`,
    'cancelled':     `The 06:30 send did not happen and the cancel flag is set for ${fridayISO}, so the watchdog did not send. If you cancelled this week, all is well. If you didn't, a scanner may have set it: use your weekly-send-now link.`,
    'nothing-built': `By 08:00 no email was built for ${fridayISO}, so there is nothing to send. Check the Thursday weekly-preview run, then use weekly-rebuild + weekly-send-now.`,
    'dry-run':       `WEEKLY_DRY_RUN is "true", so the watchdog sent a [TEST] copy to this address instead of subscribers — and the sent-marker is now set, so nothing will send this week unless you clear it. Turn WEEKLY_DRY_RUN off.`,
    'failed':        `The watchdog tried to send the Weekly Best-of for ${fridayISO} but Resend rejected it: ${String(r.error || '').replace(/\s+/g, ' ').slice(0, 300)}. The sent-marker was rolled back, so weekly-send-now can still send it.`,
  };

  if (env.REPORT_EMAIL && subjects[r.status]) {
    await wb.sendEmail(env.RESEND_API_KEY, env.REPORT_EMAIL, subjects[r.status], bodies[r.status], null)
      .catch((e) => console.error('weekly-watchdog: admin email failed:', e));
  }

  console.log(`weekly-watchdog: ${fridayISO} -> ${r.status}`);
  return { statusCode: r.ok ? 200 : 500, body: r.status };
};
