# Pub Quiz Daily — automated Weekly Best-of (Resend)

_Updated 25 July 2026. The Resend audience is seeded; this covers the automated weekly email and how to switch it on._

## Does anything need pushing to Git? — Yes

These are Netlify functions, so they only exist once the site is deployed. Two steps:

1. **Add the environment variables** (below) in Netlify → Site configuration → Environment variables.
2. **Deploy** — commit and push to your main branch (Netlify auto-builds from GitHub), or run your `deploy-main.sh`. On deploy, Netlify reads `netlify.toml` and registers the scheduled functions automatically. If you add/change env vars after a deploy, trigger one more redeploy so the functions pick them up.

Nothing runs until it's deployed, so you can review everything first with `git diff`.

## How it works

- **Thursday ~18:30 UK** — `weekly-preview.js` builds the upcoming Friday email (this week's `W`-flagged questions, a % stat, AI-written intro copy, a subject line that's one of the questions, a hero image from the quiz), stores it, and emails you a **preview** with a one-click **"Cancel this week's send"** button.
- **Friday ~06:30 UK** — `weekly-broadcast.js` checks the cancel flag. If you didn't cancel, it sends the *exact* email you previewed to the Pub Quiz Daily segment as a Resend broadcast. If you clicked cancel, nothing goes out; next week resumes normally.
- **`weekly-cancel.js`** — the small endpoint the cancel button hits.

The timing is **DST-proof**: each job is scheduled at two UTC times and only runs at the right Europe/London hour, so it stays 18:30 / 06:30 UK all year with no manual clock changes.

The email is a **teaser** — image, a few lines of fun copy, a stat, one big button to the weekly page. Its whole job is the click-through.

## Environment variables to add

| Variable | Value / where to get it |
|---|---|
| `RESEND_SEGMENT_ID` | `90610922-0511-40a1-a3d1-2c645d992210` (the Pub Quiz Daily segment) |
| `GEMINI_API_KEY` | Free key from Google AI Studio (aistudio.google.com → "Get API key"). Free tier is ample for one email/week. |
| `WEEKLY_CANCEL_TOKEN` | A secret that protects the cancel link. Suggested: `pqd-wk-7f3c1a9be2d4485a9c1e6b02f8a71d34` (or your own random string) |
| `GEMINI_MODEL` | *Optional.* Defaults to `gemini-1.5-flash`. Only set this if that model name ever 404s — then use the current free "flash" model name. |

Already set and reused: `RESEND_API_KEY`, `GOOGLE_SHEET_ID`, `GOOGLE_API_KEY`, `NETLIFY_SITE_ID`, `NETLIFY_API_TOKEN`, `DAILY_REPORT_EMAIL` (this is where previews and alerts go — currently carl@mesnerlyons.com).

If `GEMINI_API_KEY` is missing or the AI call fails, the copy falls back to a clean templated version automatically — it never blocks the send.

## Testing before it goes fully live

- **Safest first test:** set `WEEKLY_DRY_RUN=true`. Then the Friday job emails the built email to `DAILY_REPORT_EMAIL` instead of broadcasting to the list. Remove the flag when happy.
- To trigger a run off-schedule (rather than waiting for Thu/Fri), run locally with `netlify dev` and `netlify functions:invoke weekly-preview` / `weekly-broadcast`. Note the London-hour gate — when invoking manually outside 18:00/06:00 UK it will say "not the scheduled UK hour"; comment out the gate for a manual test, or invoke at the right hour.
- The cancel button: open the preview, click **Cancel this week's send**, confirm you get the "Cancelled ✓" page. Then the Friday job will skip.

## Going fully live / retiring Mailchimp

- Deploy `subscribe.js` — new signups now flow into the Pub Quiz Daily segment (welcome email on by default; `SEND_WELCOME` toggles it).
- Let one clean automated Friday go out, then delete the `MAILCHIMP_*` env vars and turn off the Mailchimp automation.

## Files

- `netlify/functions/weekly-preview.js` — Thursday build + AI copy + preview
- `netlify/functions/weekly-cancel.js` — one-click cancel endpoint
- `netlify/functions/weekly-broadcast.js` — Friday send of the previewed email
- `netlify/functions/subscribe.js` — signups → Resend segment (+ welcome email)
- `netlify.toml` — DST-proof schedules

## Notes

- Stats are **percentages only** — no absolute player counts ever appear.
- A question's % is only shown once ≥ 4 people have answered it.
- There's an empty leftover segment "General" from setup — harmless; ignore or delete it.
- Nothing auto-deploys from here — review with `git diff` and deploy when ready.
