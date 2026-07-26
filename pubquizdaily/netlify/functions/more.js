// netlify/functions/more.js
//
// Powers the "Give me another" endless bonus round on the daily and weekly
// pages. Returns a pool of PAST quiz questions the player can keep answering
// for fun after they've finished the real quiz.
//
// Sheet columns: date | question | A | B | C | D | correct | explainer | weekly | image
//
// Rules:
//   • Only rows dated STRICTLY BEFORE today are included — so upcoming, not-yet-
//     published questions can never leak out as a "bonus" (no spoilers).
//   • Only complete rows (question + four options + a correct letter).
//   • Images are served as stored, the same way archive.js already exposes the
//     full question history publicly. If you'd rather the endless round only
//     ever show copyright-safe Pexels images, flip PEXELS_IMAGES_ONLY to true
//     below and non-Pexels images will be dropped (the question still plays,
//     just without a picture).
//
// The response is a stable list (not pre-shuffled) so it can be cached; the
// front-end shuffles client-side and serves them one at a time.

const PEXELS_IMAGES_ONLY = false;
const MAX_POOL = 800; // safety cap on payload size

exports.handler = async function () {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300',
  };

  const SHEET_ID = process.env.GOOGLE_SHEET_ID;
  const API_KEY = process.env.GOOGLE_API_KEY;
  if (!SHEET_ID || !API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing environment variables' }) };
  }

  try {
    const range = encodeURIComponent('multi!A:J');
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${range}?key=${API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error('Sheets API error:', await res.text());
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Failed to fetch sheet' }) };
    }

    const data = await res.json();
    const rows = data.values || [];
    const today = new Date().toISOString().slice(0, 10);

    const questions = [];
    for (const row of rows.slice(1)) {
      const [date, question, optA, optB, optC, optD, correct, explainer, , image] = row;
      if (!question || !optA || !optB || !optC || !optD || !correct) continue;

      const iso = parseFlexDate((date || '').trim());
      if (!iso || iso >= today) continue; // past dates only — no spoilers

      let img = image ? image.trim() : null;
      if (img && PEXELS_IMAGES_ONLY && !/pexels\.com/i.test(img)) img = null;

      questions.push({
        question: question.trim(),
        options: [optA.trim(), optB.trim(), optC.trim(), optD.trim()],
        correct: correct.trim().toUpperCase(),
        explainer: explainer ? explainer.trim() : null,
        image: img,
      });
      if (questions.length >= MAX_POOL) break;
    }

    return { statusCode: 200, headers, body: JSON.stringify({ count: questions.length, questions }) };
  } catch (err) {
    console.error('more.js error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};

function parseFlexDate(str) {
  if (!str) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}
