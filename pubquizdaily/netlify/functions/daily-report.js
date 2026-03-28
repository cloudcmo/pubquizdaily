// netlify/functions/daily-report.js
// Sends a daily stats summary email via Resend
// Scheduled to run at 8am UTC daily

exports.handler = async function(event) {
  const RESEND_API_KEY    = process.env.RESEND_API_KEY;
  const REPORT_EMAIL      = process.env.DAILY_REPORT_EMAIL;
  const SITE_ID           = process.env.NETLIFY_SITE_ID;
  const TOKEN             = process.env.NETLIFY_API_TOKEN;

  if (!RESEND_API_KEY || !REPORT_EMAIL || !SITE_ID || !TOKEN) {
    console.error('Missing env vars for daily report');
    return { statusCode: 500, body: 'Missing env vars' };
  }

  const authHeader = { 'Authorization': `Bearer ${TOKEN}` };

  // Yesterday's date
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayISO = yesterday.toISOString().slice(0, 10);
  const yesterdayLabel = yesterday.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });

  try {
    // ── Fetch yesterday's question stats ──
    let yesterdayPlayers = 0;
    let yesterdayAnswers = 0;
    let yesterdayCorrect = 0;
    let yesterdayQuestions = [];

    // List all blobs and filter for yesterday
    const listRes = await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/quiz-stats`,
      { headers: authHeader }
    );
    if (listRes.ok) {
      const listData = await listRes.json();
      const blobs = (listData.blobs || []).filter(b => b.key.startsWith(yesterdayISO));

      const qStats = await Promise.all(blobs.map(async blob => {
        const res = await fetch(
          `https://api.netlify.com/api/v1/blobs/${SITE_ID}/quiz-stats/${blob.key}`,
          { headers: authHeader }
        );
        if (!res.ok) return null;
        const data = await res.json();
        const parts = blob.key.split('-');
        const index = parts.length === 4 ? parseInt(parts[3]) : 0;
        return { index, total: data.total || 0, correctCount: data.correctCount || 0 };
      }));

      const valid = qStats.filter(Boolean).sort((a, b) => a.index - b.index);
      yesterdayPlayers = valid.length > 0 ? Math.max(...valid.map(q => q.total)) : 0;
      yesterdayAnswers = valid.reduce((s, q) => s + q.total, 0);
      yesterdayCorrect = valid.reduce((s, q) => s + q.correctCount, 0);
      yesterdayQuestions = valid;
    }

    const yesterdayAvgPct = yesterdayAnswers > 0
      ? Math.round((yesterdayCorrect / yesterdayAnswers) * 100) : 0;

    // ── Fetch yesterday's daily shares ──
    let dailyShares = 0;
    const shareRes = await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/quiz-shares/daily-${yesterdayISO}`,
      { headers: authHeader }
    );
    if (shareRes.ok) {
      const shareData = await shareRes.json();
      dailyShares = shareData.count || 0;
    }

    // ── Fetch all-time totals ──
    let allTimePlayers = 0;
    let allTimeAnswers = 0;
    let allTimeCorrect = 0;
    let activeDays = 0;

    const allListRes = await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/quiz-stats`,
      { headers: authHeader }
    );
    if (allListRes.ok) {
      const allListData = await allListRes.json();
      const allBlobs = allListData.blobs || [];

      const allStats = await Promise.all(allBlobs.map(async blob => {
        const res = await fetch(
          `https://api.netlify.com/api/v1/blobs/${SITE_ID}/quiz-stats/${blob.key}`,
          { headers: authHeader }
        );
        if (!res.ok) return null;
        const data = await res.json();
        const parts = blob.key.split('-');
        const date = parts.slice(0, 3).join('-');
        return { date, total: data.total || 0, correctCount: data.correctCount || 0 };
      }));

      // Group by date for player count
      const byDate = {};
      allStats.filter(Boolean).forEach(r => {
        if (!byDate[r.date]) byDate[r.date] = [];
        byDate[r.date].push(r);
      });

      activeDays = Object.keys(byDate).length;
      Object.values(byDate).forEach(qs => {
        allTimePlayers += Math.max(...qs.map(q => q.total));
        allTimeAnswers += qs.reduce((s, q) => s + q.total, 0);
        allTimeCorrect += qs.reduce((s, q) => s + q.correctCount, 0);
      });
    }

    const allTimeAvgPct = allTimeAnswers > 0
      ? Math.round((allTimeCorrect / allTimeAnswers) * 100) : 0;

    // ── Fetch weekly shares total ──
    let weeklySharesTotal = 0;
    const wShareListRes = await fetch(
      `https://api.netlify.com/api/v1/blobs/${SITE_ID}/quiz-shares`,
      { headers: authHeader }
    );
    if (wShareListRes.ok) {
      const wListData = await wShareListRes.json();
      const wBlobs = (wListData.blobs || []).filter(b => b.key.startsWith('weekly-'));
      const wCounts = await Promise.all(wBlobs.map(async blob => {
        const res = await fetch(
          `https://api.netlify.com/api/v1/blobs/${SITE_ID}/quiz-shares/${blob.key}`,
          { headers: authHeader }
        );
        if (!res.ok) return 0;
        const data = await res.json();
        return data.count || 0;
      }));
      weeklySharesTotal = wCounts.reduce((a, b) => a + b, 0);
    }

    // ── Build per-question rows ──
    const qRows = yesterdayQuestions.map((q, i) => {
      const pct = q.total > 0 ? Math.round((q.correctCount / q.total) * 100) : 0;
      const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
      return `
        <tr>
          <td style="padding:8px 12px;color:#6b6b6b;font-size:13px;">Q${i + 1}</td>
          <td style="padding:8px 12px;font-size:13px;color:#1a1a1a;">${q.total} answers</td>
          <td style="padding:8px 12px;font-family:monospace;font-size:12px;color:#4a7c59;">${bar}</td>
          <td style="padding:8px 12px;font-size:13px;font-weight:600;color:${pct >= 60 ? '#4a7c59' : pct >= 40 ? '#c08030' : '#c0622e'}">${pct}%</td>
        </tr>
      `;
    }).join('');

    // ── Build HTML email ──
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="background:#faf9f7;font-family:'DM Sans',system-ui,sans-serif;margin:0;padding:40px 24px;">
  <div style="max-width:560px;margin:0 auto;">

    <div style="margin-bottom:32px;">
      <div style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#1a1a1a;margin-bottom:4px;">Pub Quiz Daily</div>
      <div style="font-size:13px;color:#6b6b6b;">Daily report — ${yesterdayLabel}</div>
    </div>

    <div style="background:white;border:1px solid #e0ddd8;border-radius:12px;padding:24px;margin-bottom:20px;">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#6b6b6b;margin-bottom:16px;">Yesterday</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px;">
        <div style="text-align:center;">
          <div style="font-size:28px;font-weight:600;color:#1a1a1a;">${yesterdayPlayers}</div>
          <div style="font-size:11px;color:#6b6b6b;text-transform:uppercase;letter-spacing:0.06em;">Players</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:28px;font-weight:600;color:#1a1a1a;">${yesterdayAvgPct}%</div>
          <div style="font-size:11px;color:#6b6b6b;text-transform:uppercase;letter-spacing:0.06em;">Avg correct</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:28px;font-weight:600;color:#1a1a1a;">${dailyShares}</div>
          <div style="font-size:11px;color:#6b6b6b;text-transform:uppercase;letter-spacing:0.06em;">Shares</div>
        </div>
      </div>
      ${yesterdayQuestions.length > 0 ? `
      <table style="width:100%;border-collapse:collapse;border-top:1px solid #e0ddd8;">
        <tr style="border-bottom:1px solid #e0ddd8;">
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b6b6b;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">#</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b6b6b;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Answers</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b6b6b;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Distribution</th>
          <th style="padding:8px 12px;text-align:left;font-size:11px;color:#6b6b6b;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;">Correct</th>
        </tr>
        ${qRows}
      </table>` : ''}
    </div>

    <div style="background:white;border:1px solid #e0ddd8;border-radius:12px;padding:24px;margin-bottom:20px;">
      <div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:#6b6b6b;margin-bottom:16px;">All time</div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;">
        <div style="text-align:center;">
          <div style="font-size:22px;font-weight:600;color:#1a1a1a;">${allTimePlayers.toLocaleString()}</div>
          <div style="font-size:11px;color:#6b6b6b;text-transform:uppercase;letter-spacing:0.06em;">Players</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:22px;font-weight:600;color:#1a1a1a;">${activeDays}</div>
          <div style="font-size:11px;color:#6b6b6b;text-transform:uppercase;letter-spacing:0.06em;">Active days</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:22px;font-weight:600;color:#1a1a1a;">${allTimeAvgPct}%</div>
          <div style="font-size:11px;color:#6b6b6b;text-transform:uppercase;letter-spacing:0.06em;">Avg correct</div>
        </div>
        <div style="text-align:center;">
          <div style="font-size:22px;font-weight:600;color:#1a1a1a;">${weeklySharesTotal}</div>
          <div style="font-size:11px;color:#6b6b6b;text-transform:uppercase;letter-spacing:0.06em;">Weekly shares</div>
        </div>
      </div>
    </div>

    <div style="text-align:center;margin-top:24px;">
      <a href="https://pubquizdaily.com/stats.html" style="font-size:13px;color:#6b6b6b;text-decoration:none;">View full stats dashboard →</a>
    </div>

    <div style="margin-top:32px;font-size:11px;color:#c8c8c8;text-align:center;">
      Pub Quiz Daily · pubquizdaily.com
    </div>

  </div>
</body>
</html>`;

    // ── Send via Resend ──
    const sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Pub Quiz Daily <hello@pubquizdaily.com>',
        to: [REPORT_EMAIL],
        subject: `PQD Daily — ${yesterdayPlayers} players · ${yesterdayAvgPct}% correct · ${yesterdayLabel}`,
        html,
      }),
    });

    if (!sendRes.ok) {
      const err = await sendRes.text();
      console.error('Resend error:', err);
      return { statusCode: 500, body: 'Email send failed' };
    }

    console.log(`Daily report sent for ${yesterdayISO}`);
    return { statusCode: 200, body: 'OK' };

  } catch (e) {
    console.error('Daily report error:', e);
    return { statusCode: 500, body: 'Internal error' };
  }
};
