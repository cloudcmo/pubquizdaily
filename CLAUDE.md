# Pub Quiz Daily

Site code lives in `pubquizdaily/` (Netlify base directory). Repo root is this folder.

## Netlify deploys: staging by default, main once a week

This site is on Netlify's free plan. Every push to `main` is a production
deploy costing 15 credits, out of 300 a month for the whole account (shared
with Whenly). Pushes to `staging` are branch deploys and cost nothing.

- Commit and push to `staging`. Never push to `main` directly.
- A GitHub Action (`.github/workflows/weekly-promote.yml`) merges `staging`
  into `main` every Thursday at 08:00 UTC, if staging has anything new.
- A local pre-push hook blocks pushes to `main`. If something is genuinely
  urgent, say so to Carl and let him run `pubquizdaily/deploy-main.sh` (it sets `PROMOTE_OK=1`).
- Batch work: several changes in one week still cost one deploy.
- Friday email changes (`netlify/functions/weekly-preview.js` and friends) must
  be on `staging` before Thursday 08:00 UTC, because the Thursday 18:30 UK
  preview runs from whatever is live on `main`.
- Cross-game changes (Guff bar etc.) that touch this repo: push to `staging`
  here even when the Cloudflare games deploy straight away.
