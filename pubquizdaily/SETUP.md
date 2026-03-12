# Pub Quiz Daily — Complete Setup Guide

Follow these steps in order. The whole setup takes about 20–30 minutes.

---

## Step 1 — Create your Google Sheet

1. Go to **sheets.google.com** and click **Blank spreadsheet**
2. Rename it to `Pub Quiz Daily` (click "Untitled spreadsheet" at the top)
3. In **Row 1**, type these exact headers in columns A–G:

   | A | B | C | D | E | F | G |
   |---|---|---|---|---|---|---|
   | date | question | A | B | C | D | correct |

4. Starting from **Row 2**, add your questions. Example:

   | A | B | C | D | E | F | G |
   |---|---|---|---|---|---|---|
   | 2026-03-12 | What is the capital city of France? | London | Paris | New York | Sydney | B |
   | 2026-03-13 | Who wrote Romeo and Juliet? | Charles Dickens | Jane Austen | William Shakespeare | Oscar Wilde | C |

   **Important rules:**
   - Dates must be in **YYYY-MM-DD** format (e.g. 2026-03-13)
   - The `correct` column must be **A**, **B**, **C**, or **D** — just the letter
   - Add as many future dates as you like — the function only shows the matching date

5. **Share the sheet publicly** (read-only):
   - Click **Share** (top right)
   - Change "General access" to **Anyone with the link**
   - Make sure role is set to **Viewer**
   - Click **Done**

6. Copy the **Sheet ID** from the URL. Example:
   - URL: `https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms/edit`
   - Sheet ID: `1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms`
   - Save this — you'll need it in Step 3.

---

## Step 2 — Get a Google Sheets API Key

1. Go to **console.cloud.google.com**
2. Click **Select a project** → **New Project**
3. Name it `Pub Quiz Daily` and click **Create**
4. In the left menu, go to **APIs & Services → Library**
5. Search for **Google Sheets API** and click **Enable**
6. Go to **APIs & Services → Credentials**
7. Click **+ Create Credentials → API Key**
8. Copy the API key — save it somewhere safe
9. (Optional but recommended) Click **Edit API Key** and under **API restrictions**, select **Restrict key** → choose **Google Sheets API**

---

## Step 3 — Deploy to Netlify

### Option A: Drag and drop (quickest)

1. Go to **netlify.com** and sign up / log in (free account is fine)
2. From the Netlify dashboard, drag the entire `pubquizdaily` folder onto the page where it says "Drag and drop your site folder"
3. Your site will be live at a random URL like `rainbow-unicorn-123.netlify.app`
4. To add environment variables:
   - In Netlify, click your site → **Site configuration → Environment variables**
   - Add these two variables:
     - Key: `GOOGLE_SHEET_ID` → Value: *your Sheet ID from Step 1*
     - Key: `GOOGLE_API_KEY` → Value: *your API key from Step 2*
   - Click **Save**
5. **Redeploy** the site so the function picks up the new variables:
   - Go to **Deploys** tab → click **Trigger deploy → Deploy site**

### Option B: Via Git (recommended for ongoing updates)

1. Create a free account at **github.com** if you don't have one
2. Create a new repository called `pubquizdaily`
3. Upload the project folder (or use GitHub Desktop)
4. In Netlify: **Add new site → Import an existing project → GitHub**
5. Select your repo — Netlify auto-detects `netlify.toml`
6. Add environment variables as in Option A above
7. Click **Deploy site**

---

## Step 4 — Test it

1. Visit your Netlify URL
2. You should see today's question (if you've added today's date to the sheet)
3. Tap an answer — it should go green (correct) or orange (wrong) with the correct answer revealed
4. The share button should copy a fun message to your clipboard

**If you see "No question today":**
- Check the date format in your sheet (must be YYYY-MM-DD)
- Make sure the sheet is shared publicly (Step 1, point 5)
- Check the environment variables are saved and you've redeployed

---

## Step 5 — Rename your site (optional)

1. In Netlify: **Site configuration → General → Site details**
2. Click **Change site name**
3. Type `pubquizdaily` (or whatever you like)
4. Your site is now at `pubquizdaily.netlify.app`

---

## Adding new questions

Just add new rows to your Google Sheet. No redeployment needed.

Format:
```
2026-04-01  |  Who invented the telephone?  |  Thomas Edison  |  Nikola Tesla  |  Alexander Graham Bell  |  Guglielmo Marconi  |  C
```

The function fetches live from the sheet each time — a 5-minute cache means new rows appear quickly.

---

## Tip: Load up questions in advance

The system is designed for you to schedule questions ahead of time. Add a month's worth of questions at once, and the site runs itself — it only serves the question whose date matches today.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| "Missing environment variables" error | Add `GOOGLE_SHEET_ID` and `GOOGLE_API_KEY` in Netlify and redeploy |
| "Failed to fetch sheet" error | Make sure the sheet is shared publicly and the API key has Sheets API access |
| Wrong date shown | Check your sheet uses YYYY-MM-DD format |
| Streak not working | Streak is stored in the browser — it resets if the user clears their browser data |
| Share button doesn't work | On desktop without Web Share API, it copies to clipboard instead |

---

## Project file structure

```
pubquizdaily/
├── public/
│   └── index.html          ← The entire game (edit this for design changes)
├── netlify/
│   └── functions/
│       └── question.js     ← Serverless function that reads your Sheet
├── netlify.toml            ← Netlify config
└── package.json
```
