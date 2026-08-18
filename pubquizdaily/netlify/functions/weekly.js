// netlify/functions/weekly.js
// Fetches questions flagged with 'W' in column I from the past 7 days
// Sheet columns: date | question | A | B | C | D | correct | explainer | weekly

const { fetchSheetRows } = require('../lib/sheet');
const { loadPickSet, pickKey } = require('../lib/weekly-picks');

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'public, max-age=300',
  };

  const SHEET_ID = process.env.GOOGLE_SHEET_ID;

  if (!SHEET_ID) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Missing environment variables' }) };
  }

  try {
    const rows = await fetchSheetRows(SHEET_ID, 'multi');
    // A question counts as this week's Best-of if the sheet says so (a "W"
    // typed in by hand or by scripts/assign-weekly.js) or if the weekly
    // auto-select picked it. Auto-picks used to be written back into the
    // sheet, which needed a Google service account; they now live in a
    // Netlify blob instead. See netlify/lib/weekly-picks.js.
    const autoPicks = await loadPickSet();

    // Build the set of valid dates: past 7 days (not including today)
    const validDates = new Set();
    const today = new Date();
    for (let i = 1; i <= 7; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      validDates.add(d.toISOString().slice(0, 10));
    }

    // Filter rows: must be in past 7 days AND have W in weekly column
    const questions = rows.slice(1).reduce((acc, row, rowIndex) => {
      const cellDate = (row[0] || '').trim();
      const isoDate = parseFlexDate(cellDate) || cellDate;
      const isWeekly = (row[8] || '').trim().toUpperCase() === 'W'
        || autoPicks.has(pickKey(isoDate, row[1]));

      if (!validDates.has(isoDate) || !isWeekly) return acc;

      const [, question, optA, optB, optC, optD, correct, explainer, , image] = row;
      if (!question || !optA || !optB || !optC || !optD || !correct) return acc;

      acc.push({
        date: isoDate,
        index: rowIndex,
        question: question.trim(),
        options: [optA.trim(), optB.trim(), optC.trim(), optD.trim()],
        correct: correct.trim().toUpperCase(),
        explainer: explainer ? explainer.trim() : null,
        image: image ? image.trim() : null,
      });

      return acc;
    }, []);

    // Sort oldest first so the quiz runs chronologically
    questions.sort((a, b) => a.date.localeCompare(b.date));

    if (questions.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No weekly questions found' }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ questions }),
    };

  } catch (err) {
    console.error('Weekly function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal error' }) };
  }
};

function parseFlexDate(str) {
  if (!str) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return '';
}
