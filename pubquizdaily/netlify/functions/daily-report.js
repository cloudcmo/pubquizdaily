// netlify/functions/daily-report.js
// THE daily email: one report covering all seven games — Pub Quiz Daily,
// Whenly, What Word, Groupie, Twentee, Spellbound and Guffinoes. Replaces the separate
// PQD and Whenly reports (Whenly's own schedule is switched off in its
// netlify.toml).
// Scheduled here at 5am UTC daily; sends via Resend.
//
// Sources, all best-effort (a game that can't be reached shows a dash,
// never blocks the email):
//   PQD      — this site's Netlify blobs (quiz-stats / quiz-shares)
//   Whenly   — the Whenly site's blobs, via WHENLY_SITE_ID + the same API token
//   WhatWord — GET {WHATWORD_URL}/api/stats?date= with WHATWORD_ADMIN_TOKEN
//   Groupie  — GET {GROUPIE_URL}/api/stats?date= with GROUPIE_ADMIN_TOKEN
//   Twentee  — GET {TWENTEE_URL}/api/stats?date= with TWENTEE_ADMIN_TOKEN
//   Spellbound — GET {SPELLBOUND_URL}/api/stats?date= with SPELLBOUND_ADMIN_TOKEN
//   Guffinoes — GET {GUFFINOES_URL}/api/stats?date= with GUFFINOES_ADMIN_TOKEN
//   Sources  — GET {GROUPIE_URL}/api/sources?date= (public aggregates from the
//              guff-bar visit pings: visitors, finishers, and how many the
//              Friday email brought, per game)
//   Weekly   — this site's blob quiz-stats/weekly-{date}-play (Best-of plays)

const WHATWORD_URL = process.env.WHATWORD_URL || 'https://what-word.carl-b82.workers.dev';
const GROUPIE_URL  = process.env.GROUPIE_URL  || 'https://groupie.fun';
const TWENTEE_URL  = process.env.TWENTEE_URL  || 'https://twentee.co.uk';
const SPELLBOUND_URL = process.env.SPELLBOUND_URL || 'https://spellbounddaily.co.uk';
const GUFFINOES_URL = process.env.GUFFINOES_URL || 'https://guffinoes.carlosfandango.net';

exports.handler = async function(event) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  const REPORT_EMAIL   = process.env.DAILY_REPORT_EMAIL;
  const SITE_ID        = process.env.NETLIFY_SITE_ID;
  const TOKEN          = process.env.NETLIFY_API_TOKEN;

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
    // ── Deduplication check — bail if already sent today ──
    const sentKey = `report-sent-${yesterdayISO}`;
    const sentUrl = `https://api.netlify.com/api/v1/blobs/${SITE_ID}/quiz-meta/${sentKey}`;
    const alreadySent = await fetch(sentUrl, { headers: authHeader });
    if (alreadySent.ok) {
      console.log(`Report already sent for ${yesterdayISO} — skipping`);
      return { statusCode: 200, body: 'Already sent' };
    }
    await fetch(sentUrl, {
      method: 'PUT',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sent: true, sentAt: new Date().toISOString() }),
    });

    // ── Gather all seven games in parallel, each best-effort ──
    const [pqd, whenly, whatword, groupie, twentee, spellbound, guffinoes] = await Promise.all([
      fetchPqd(SITE_ID, authHeader, yesterdayISO).catch(e => { console.error('PQD stats failed:', e.message); return null; }),
      fetchWhenly(authHeader, yesterdayISO).catch(e => { console.error('Whenly stats failed:', e.message); return null; }),
      fetchWorkerStats(WHATWORD_URL, process.env.WHATWORD_ADMIN_TOKEN, yesterdayISO).catch(e => { console.error('What Word stats failed:', e.message); return null; }),
      fetchWorkerStats(GROUPIE_URL, process.env.GROUPIE_ADMIN_TOKEN, yesterdayISO).catch(e => { console.error('Groupie stats failed:', e.message); return null; }),
      fetchWorkerStats(TWENTEE_URL, process.env.TWENTEE_ADMIN_TOKEN, yesterdayISO).catch(e => { console.error('Twentee stats failed:', e.message); return null; }),
      fetchWorkerStats(SPELLBOUND_URL, process.env.SPELLBOUND_ADMIN_TOKEN, yesterdayISO).catch(e => { console.error('Spellbound stats failed:', e.message); return null; }),
      fetchWorkerStats(GUFFINOES_URL, process.env.GUFFINOES_ADMIN_TOKEN, yesterdayISO).catch(e => { console.error('Guffinoes stats failed:', e.message); return null; }),
    ]);

    // Where they came from, and the weekly Best-of (which the email links to).
    const [sources, weekly] = await Promise.all([
      fetchSources(GROUPIE_URL, yesterdayISO).catch(e => { console.error('Sources failed:', e.message); return null; }),
      fetchWeeklyPlays(SITE_ID, authHeader, yesterdayISO).catch(e => { console.error('Weekly plays failed:', e.message); return null; }),
    ]);

    const html = buildHtml({ yesterdayLabel, pqd, whenly, whatword, groupie, twentee, spellbound, guffinoes, sources, weekly });

    const n = v => (v && typeof v.players === 'number') ? v.players : '—';
    const fromEmail = emailTotals(sources);
    const emailBit = fromEmail ? ` · Email ${fromEmail.visits}→${fromEmail.completed}` : '';
    const subject = `Games — PQD ${n(pqd)} · Whenly ${n(whenly)} · WhatWord ${n(whatword)} · Groupie ${n(groupie)} · Twentee ${n(twentee)} · Spellbound ${n(spellbound)} · Guffinoes ${n(guffinoes)}${emailBit} · ${yesterdayLabel}`;

    const sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Pub Quiz Daily <hello@pubquizdaily.com>',
        to: [REPORT_EMAIL],
        subject,
        html,
      }),
    });

    if (!sendRes.ok) {
      const err = await sendRes.text();
      console.error('Resend error:', err);
      return { statusCode: 500, body: 'Email send failed' };
    }

    console.log(`Combined daily report sent for ${yesterdayISO}`);
    return { statusCode: 200, body: 'OK' };

  } catch (e) {
    console.error('Daily report error:', e);
    return { statusCode: 500, body: 'Internal error' };
  }
};

// ── Pub Quiz Daily: this site's blobs ────────────────────────────────────────

async function fetchPqd(siteId, authHeader, dayISO) {
  const listRes = await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/quiz-stats`, { headers: authHeader });
  if (!listRes.ok) throw new Error(`blob list ${listRes.status}`);
  const blobs = ((await listRes.json()).blobs || []).filter(b => b.key.startsWith(dayISO));

  const qStats = (await Promise.all(blobs.map(async blob => {
    const res = await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/quiz-stats/${blob.key}`, { headers: authHeader });
    if (!res.ok) return null;
    const data = await res.json();
    const parts = blob.key.split('-');
    const index = parts.length === 4 ? parseInt(parts[3]) : 0;
    return { index, total: data.total || 0, correctCount: data.correctCount || 0 };
  }))).filter(Boolean).sort((a, b) => a.index - b.index);

  const answers = qStats.reduce((s, q) => s + q.total, 0);
  const correct = qStats.reduce((s, q) => s + q.correctCount, 0);

  let shares = 0;
  const shareRes = await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/quiz-shares/daily-${dayISO}`, { headers: authHeader });
  if (shareRes.ok) shares = (await shareRes.json()).count || 0;

  return {
    players: qStats.length ? Math.max(...qStats.map(q => q.total)) : 0,
    avgPct: answers ? Math.round((correct / answers) * 100) : null,
    shares,
    questions: qStats,
  };
}

// ── Whenly: the Whenly site's blobs, same Netlify account token ─────────────

async function fetchWhenly(authHeader, dayISO) {
  const whenlySite = process.env.WHENLY_SITE_ID;
  if (!whenlySite) throw new Error('WHENLY_SITE_ID not set');

  const listRes = await fetch(`https://api.netlify.com/api/v1/blobs/${whenlySite}/whenly-stats`, { headers: authHeader });
  if (!listRes.ok) throw new Error(`blob list ${listRes.status}`);
  const blobs = ((await listRes.json()).blobs || []).filter(b => b.key.startsWith(dayISO));

  const qStats = (await Promise.all(blobs.map(async blob => {
    const res = await fetch(`https://api.netlify.com/api/v1/blobs/${whenlySite}/whenly-stats/${blob.key}`, { headers: authHeader });
    if (!res.ok) return null;
    const data = await res.json();
    return {
      total: data.total || 0,
      totalDiff: data.totalDiff || 0,
      perfectCount: data.perfectCount || 0,
    };
  }))).filter(Boolean);

  const answers = qStats.reduce((s, q) => s + q.total, 0);
  const totalDiff = qStats.reduce((s, q) => s + q.totalDiff, 0);
  const avgDiff = answers ? Math.round(totalDiff / answers) : null;

  let shares = 0;
  const shareRes = await fetch(`https://api.netlify.com/api/v1/blobs/${whenlySite}/whenly-shares/daily-${dayISO}`, { headers: authHeader });
  if (shareRes.ok) shares = (await shareRes.json()).count || 0;

  return {
    players: qStats.length ? Math.max(...qStats.map(q => q.total)) : 0,
    avgScore: avgDiff === null ? null : Math.max(0, 50 - avgDiff),
    perfects: qStats.reduce((s, q) => s + (q.perfectCount || 0), 0),
    shares,
  };
}

// ── What Word & Groupie: their Workers' /api/stats, admin-gated ─────────────

async function fetchWorkerStats(baseUrl, adminToken, dayISO) {
  if (!adminToken) throw new Error('admin token not set');
  const res = await fetch(`${baseUrl}/api/stats?date=${dayISO}`, {
    headers: { 'Authorization': `Bearer ${adminToken}` },
  });
  if (!res.ok) throw new Error(`stats API ${res.status}`);
  return await res.json();
}

// ── Sources: the guff-bar visit pings, aggregated by groupie ─────────────────
// { date, games: { pqd: { visits, completed, refs: { friday: { visits, completed } } }, … } }

async function fetchSources(baseUrl, dayISO) {
  const res = await fetch(`${baseUrl}/api/sources?date=${dayISO}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

const EMAIL_REF = 'friday';
const SOURCE_GAMES = [
  ['pqd', 'Pub Quiz'], ['whenly', 'Whenly'], ['whatword', 'What Word'],
  ['groupie', 'Groupie'], ['twentee', 'Twentee'], ['spellbound', 'Spellbound'],
  ['guffinoes', 'Guffinoes'],
];

// Totals across the games of what the email brought. Plays, not people:
// one person playing three games counts three times.
function emailTotals(sources) {
  if (!sources || !sources.games) return null;
  let visits = 0, completed = 0;
  for (const [key] of SOURCE_GAMES) {
    const r = sources.games[key] && sources.games[key].refs && sources.games[key].refs[EMAIL_REF];
    if (r) { visits += r.visits || 0; completed += r.completed || 0; }
  }
  return { visits, completed };
}

// ── Weekly Best-of plays: blob written by weekly.html at the final panel ─────

async function fetchWeeklyPlays(siteId, authHeader, dayISO) {
  const res = await fetch(`https://api.netlify.com/api/v1/blobs/${siteId}/quiz-stats/weekly-${dayISO}-play`, { headers: authHeader });
  if (res.status === 404) return { plays: 0, fullMarks: 0 };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return { plays: data.total || 0, fullMarks: data.correctCount || 0 };
}

// ── HTML ─────────────────────────────────────────────────────────────────────

function tile(value, label, size) {
  const fs = size === 'big' ? 28 : 20;
  const v = (value === null || value === undefined) ? '—' : value;
  return `
    <td align="center" style="padding:4px 6px;">
      <div style="font-size:${fs}px;font-weight:600;color:#1a1a1a;line-height:1.1;">${v}</div>
      <div style="font-size:10px;color:#6b6b6b;text-transform:uppercase;letter-spacing:0.06em;margin-top:4px;">${label}</div>
    </td>`;
}

function gameCard(name, accent, url, tiles, extraHtml) {
  return `
    <div style="background:white;border:1px solid #e0ddd8;border-left:4px solid ${accent};border-radius:12px;padding:20px 24px;margin-bottom:14px;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${accent};margin-bottom:12px;">
        ${name} <span style="font-weight:400;color:#b3aea6;">· ${url.replace(/^https?:\/\//, '')}</span>
      </div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${tiles}</tr></table>
      ${extraHtml || ''}
    </div>`;
}

function buildHtml({ yesterdayLabel, pqd, whenly, whatword, groupie, twentee, spellbound, guffinoes, sources, weekly }) {
  const p = v => (v && typeof v.players === 'number') ? v.players : null;

  // Summary strip: the six player counts side by side.
  const summary = `
    <div style="background:#1a1a1a;border-radius:12px;padding:20px 12px;margin-bottom:18px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
        ${[['PQD', p(pqd), '#4a7c59'], ['Whenly', p(whenly), '#c9772f'], ['What Word', p(whatword), '#ff48b0'], ['Groupie', p(groupie), '#00c2cc'], ['Twentee', p(twentee), '#ff9f1c'], ['Spellbound', p(spellbound), '#7f9dff'], ['Guffinoes', p(guffinoes), '#b8912f']].map(([label, val, colour]) => `
          <td align="center" style="padding:0 6px;">
            <div style="font-size:26px;font-weight:700;color:#ffffff;line-height:1.1;">${val === null ? '—' : val}</div>
            <div style="font-size:10px;color:${colour};text-transform:uppercase;letter-spacing:0.08em;margin-top:5px;font-weight:700;">${label}</div>
          </td>`).join('')}
      </tr></table>
      <div style="text-align:center;font-size:10px;color:#8a857d;margin-top:10px;letter-spacing:0.06em;">PLAYERS YESTERDAY</div>
    </div>`;

  // Where they came from: visitors vs finishers per game, and the email's share.
  // "Visitors" is anyone whose browser loaded a game page (the guff-bar's
  // arrival ping), so this is the only place bounces show up.
  const srcRows = SOURCE_GAMES.map(([key, label]) => {
    const g = sources && sources.games && sources.games[key];
    const e = g && g.refs && g.refs[EMAIL_REF];
    const cell = v => (v === null || v === undefined) ? '—' : v;
    const emailCell = e ? `${e.visits} → ${e.completed}` : (g ? '0' : '—');
    return `<tr>
      <td style="padding:6px 10px;font-size:12px;color:#1a1a1a;">${label}</td>
      <td align="right" style="padding:6px 10px;font-size:12px;color:#1a1a1a;">${cell(g && g.visits)}</td>
      <td align="right" style="padding:6px 10px;font-size:12px;color:#1a1a1a;">${cell(g && g.completed)}</td>
      <td align="right" style="padding:6px 10px;font-size:12px;font-weight:600;color:${e && e.completed ? '#4a7c59' : '#6b6b6b'};">${emailCell}</td>
    </tr>`;
  }).join('');
  const weeklyLine = weekly
    ? `<div style="font-size:12px;color:#6b6b6b;margin-top:12px;">Weekly Best-of (where the email's big button goes): <strong style="color:#1a1a1a;">${weekly.plays}</strong> play${weekly.plays === 1 ? '' : 's'}, ${weekly.fullMarks} full marks</div>`
    : `<div style="font-size:12px;color:#6b6b6b;margin-top:12px;">Weekly Best-of: unreachable</div>`;
  const sourcesCard = `
    <div style="background:white;border:1px solid #e0ddd8;border-left:4px solid #1a1a1a;border-radius:12px;padding:20px 24px;margin-bottom:14px;">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#1a1a1a;margin-bottom:12px;">
        Where they came from <span style="font-weight:400;color:#b3aea6;">· visitors vs finishers</span>
      </div>
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding:4px 10px;font-size:10px;color:#6b6b6b;text-transform:uppercase;letter-spacing:0.06em;">Game</td>
          <td align="right" style="padding:4px 10px;font-size:10px;color:#6b6b6b;text-transform:uppercase;letter-spacing:0.06em;">Visited</td>
          <td align="right" style="padding:4px 10px;font-size:10px;color:#6b6b6b;text-transform:uppercase;letter-spacing:0.06em;">Finished</td>
          <td align="right" style="padding:4px 10px;font-size:10px;color:#6b6b6b;text-transform:uppercase;letter-spacing:0.06em;">From the email</td>
        </tr>
        ${srcRows}
      </table>
      ${weeklyLine}
      ${sources ? '' : '<div style="font-size:11px;color:#c0622e;margin-top:8px;">Sources API unreachable — groupie.fun/api/sources</div>'}
    </div>`;

  // PQD card, with its per-question table when available.
  const qRows = (pqd && pqd.questions || []).map((q, i) => {
    const pct = q.total > 0 ? Math.round((q.correctCount / q.total) * 100) : 0;
    const bar = '█'.repeat(Math.round(pct / 10)) + '░'.repeat(10 - Math.round(pct / 10));
    return `<tr>
      <td style="padding:6px 10px;color:#6b6b6b;font-size:12px;">Q${i + 1}</td>
      <td style="padding:6px 10px;font-size:12px;color:#1a1a1a;">${q.total}</td>
      <td style="padding:6px 10px;font-family:monospace;font-size:11px;color:#4a7c59;">${bar}</td>
      <td style="padding:6px 10px;font-size:12px;font-weight:600;color:${pct >= 60 ? '#4a7c59' : pct >= 40 ? '#c08030' : '#c0622e'}">${pct}%</td>
    </tr>`;
  }).join('');
  const pqdTable = qRows ? `
    <table style="width:100%;border-collapse:collapse;border-top:1px solid #f0ede8;margin-top:14px;">${qRows}</table>` : '';

  const pqdCard = pqd
    ? gameCard('Pub Quiz Daily', '#4a7c59', 'pubquizdaily.com',
        tile(pqd.players, 'players', 'big') + tile(pqd.avgPct === null ? null : pqd.avgPct + '%', 'avg correct') + tile(pqd.shares, 'shares'), pqdTable)
    : gameCard('Pub Quiz Daily', '#4a7c59', 'pubquizdaily.com', tile(null, 'unreachable', 'big'));

  const whenlyCard = whenly
    ? gameCard('Whenly', '#c9772f', 'whenly.co.uk',
        tile(whenly.players, 'players', 'big') + tile(whenly.avgScore === null ? null : whenly.avgScore + '/50', 'avg score') + tile(whenly.perfects, '🎯 perfects') + tile(whenly.shares, 'shares'))
    : gameCard('Whenly', '#c9772f', 'whenly.co.uk', tile(null, 'unreachable', 'big'));

  const wwCard = whatword
    ? gameCard('What Word', '#ff48b0', 'what-word',
        tile(whatword.players, 'players', 'big') + tile(whatword.avgScore === null ? null : whatword.avgScore + '/3', 'avg score') + tile(whatword.allTime ? whatword.allTime.players : null, 'all-time plays'))
    : gameCard('What Word', '#ff48b0', 'what-word', tile(null, 'unreachable', 'big'));

  const groupieCard = groupie
    ? gameCard('Groupie', '#00c2cc', 'groupie.fun',
        tile(groupie.players, 'players', 'big') + tile(groupie.solveRate === null || groupie.solveRate === undefined ? null : groupie.solveRate + '%', 'solved it') + tile(groupie.avgMistakes ?? null, 'avg slips') + tile(groupie.allTime ? groupie.allTime.players : null, 'all-time plays'))
    : gameCard('Groupie', '#00c2cc', 'groupie.fun', tile(null, 'unreachable', 'big'));

  const twenteeCard = twentee
    ? gameCard('Twentee', '#ff9f1c', 'twentee.co.uk',
        tile(twentee.players, 'players', 'big') + tile(twentee.winRate === null || twentee.winRate === undefined ? null : twentee.winRate + '%', 'got it') + tile(twentee.avgSpent ?? null, 'avg questions') + tile(twentee.allTime ? twentee.allTime.players : null, 'all-time plays'))
    : gameCard('Twentee', '#ff9f1c', 'twentee.co.uk', tile(null, 'unreachable', 'big'));

  const spellboundCard = spellbound
    ? gameCard('Spellbound', '#2563c9', 'spellbounddaily.co.uk',
        tile(spellbound.players, 'players', 'big') + tile(spellbound.completionRate === null || spellbound.completionRate === undefined ? null : spellbound.completionRate + '%', 'cleared the day') + tile(spellbound.avgWords ?? null, 'avg words') + tile(spellbound.allTime ? spellbound.allTime.players : null, 'all-time plays'))
    : gameCard('Spellbound', '#2563c9', 'spellbounddaily.co.uk', tile(null, 'unreachable', 'big'));

  // Guffinoes reports dominoes down and points, not a word count — the day is
  // "how much of the bag went down", so that is the rate worth watching.
  const guffinoesCard = guffinoes
    ? gameCard('Guffinoes', '#3f4a41', 'guffinoes.carlosfandango.net',
        tile(guffinoes.players, 'players', 'big') + tile(guffinoes.completionRate === null || guffinoes.completionRate === undefined ? null : guffinoes.completionRate + '%', 'laid all twelve') + tile(guffinoes.avgDown ?? null, 'avg down') + tile(guffinoes.avgScore ?? null, 'avg score'))
    : gameCard('Guffinoes', '#3f4a41', 'guffinoes.carlosfandango.net', tile(null, 'unreachable', 'big'));

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="background:#faf9f7;font-family:'DM Sans',system-ui,sans-serif;margin:0;padding:40px 24px;">
  <div style="max-width:560px;margin:0 auto;">

    <div style="margin-bottom:24px;">
      <div style="font-family:Georgia,serif;font-size:22px;font-weight:700;color:#1a1a1a;margin-bottom:4px;">The Games</div>
      <div style="font-size:13px;color:#6b6b6b;">Daily report, all seven — ${yesterdayLabel}</div>
    </div>

    ${summary}
    ${sourcesCard}
    ${pqdCard}
    ${whenlyCard}
    ${wwCard}
    ${groupieCard}
    ${twenteeCard}
    ${spellboundCard}
    ${guffinoesCard}

    <div style="text-align:center;margin-top:20px;">
      <a href="https://pubquizdaily.com/stats.html" style="font-size:13px;color:#6b6b6b;text-decoration:none;">PQD stats dashboard →</a>
    </div>

    <div style="margin-top:28px;font-size:11px;color:#c8c8c8;text-align:center;">
      Pub Quiz Daily · Whenly · What Word · Groupie · Twentee · Spellbound · Guffinoes — one report, sent via pubquizdaily.com
    </div>

  </div>
</body>
</html>`;
}

module.exports.buildHtml = buildHtml;
