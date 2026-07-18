// netlify/functions/archive.js
// Groups every question in the sheet into calendar weeks (Monday–Sunday)
// and returns the questions marked 'W' in column I — the same weekly
// round-up picks used by weekly.js, just for every past week instead of
// only the last 7 days.
//
// GET /archive              -> lightweight list of every week (no question
//                               content, just counts) — used by archive.html
// GET /archive?week=YYYY-MM-DD -> full question detail for one week —
//                               used by archive-week.html to actually play it
//
// Weeks with no 'W' rows yet simply don't appear. Run
// scripts/assign-weekly.js to backfill a consistent round-up for every
// historical week.
//
// Unlike question.js, this has no retention/cutoff window — the whole
// point of the Archive page is browsing the full history, which is safe
// now that images are sourced from copyright-free Pexels photos rather
// than ad-hoc internet images.

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300',
  };

  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  const API_KEY  = process.env.GOOGLE_API_KEY;
  const weekParam = event.queryStringParameters?.week || null;

  if (!SHEET_ID || !API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing environment variables' }) };
  }

  try {
    const range = encodeURIComponent('multi!A:J');
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?key=${API_KEY}`;

    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.text();
      console.error('Sheets API error:', err);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Failed to fetch sheet' }) };
    }

    const data = await res.json();
    const rows = data.values || [];

    const weeksMap = new Map(); // weekStart -> questions[]

    rows.slice(1).forEach((row, rowIndex) => {
      const [date, question, optA, optB, optC, optD, correct, explainer, weekly, image] = row;

      const isW = (weekly || '').trim().toUpperCase() === 'W';
      if (!isW) return;
      if (!question || !optA || !optB || !optC || !optD || !correct) return;

      const isoDate = parseFlexDate((date || '').trim());
      const weekStart = isoDate ? getWeekStart(isoDate) : null;
      if (!weekStart) return;

      if (!weeksMap.has(weekStart)) weeksMap.set(weekStart, []);
      weeksMap.get(weekStart).push({
        date: isoDate,
        index: rowIndex,
        question: question.trim(),
        options: [optA.trim(), optB.trim(), optC.trim(), optD.trim()],
        correct: correct.trim().toUpperCase(),
        explainer: explainer ? explainer.trim() : null,
        image: image ? image.trim() : null,
      });
    });

    // Single-week detail — full question content for archive-week.html
    if (weekParam) {
      const questions = weeksMap.get(weekParam);
      if (!questions) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'No questions for this week' }) };
      }
      questions.sort((a, b) => a.date.localeCompare(b.date));
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ weekStart: weekParam, weekEnd: addDays(weekParam, 6), questions }),
      };
    }

    // Index listing — lightweight, no question content, just used to
    // render the list of weeks on archive.html.
    const weeks = Array.from(weeksMap.entries())
      .map(([weekStart, questions]) => ({
        weekStart,
        weekEnd: addDays(weekStart, 6),
        count: questions.length,
      }))
      .sort((a, b) => b.weekStart.localeCompare(a.weekStart)); // most recent first

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ weeks }),
    };

  } catch (err) {
    console.error('Archive function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};

// Monday of the ISO week containing this date, as YYYY-MM-DD.
function getWeekStart(isoDate) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function addDays(isoDate, n) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function parseFlexDate(str) {
  if (!str) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return '';
}
