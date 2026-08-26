# Job Alert Bot

Checks new job listings on Djinni and DOU (via their official RSS feeds),
compares each new listing against your resume via the Claude API, and sends
matches (score ≥ 65/100) to Telegram along with a cover letter.
Optionally, each such listing is also logged as a row in Google Sheets,
so it's easy to track which applications you've already sent. Runs for free
on GitHub Actions on a schedule (every 30 minutes).

## How it works

1. GitHub Actions runs `fetch-jobs.mjs` on a cron schedule.
2. The script reads RSS feeds (the list is at the top of `fetch-jobs.mjs`, easy to edit).
3. New listings (not already in `state/seen.json`) are sent to the Claude API
   along with the resume text (`resume.txt`) for match scoring.
4. If the score is ≥ the threshold — Claude generates a cover letter in the
   listing's language, and all of it (score, link, letter) is sent to Telegram.
5. If the Google Sheets integration is configured — the same listing is appended
   as a row in the sheet with an empty "Response Status" column for manual notes.
6. The list of seen listings is committed back to the repository, so notifications
   aren't duplicated on the next run.

## Step 1. Create a Telegram bot and get the chat_id

1. In Telegram open **@BotFather** → `/newbot` → follow the instructions → you'll get a `TELEGRAM_BOT_TOKEN`.
2. Send your new bot any message (just "hi"), so it has a chat with you.
3. Open in a browser:
   `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
   Find `"chat":{"id":123456789,...}` in the response — that's your `TELEGRAM_CHAT_ID`.

## Step 2. Get an Anthropic API key

1. Go to console.anthropic.com → API Keys → create a key.
2. This is a paid API (separate from your Claude.ai subscription), but at this
   volume of requests (a few listings every 30 minutes) the cost is usually cents a day.

## Step 3 (optional). Set up writing to Google Sheets

If you want to conveniently track which applications you've already sent, set up
a Google Sheet and connect it via a service account (authorization without an
interactive login, suitable for GitHub Actions):

1. Go to [console.cloud.google.com](https://console.cloud.google.com) →
   create a new project (or select an existing one).
2. Under **APIs & Services → Library** find **Google Sheets API** → **Enable**.
3. Under **APIs & Services → Credentials** → **Create Credentials** →
   **Service Account** → give it any name → **Create and Continue** → **Done**.
4. Open the created service account → **Keys** tab → **Add Key** →
   **Create new key** → type **JSON** → the key file will download.
5. In the downloaded JSON, find the fields:
   - `client_email` — this becomes `GOOGLE_SERVICE_ACCOUNT_EMAIL`;
   - `private_key` — this becomes `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` (copy the
     whole value, including `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----`).
6. Create a new Google Sheet (sheets.google.com) for the listings.
7. Click **Share** in the sheet → add the email from `client_email` (step 5) with
   **Editor** access. Without this the service account can't write to the sheet.
8. Copy the `GOOGLE_SHEET_ID` — it's the part of the sheet's URL between `/d/` and `/edit`:
   `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`.

The sheet's header row (Date / Score / Job / Link / Reason / Cover Letter /
Response Status) is created by the script itself on the first run, if row 1 is
empty. If you want to write to a sheet tab other than the first — add a
`GOOGLE_SHEET_NAME` secret with the exact tab name (defaults to `Sheet1`).

If these secrets aren't set — the bot simply doesn't write to the sheet, nothing breaks.
Only listings found **after** the secrets are configured are automatically added
to the sheet — past Telegram notifications don't retroactively appear on their own.

### Backfill listings that were already sent to Telegram before

This can be done once without a single call to the Claude API — all the needed
data (score, title, reason, letter, link) is already in the text of the bot's
past messages:

1. In Telegram Desktop open the chat with the bot → menu (⋮) → **Export chat history**
   → format **JSON** → export.
2. Run locally (needs the same `GOOGLE_SERVICE_ACCOUNT_EMAIL` /
   `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` / `GOOGLE_SHEET_ID` secrets from step 3
   as environment variables):
   ```bash
   node backfill-telegram-history.mjs path/to/result.json
   ```
3. The script parses all past bot messages, skips links already present in the
   sheet (matched against the "Link" column) and appends the rest.
   It can be run any number of times — repeated runs won't create duplicates.

## Step 4. Push the project to GitHub

```bash
cd job-alert-bot
git init
git add .
git commit -m "Initial commit"
gh repo create job-alert-bot --private --source=. --push
# or manually: create a private repository on github.com and push this folder
```

Important: make the repository **private** — it contains your resume.

## Step 5. Add secrets to the repository

In the repository: Settings → Secrets and variables → Actions → New repository secret.
Required secrets:
- `ANTHROPIC_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Optional (if you configured Google Sheets in step 3):
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`
- `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`
- `GOOGLE_SHEET_ID`
- `GOOGLE_SHEET_NAME` (if the tab isn't named `Sheet1`)

## Step 6. Run it

Actions is already set up to run automatically every 30 minutes. To check it
right away, without waiting for the schedule: **Actions** tab → **Check new jobs** → **Run workflow**.

## Customizing

- **Source list** — the `FEEDS` array at the top of `fetch-jobs.mjs`. You can add
  other Djinni keywords (`?primary_keyword=...`) or DOU categories
  (`?category=...`), just by visiting the site, setting a filter, and copying
  the `.../feeds/?...` link (Djinni) or finding the `RSS` link on the page (DOU).
- **Match threshold** — the `MATCH_THRESHOLD` constant (0-100).
- **Resume** — just edit `resume.txt`, no code changes needed.
- **Check frequency** — the `cron` string in `.github/workflows/check-jobs.yml`.
  Don't set it too frequent (e.g. once a minute) — it increases load and
  API cost without much benefit, since listings don't appear that fast.

## About LinkedIn

LinkedIn was deliberately left out: it has no public RSS for job search, and
automated access to the site (login, scraping) is directly prohibited by their
terms of use and technically blocked (CAPTCHA).
Instead, it's recommended to:
1. On linkedin.com/jobs set up a regular search filter → enable "Job Alerts"
   (button above the results list) → LinkedIn will email you when new
   listings match that filter.
2. If you want, those emails can also be read automatically (via IMAP) and
   run through the same scoring — let me know if you'd like that built separately.

## About DOU

DOU provides listings via an official RSS feed (`jobs.dou.ua/vacancies/feeds/?category=...`),
so unlike Djinni you don't even need to figure out a special link format —
just look for the "RSS" button on the page with your desired filters.
