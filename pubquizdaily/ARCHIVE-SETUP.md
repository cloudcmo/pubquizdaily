# Static SEO archive — setup guide

This makes Pub Quiz Daily's questions into **real, crawlable HTML** instead of
content fetched client-side at runtime (which Google effectively can't see).

## What you get

- `/quiz/week-YYYY-MM-DD.html` — one page per week, dated by that week's **Friday**.
  Each page has every question from that week (Sat→Fri, empty days skipped) as
  real text: question, options, correct answer, explainer. **Replayable** — tap
  an option and it reveals ✓ / ✗ in your steel-blue/green styling. Answers live
  in the HTML (so Google indexes them) but are hidden until clicked.
- `/archive.html` — regenerated to link to the real weekly pages (was: an empty
  JS-generated list of date links to `/?date=X`).
- `/sitemap.xml` — lists every weekly page so Google discovers them all.
- Each question links to its live `/?date=YYYY-MM-DD` version (passes link equity).
- Per-page JSON-LD `Quiz`/`Question` structured data + Open Graph tags
  (first picture question of the week becomes the OG image).

**Today is never pre-rendered** — the generator only covers dates strictly
*before* today, so today's answers stay behind the live dynamic page in
`index.html`. Today's quiz keeps working exactly as now.

## Files (drop into the repo root: /Users/carl/code/pubquizdaily/pubquizdaily/)

```
build-archive.js                              # the generator (Node, no deps)
netlify/plugins/generate-archive/index.js     # runs generator on every build
netlify/plugins/generate-archive/manifest.yml
netlify/functions/rebuild-archive.js          # daily scheduled build-hook ping
```

## Wire it up

### 1. netlify.toml — register the build plugin

Add this block (merge with your existing `netlify.toml`):

```toml
[[plugins]]
  package = "/netlify/plugins/generate-archive"
```

That's a *local* plugin (leading `/`), so no npm publish needed.

### 2. Build hook + daily schedule

1. Netlify dashboard → **Site settings → Build & deploy → Build hooks** →
   **Add build hook**, name it `daily-archive`, copy the URL.
2. **Site settings → Environment variables** → add `BUILD_HOOK_URL` = that URL.
3. The scheduled function `rebuild-archive.js` pings it at **05:30 UTC daily**
   (just before your 6am daily-report email, so the archive is fresh).

### 3. Robots / Search Console

- Make sure `robots.txt` references the sitemap:
  ```
  Sitemap: https://pubquizdaily.com/sitemap.xml
  ```
- In Search Console, submit `https://pubquizdaily.com/sitemap.xml`.

## How the data flows

The generator does **not** re-implement Google Sheets access. It calls your
existing `/.netlify/functions/question?date=X` endpoint — one source of truth,
no duplicated parsing, no extra env vars. During a Netlify build it points at
the deploy's own URL (`DEPLOY_PRIME_URL`) so it always reads the freshest sheet.

## Test locally before trusting it

```bash
cd /Users/carl/code/pubquizdaily/pubquizdaily
SITE_URL=https://pubquizdaily.com \
API_BASE=https://pubquizdaily.com \
PUBLISH_DIR=. \
FIRST_DATE=2026-03-06 \
node build-archive.js
```

It'll fetch live question data from production and write the files locally so
you can open `quiz/week-*.html` in a browser and eyeball them before deploying.
(Then `git checkout` to discard, or commit if happy — though normally the build
regenerates them, so you may want to add `/quiz/`, `sitemap.xml` and the
generated `archive.html` to `.gitignore` and let the build own them.)

## Gotchas / decisions baked in

- **Week = Sat→Fri ending on the labelled Friday.** Change `fridayEnding()` /
  `weekDays()` in build-archive.js if you want Mon→Sun instead.
- **Empty days skipped.** A week with no questions produces no page.
- **Answers in view-source.** Fine for past weeks; that's why today is excluded.
- **Picture questions** use the exact `imageUrl()` logic from index.html
  (Dropbox `dl=0`→`raw=1` + `dl.dropboxusercontent.com`, else Netlify Image CDN)
  and `referrerpolicy="no-referrer"`. `alt` text = the question text.
- **Truncation guard.** Generated files were verified to end with proper
  `</script></body></html>`. The generator builds strings in memory and writes
  once, so the partial-write truncation you've hit when editing by hand doesn't
  apply here — but `tail -5 quiz/week-*.html` after a build never hurts.
- **No `.gitignore` in git for /quiz if the build owns it** — decide whether the
  pages are build artifacts (preferred) or committed files.
```
