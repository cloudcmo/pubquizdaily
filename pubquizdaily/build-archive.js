#!/usr/bin/env node
/**
 * build-archive.js — Pub Quiz Daily static archive generator
 * ---------------------------------------------------------------------------
 * Generates SEO-friendly static pages so the questions become real, crawlable
 * HTML content (currently the archive is empty to Google — it's all fetched
 * client-side at runtime).
 *
 * Output (into the site publish dir, default ./):
 *   /quiz/week-YYYY-MM-DD.html   one page per week, dated by that week's FRIDAY
 *   /archive.html                regenerated, linking to the real weekly pages
 *   /sitemap.xml                 lists every weekly page so Google discovers them
 *
 * Design decisions (confirmed with Carl):
 *   - One page per WEEK, slug dated by the week's Friday (e.g. week-2026-03-27.html)
 *   - A week = the 7 days ENDING on that Friday (Sat..Fri)
 *   - Empty days are skipped (only days with questions render)
 *   - Pages are REPLAYABLE: options are clickable, answer+explainer are in the
 *     HTML (so Google sees them) but hidden until the user clicks — revealed via
 *     CSS/JS, never fetched. Answers ARE visible in view-source; fine for an
 *     archive of PAST weeks. Today's live quiz stays dynamic via index.html.
 *   - Each question links to its live /?date=YYYY-MM-DD version.
 *
 * Data source: the existing /.netlify/functions/question?date=X endpoint, so
 * there is ONE source of truth and no duplicated Google Sheets logic here.
 *
 * Usage:
 *   SITE_URL=https://pubquizdaily.com PUBLISH_DIR=. node build-archive.js
 *   (FIRST_DATE defaults to 2026-03-06, matching archive.html)
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

// ── Config ──────────────────────────────────────────────────────────────────
const SITE_URL    = (process.env.SITE_URL    || 'https://pubquizdaily.com').replace(/\/$/, '');
const PUBLISH_DIR = process.env.PUBLISH_DIR || '.';
const FIRST_DATE  = process.env.FIRST_DATE  || '2026-03-06';
// Where to fetch questions from. In a Netlify build this is the deploy preview /
// production URL; locally you can point it at production.
const API_BASE    = (process.env.API_BASE   || SITE_URL).replace(/\/$/, '');

const QUIZ_DIR = path.join(PUBLISH_DIR, 'quiz');

// ── Small date helpers (all in UTC-noon to dodge DST/timezone drift) ──────────
function isoToDate(iso) { return new Date(iso + 'T12:00:00Z'); }
function dateToISO(d)   { return d.toISOString().slice(0, 10); }

function addDays(iso, n) {
  const d = isoToDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return dateToISO(d);
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

// Day of week: 0=Sun .. 5=Fri .. 6=Sat
function dow(iso) { return isoToDate(iso).getUTCDay(); }

// The Friday on or before a given date (the Friday that ENDS that date's week).
function fridayEnding(iso) {
  const d = dow(iso);               // 0..6
  // distance forward to the next Friday-end. If today is Sat(6), the week
  // ending Friday is 6 days away (next Fri). If Fri(5), it's today (0).
  const diffToFri = (5 - d + 7) % 7;
  return addDays(iso, diffToFri);
}

// The 7 ISO dates (Sat..Fri) for the week ending on `fridayISO`.
function weekDays(fridayISO) {
  const days = [];
  for (let i = 6; i >= 0; i--) days.push(addDays(fridayISO, -i));
  return days;
}

function formatLong(iso) {
  return isoToDate(iso).toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}
function formatShort(iso) {
  return isoToDate(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}
function formatDayName(iso) {
  return isoToDate(iso).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
}

// ── HTML escaping (questions/options/explainers come from a spreadsheet) ──────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// imageUrl — copied verbatim from index.html so behaviour is identical.
function imageUrl(val) {
  if (!val) return null;
  if (val.startsWith('http')) {
    return val.replace(/[?&]dl=0$/, m => m[0] + 'raw=1').replace('www.dropbox.com', 'dl.dropboxusercontent.com');
  }
  return `/.netlify/images?url=/pictures/${encodeURIComponent(val)}&w=600&fit=cover`;
}

const LETTERS = ['A', 'B', 'C', 'D'];

// ── Fetch questions for one date via the existing function endpoint ───────────
async function fetchDay(iso) {
  const url = `${API_BASE}/.netlify/functions/question?date=${iso}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.questions) ? data.questions : [];
  } catch (err) {
    console.warn(`  ! fetch failed for ${iso}: ${err.message}`);
    return [];
  }
}

// ── Render one question card (replayable; answer in DOM but hidden) ───────────
function renderQuestion(q, dayISO, qIndex) {
  const correctLetter = String(q.correct || '').trim().toUpperCase();
  const opts = (q.options || []).map((text, oi) => {
    const letter = LETTERS[oi];
    const isCorrect = letter === correctLetter;
    return `
            <button class="option-btn${isCorrect ? ' is-correct' : ''}"
                    data-letter="${letter}"
                    onclick="pickOption(this)">
              <span class="option-letter">${letter}</span>
              <span class="option-text">${esc(text)}</span>
            </button>`;
  }).join('');

  const img = q.image
    ? `<img class="q-image" src="${esc(imageUrl(q.image))}" alt="${esc(q.question)}" loading="lazy" referrerpolicy="no-referrer" />`
    : '';

  const explainer = q.explainer
    ? `<div class="explainer">${esc(q.explainer)}</div>`
    : '';

  return `
        <div class="question-card" data-correct="${correctLetter}">
          <div class="q-number">Q${qIndex + 1}</div>
          ${img}
          <div class="q-text">${esc(q.question)}</div>
          <div class="options">${opts}
          </div>
          <div class="answer-reveal">
            <span class="answer-label">Answer:</span>
            <span class="answer-value">${correctLetter}. ${esc((q.options || [])[LETTERS.indexOf(correctLetter)] || '')}</span>
          </div>
          ${explainer}
        </div>`;
}

// ── Render a full weekly page ─────────────────────────────────────────────────
function renderWeekPage(fridayISO, daysWithQuestions, prevFriday, nextFriday) {
  const totalQs = daysWithQuestions.reduce((n, d) => n + d.questions.length, 0);
  const slug = `week-${fridayISO}.html`;
  const canonical = `${SITE_URL}/quiz/${slug}`;
  const weekStart = daysWithQuestions[0].date;
  const titleRange = `${formatShort(weekStart)} – ${formatShort(fridayISO)}`;

  // SEO description from the first question, trimmed.
  const firstQ = daysWithQuestions[0].questions[0];
  const descSeed = firstQ ? firstQ.question.replace(/\s+/g, ' ').slice(0, 110) : '';
  const metaDesc = `Replay the Pub Quiz Daily questions from ${titleRange} — ${totalQs} questions with answers and explanations. A free pub quiz, fresh every day.`;

  // OG image: first picture question of the week, if any.
  let ogImage = `${SITE_URL}/og-image.png`;
  for (const d of daysWithQuestions) {
    const pic = d.questions.find(q => q.image);
    if (pic) {
      const u = imageUrl(pic.image);
      ogImage = u.startsWith('http') ? u : `${SITE_URL}${u}`;
      break;
    }
  }

  const daysHtml = daysWithQuestions.map(d => `
      <section class="day-block">
        <h2 class="day-heading">
          <span class="day-name">${formatDayName(d.date)}</span>
          <a class="day-date" href="/?date=${d.date}">${formatLong(d.date)} ›</a>
        </h2>
        <div class="questions">${d.questions.map((q, i) => renderQuestion(q, d.date, i)).join('')}
        </div>
      </section>`).join('');

  const prevLink = prevFriday
    ? `<a class="week-nav-link" href="/quiz/week-${prevFriday}.html">‹ Previous week</a>`
    : `<span></span>`;
  const nextLink = nextFriday
    ? `<a class="week-nav-link" href="/quiz/week-${nextFriday}.html">Next week ›</a>`
    : `<span></span>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Pub Quiz — week of ${formatShort(fridayISO)} | Pub Quiz Daily</title>
  <meta name="description" content="${esc(metaDesc)}" />
  <meta name="robots" content="index, follow" />
  <link rel="canonical" href="${canonical}" />
  <link rel="icon" type="image/x-icon" href="/favicon.ico" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
  <meta property="og:type" content="article" />
  <meta property="og:title" content="Pub Quiz — week of ${formatShort(fridayISO)}" />
  <meta property="og:description" content="${esc(metaDesc)}" />
  <meta property="og:url" content="${canonical}" />
  <meta property="og:image" content="${esc(ogImage)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
  <script type="application/ld+json">
${JSON.stringify(buildJsonLd(fridayISO, daysWithQuestions, canonical), null, 2)}
  </script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --cream: #faf9f7; --ink: #1a1a1a; --ink-light: #6b6b6b; --ink-faint: #c8c8c8;
      --border: #e0ddd8; --correct: #4a7c59; --correct-bg: #edf4ef; --wrong: #3d6b8c;
      --font-serif: 'Libre Baskerville', Georgia, serif;
      --font-sans: 'DM Sans', system-ui, sans-serif;
    }
    body { background: var(--cream); color: var(--ink); font-family: var(--font-sans); min-height: 100dvh; display: flex; flex-direction: column; }
    header { border-bottom: 1px solid var(--border); padding: 0 24px; display: flex; align-items: center; justify-content: space-between; height: 56px; position: relative; }
    .logo { font-family: var(--font-serif); font-size: 1.125rem; font-weight: 700; letter-spacing: -0.01em; color: var(--ink); text-decoration: none; }
    .burger { background: none; border: none; cursor: pointer; padding: 8px; display: flex; flex-direction: column; gap: 5px; z-index: 200; }
    .burger span { display: block; width: 22px; height: 2px; background: var(--ink); border-radius: 2px; transition: all 0.2s; }
    .burger.open span:nth-child(1) { transform: translateY(7px) rotate(45deg); }
    .burger.open span:nth-child(2) { opacity: 0; }
    .burger.open span:nth-child(3) { transform: translateY(-7px) rotate(-45deg); }
    .nav-menu { display: none; position: absolute; top: 56px; right: 0; left: 0; background: white; border-bottom: 1px solid var(--border); z-index: 100; padding: 8px 0; }
    .nav-menu.open { display: block; }
    .nav-menu a { display: block; padding: 12px 24px; font-size: 0.9375rem; font-weight: 500; color: var(--ink); text-decoration: none; border-bottom: 1px solid var(--border); }
    .nav-menu a:last-child { border-bottom: none; }
    .nav-menu a:hover { background: var(--cream); }
    .nav-menu a.active { color: var(--correct); }
    main { flex: 1; max-width: 540px; margin: 0 auto; width: 100%; padding: 40px 24px; }
    .breadcrumb { font-size: 0.8125rem; color: var(--ink-light); margin-bottom: 18px; }
    .breadcrumb a { color: var(--ink-light); text-decoration: none; }
    .breadcrumb a:hover { text-decoration: underline; }
    .page-title { font-family: var(--font-serif); font-size: 1.625rem; line-height: 1.2; margin-bottom: 6px; }
    .tagline { font-family: var(--font-serif); font-style: italic; font-size: 1rem; color: var(--ink-light); margin: 4px 0 14px; }
    .page-subtitle { font-size: 0.875rem; color: var(--ink-light); margin-bottom: 36px; }
    .day-block { margin-bottom: 40px; }
    .day-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 2px solid var(--ink); flex-wrap: wrap; }
    .day-name { font-family: var(--font-serif); font-size: 1.125rem; font-weight: 700; }
    .day-date { font-size: 0.8125rem; color: var(--ink-light); text-decoration: none; white-space: nowrap; }
    .day-date:hover { color: var(--correct); }
    .questions { display: flex; flex-direction: column; gap: 16px; }
    .question-card { background: white; border: 1px solid var(--border); border-radius: 12px; padding: 18px; transition: border-color 0.15s; }
    .question-card.answered { border-color: var(--ink-faint); }
    .q-number { font-size: 0.75rem; font-weight: 600; color: var(--ink-faint); letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 8px; }
    .q-image { width: 100%; max-height: 280px; object-fit: cover; border-radius: 8px; margin-bottom: 12px; }
    .q-text { font-size: 1rem; line-height: 1.5; margin-bottom: 14px; }
    .options { display: flex; flex-direction: column; gap: 7px; }
    .option-btn { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; padding: 11px 14px; background: var(--cream); border: 1px solid var(--border); border-radius: 8px; font-family: var(--font-sans); font-size: 0.9375rem; color: var(--ink); cursor: pointer; transition: background 0.12s, border-color 0.12s; }
    .option-btn:hover:not(:disabled) { border-color: var(--ink); }
    .option-letter { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; flex-shrink: 0; border: 1px solid var(--ink-faint); border-radius: 50%; font-size: 0.8125rem; font-weight: 600; }
    .option-text { flex: 1; }
    /* Revealed states (added by JS after a pick) */
    .question-card.answered .option-btn { cursor: default; }
    .option-btn.reveal-correct { background: var(--correct-bg); border-color: var(--correct); }
    .option-btn.reveal-correct .option-letter { background: var(--correct); border-color: var(--correct); color: white; }
    .option-btn.reveal-correct .option-letter::after { content: '✓'; }
    .option-btn.reveal-correct .option-text { color: var(--correct); font-weight: 500; }
    .option-btn.reveal-wrong { background: #eef3f7; border-color: var(--wrong); }
    .option-btn.reveal-wrong .option-letter { background: var(--wrong); border-color: var(--wrong); color: white; }
    .option-btn.reveal-wrong .option-letter::after { content: '✗'; }
    .option-btn.reveal-wrong .option-text { color: var(--wrong); }
    /* Answer + explainer: present in DOM for SEO, hidden until answered */
    .answer-reveal { display: none; margin-top: 12px; font-size: 0.875rem; }
    .answer-reveal .answer-label { font-weight: 600; color: var(--ink-light); }
    .answer-reveal .answer-value { color: var(--correct); font-weight: 500; }
    .explainer { display: none; margin-top: 10px; font-size: 0.8125rem; color: var(--ink-light); line-height: 1.6; padding-top: 10px; border-top: 1px solid var(--border); }
    .question-card.answered .answer-reveal,
    .question-card.answered .explainer { display: block; }
    .week-nav { display: flex; justify-content: space-between; gap: 12px; margin: 8px 0 32px; }
    .week-nav-link { font-size: 0.875rem; font-weight: 500; color: var(--correct); text-decoration: none; }
    .week-nav-link:hover { text-decoration: underline; }
    .archive-cta { text-align: center; margin-top: 8px; }
    .archive-cta a { font-size: 0.875rem; color: var(--ink-light); text-decoration: none; }
    .archive-cta a:hover { text-decoration: underline; }
    footer { border-top: 1px solid var(--border); text-align: center; padding: 16px 24px; font-size: 0.75rem; color: var(--ink-faint); }
    footer a { color: inherit; text-decoration: none; }
  </style>
</head>
<body>
  <header>
    <a class="logo" href="/">Pub Quiz Daily</a>
    <button class="burger" id="burgerBtn" aria-label="Menu" onclick="toggleMenu()">
      <span></span><span></span><span></span>
    </button>
    <nav class="nav-menu" id="navMenu">
      <a href="/">Today's questions</a>
      <a href="/weekly.html">Weekly Best-of</a>
      <a href="/archive.html" class="active">Full archive</a>
      <a href="/subscribe.html">Friday email</a>
    </nav>
  </header>

  <main>
    <nav class="breadcrumb">
      <a href="/">Home</a> › <a href="/archive.html">Archive</a> › Week of ${formatShort(fridayISO)}
    </nav>
    <h1 class="page-title">Pub Quiz — week of ${formatLong(fridayISO)}</h1>
    <p class="tagline">Make each day questionable.</p>
    <p class="page-subtitle">${totalQs} questions from ${titleRange}. Tap an answer to reveal whether you got it right.</p>

    <div class="week-nav">
      ${prevLink}
      ${nextLink}
    </div>

    ${daysHtml}

    <div class="week-nav">
      ${prevLink}
      ${nextLink}
    </div>
    <p class="archive-cta"><a href="/archive.html">← Browse the full archive</a></p>
  </main>

  <footer>
    Fresh questions. Every day. &nbsp;·&nbsp; <a href="/">Pub Quiz Daily</a>
  </footer>

  <script>
    function toggleMenu() {
      document.getElementById('burgerBtn').classList.toggle('open');
      document.getElementById('navMenu').classList.toggle('open');
    }
    document.addEventListener('click', function(e) {
      if (!e.target.closest('header')) {
        document.getElementById('burgerBtn').classList.remove('open');
        document.getElementById('navMenu').classList.remove('open');
      }
    });
    function pickOption(btn) {
      const card = btn.closest('.question-card');
      if (card.classList.contains('answered')) return;
      const correct = card.getAttribute('data-correct');
      const chosen = btn.getAttribute('data-letter');
      card.classList.add('answered');
      card.querySelectorAll('.option-btn').forEach(b => {
        b.disabled = true;
        const letter = b.getAttribute('data-letter');
        if (letter === correct) b.classList.add('reveal-correct');
        else if (letter === chosen) b.classList.add('reveal-wrong');
      });
    }
  </script>
</body>
</html>`;
}

// ── JSON-LD structured data (Quiz / Question schema helps rich results) ───────
function buildJsonLd(fridayISO, daysWithQuestions, canonical) {
  const questions = [];
  daysWithQuestions.forEach(d => {
    d.questions.forEach(q => {
      const correctText = (q.options || [])[LETTERS.indexOf(String(q.correct).toUpperCase())] || '';
      questions.push({
        '@type': 'Question',
        name: q.question,
        acceptedAnswer: { '@type': 'Answer', text: correctText + (q.explainer ? ' — ' + q.explainer : '') },
      });
    });
  });
  return {
    '@context': 'https://schema.org',
    '@type': 'Quiz',
    name: `Pub Quiz — week of ${formatShort(fridayISO)}`,
    url: canonical,
    about: { '@type': 'Thing', name: 'General knowledge pub quiz' },
    hasPart: questions,
  };
}

// ── archive.html (regenerated: real links to real weekly pages) ───────────────
function renderArchiveIndex(weeks) {
  const items = weeks.map(w => {
    const range = `${formatShort(w.days[0].date)} – ${formatShort(w.friday)}`;
    const count = w.days.reduce((n, d) => n + d.questions.length, 0);
    return `        <a class="archive-item" href="/quiz/week-${w.friday}.html">
          <span class="archive-week">Week of ${formatShort(w.friday)}</span>
          <span class="archive-meta">
            <span class="archive-count">${count} questions · ${range}</span>
            <span class="archive-chevron">›</span>
          </span>
        </a>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Archive — Pub Quiz Daily</title>
  <meta name="description" content="Browse every Pub Quiz Daily question, organised by week. Hundreds of free pub quiz questions with answers — replay any past week." />
  <meta name="robots" content="index, follow" />
  <link rel="canonical" href="${SITE_URL}/archive.html" />
  <link rel="icon" type="image/x-icon" href="/favicon.ico" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --cream: #faf9f7; --ink: #1a1a1a; --ink-light: #6b6b6b; --ink-faint: #c8c8c8;
      --border: #e0ddd8; --correct: #4a7c59; --correct-bg: #edf4ef;
      --font-serif: 'Libre Baskerville', Georgia, serif;
      --font-sans: 'DM Sans', system-ui, sans-serif;
    }
    body { background: var(--cream); color: var(--ink); font-family: var(--font-sans); min-height: 100dvh; display: flex; flex-direction: column; }
    header { border-bottom: 1px solid var(--border); padding: 0 24px; display: flex; align-items: center; justify-content: space-between; height: 56px; position: relative; }
    .logo { font-family: var(--font-serif); font-size: 1.125rem; font-weight: 700; letter-spacing: -0.01em; color: var(--ink); text-decoration: none; }
    .burger { background: none; border: none; cursor: pointer; padding: 8px; display: flex; flex-direction: column; gap: 5px; z-index: 200; }
    .burger span { display: block; width: 22px; height: 2px; background: var(--ink); border-radius: 2px; transition: all 0.2s; }
    .burger.open span:nth-child(1) { transform: translateY(7px) rotate(45deg); }
    .burger.open span:nth-child(2) { opacity: 0; }
    .burger.open span:nth-child(3) { transform: translateY(-7px) rotate(-45deg); }
    .nav-menu { display: none; position: absolute; top: 56px; right: 0; left: 0; background: white; border-bottom: 1px solid var(--border); z-index: 100; padding: 8px 0; }
    .nav-menu.open { display: block; }
    .nav-menu a { display: block; padding: 12px 24px; font-size: 0.9375rem; font-weight: 500; color: var(--ink); text-decoration: none; border-bottom: 1px solid var(--border); }
    .nav-menu a:last-child { border-bottom: none; }
    .nav-menu a:hover { background: var(--cream); }
    .nav-menu a.active { color: var(--correct); }
    main { flex: 1; max-width: 480px; margin: 0 auto; width: 100%; padding: 40px 24px; }
    .page-title { font-family: var(--font-serif); font-size: 1.5rem; margin-bottom: 6px; }
    .tagline { font-family: var(--font-serif); font-style: italic; font-size: 1rem; color: var(--ink-light); margin: 4px 0 14px; }
    .page-subtitle { font-size: 0.875rem; color: var(--ink-light); margin-bottom: 32px; }
    .archive-list { display: flex; flex-direction: column; gap: 8px; }
    .archive-item { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; background: white; border: 1px solid var(--border); border-radius: 8px; text-decoration: none; color: var(--ink); transition: border-color 0.12s, transform 0.08s; }
    .archive-item:hover { border-color: var(--ink); transform: translateY(-1px); }
    .archive-week { font-size: 0.9375rem; font-weight: 600; }
    .archive-meta { display: flex; align-items: center; gap: 10px; }
    .archive-count { font-size: 0.8125rem; color: var(--ink-light); text-align: right; }
    .archive-chevron { color: var(--ink-faint); font-size: 1rem; }
    .empty { color: var(--ink-light); font-size: 0.875rem; }
    footer { border-top: 1px solid var(--border); text-align: center; padding: 16px 24px; font-size: 0.75rem; color: var(--ink-faint); }
    footer a { color: inherit; text-decoration: none; }
  </style>
</head>
<body>
  <header>
    <a class="logo" href="/">Pub Quiz Daily</a>
    <button class="burger" id="burgerBtn" aria-label="Menu" onclick="toggleMenu()">
      <span></span><span></span><span></span>
    </button>
    <nav class="nav-menu" id="navMenu">
      <a href="/">Today's questions</a>
      <a href="/weekly.html">Weekly Best-of</a>
      <a href="/archive.html" class="active">Full archive</a>
      <a href="/subscribe.html">Friday email</a>
    </nav>
  </header>

  <main>
    <h1 class="page-title">Archive</h1>
    <p class="tagline">Make each day questionable.</p>
    <p class="page-subtitle">Every question we've ever asked, organised by week. Replay any of them.</p>
    <div class="archive-list">
${items || '      <p class="empty">No questions yet — check back soon!</p>'}
    </div>
  </main>

  <footer>
    Fresh questions. Every day. &nbsp;·&nbsp; <a href="/">Pub Quiz Daily</a>
  </footer>

  <script>
    function toggleMenu() {
      document.getElementById('burgerBtn').classList.toggle('open');
      document.getElementById('navMenu').classList.toggle('open');
    }
    document.addEventListener('click', function(e) {
      if (!e.target.closest('header')) {
        document.getElementById('burgerBtn').classList.remove('open');
        document.getElementById('navMenu').classList.remove('open');
      }
    });
  </script>
</body>
</html>`;
}

// ── sitemap.xml ───────────────────────────────────────────────────────────────
function renderSitemap(weeks) {
  const staticUrls = ['/', '/archive.html', '/weekly.html', '/subscribe.html'];
  const urls = [
    ...staticUrls.map(u => ({ loc: SITE_URL + u, lastmod: todayISO() })),
    ...weeks.map(w => ({ loc: `${SITE_URL}/quiz/week-${w.friday}.html`, lastmod: w.friday })),
  ];
  const body = urls.map(u =>
    `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n  </url>`
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const today = todayISO();
  console.log(`Pub Quiz Daily archive build`);
  console.log(`  API_BASE=${API_BASE}  SITE_URL=${SITE_URL}  PUBLISH_DIR=${PUBLISH_DIR}`);
  console.log(`  range ${FIRST_DATE} .. ${today}\n`);

  // Group every date from FIRST_DATE..today into weeks (by week-ending Friday).
  // We DON'T pre-generate the current (incomplete) week's page if its Friday is
  // in the future AND today is that Friday's live day — but we DO include the
  // current partial week so recent days are crawlable. We simply skip *today*
  // itself, because today's answers should stay behind the live dynamic page.
  const weekMap = new Map(); // fridayISO -> [dateISO...]
  let cur = FIRST_DATE;
  while (cur < today) {                 // strictly before today: never expose today's answers
    const fri = fridayEnding(cur);
    if (!weekMap.has(fri)) weekMap.set(fri, []);
    weekMap.get(fri).push(cur);
    cur = addDays(cur, 1);
  }

  // Fetch questions for each candidate date, build week objects.
  const fridays = [...weekMap.keys()].sort();      // ascending
  const weeks = [];
  for (const fri of fridays) {
    const dayList = weekMap.get(fri).sort();
    const daysWithQuestions = [];
    for (const dISO of dayList) {
      const qs = await fetchDay(dISO);
      if (qs.length > 0) daysWithQuestions.push({ date: dISO, questions: qs });
    }
    if (daysWithQuestions.length > 0) {
      weeks.push({ friday: fri, days: daysWithQuestions });
    }
  }

  // Write output.
  fs.mkdirSync(QUIZ_DIR, { recursive: true });

  const weeksDesc = [...weeks].reverse(); // newest first for archive listing
  weeks.forEach((w, idx) => {
    const prevFriday = idx > 0 ? weeks[idx - 1].friday : null;            // older
    const nextFriday = idx < weeks.length - 1 ? weeks[idx + 1].friday : null; // newer
    const html = renderWeekPage(w.friday, w.days, prevFriday, nextFriday);
    const outPath = path.join(QUIZ_DIR, `week-${w.friday}.html`);
    fs.writeFileSync(outPath, html, 'utf8');
    const n = w.days.reduce((a, d) => a + d.questions.length, 0);
    console.log(`  ✓ quiz/week-${w.friday}.html  (${w.days.length} days, ${n} questions)`);
  });

  fs.writeFileSync(path.join(PUBLISH_DIR, 'archive.html'), renderArchiveIndex(weeksDesc), 'utf8');
  console.log(`  ✓ archive.html  (${weeks.length} weeks)`);

  fs.writeFileSync(path.join(PUBLISH_DIR, 'sitemap.xml'), renderSitemap(weeksDesc), 'utf8');
  console.log(`  ✓ sitemap.xml`);

  console.log(`\nDone — ${weeks.length} weekly pages generated.`);
}

main().catch(err => { console.error('BUILD FAILED:', err); process.exit(1); });
