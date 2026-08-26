// fetch-jobs.mjs
// Checks job RSS feeds (Djinni + DOU), compares new listings against the
// resume via the Claude API, and sends matches to Telegram + Google Sheets.
//
// Run: node fetch-jobs.mjs
// Required environment variables (see README.md):
//   ANTHROPIC_API_KEY
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID
// Optional (for writing to Google Sheets):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
//   GOOGLE_SHEET_ID
//   GOOGLE_SHEET_NAME (defaults to "Sheet1")

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";
import { googleSheetsEnabled, getGoogleAccessToken, ensureSheetHeader, appendRows } from "./google-sheets.mjs";

// ---------- SETTINGS ----------

// List of RSS feeds to check. Add/remove lines as needed.
const FEEDS = [
  // Djinni — filter by one keyword at a time
  "https://djinni.co/jobs/rss/?primary_keyword=React.js",
  "https://djinni.co/jobs/rss/?primary_keyword=Node.js",
  "https://djinni.co/jobs/rss/?primary_keyword=Fullstack",
  "https://djinni.co/jobs/rss/?primary_keyword=JavaScript",

  // DOU — filter by category
  "https://jobs.dou.ua/vacancies/feeds/?category=Front%20End",
  "https://jobs.dou.ua/vacancies/feeds/?category=Node.js",
];

// Relevance threshold (0-100) above which we send a notification
const MATCH_THRESHOLD = 65;

// Model used for match scoring
const MODEL = "claude-sonnet-4-6";

// ---------- INTERNALS ----------

const STATE_PATH = new URL("./state/seen.json", import.meta.url);
const RESUME_PATH = new URL("./resume.txt", import.meta.url);

function loadSeen() {
  if (!existsSync(STATE_PATH)) return new Set();
  try {
    const arr = JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    return new Set(arr);
  } catch {
    return new Set();
  }
}

function saveSeen(seenSet) {
  // Keep only the last 2000 links so the file doesn't grow without bound
  const arr = Array.from(seenSet).slice(-2000);
  mkdirSync(new URL(".", STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(arr, null, 2));
}

async function fetchFeed(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (job-alert-bot)" },
  });
  if (!res.ok) {
    console.error(`Feed failed: ${url} -> ${res.status}`);
    return [];
  }
  const xml = await res.text();
  const parser = new XMLParser({
    ignoreAttributes: false,
    // Entity-expansion attack protection counts limits against the whole
    // document, not per item — a large feed with lots of &amp;/&nbsp; in
    // descriptions easily hits the default of 1000. A real attack (billion
    // laughs) causes exponential output growth relative to input, so instead
    // of disabling the protection we just scale maxExpandedLength to the
    // size of the XML itself — linear growth from ordinary entities stays safe.
    processEntities: {
      enabled: true,
      maxTotalExpansions: 200000,
      maxExpandedLength: Math.max(xml.length * 5, 2000000),
    },
  });
  const data = parser.parse(xml);
  const items = data?.rss?.channel?.item;
  if (!items) return [];
  return Array.isArray(items) ? items : [items];
}

function stripHtml(s = "") {
  return String(s)
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Escaping for Telegram parse_mode=HTML (title/description from RSS
// can contain &, <, >, etc.)
function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function scoreMatch(resumeText, jobTitle, jobDescription) {
  const prompt = `You help evaluate how well a job listing matches a candidate's resume.

RESUME:
${resumeText}

JOB LISTING:
Title: ${jobTitle}
Description: ${jobDescription.slice(0, 3000)}

Score the match from 0 to 100, where 100 is a perfect match of tech stack and experience level.
Answer STRICTLY in JSON format with no markdown formatting:
{"score": <number>, "reason": "<1 short sentence in Ukrainian, explaining why>"}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 300,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    console.error("Anthropic API error", res.status, await res.text());
    return { score: 0, reason: "помилка оцінки" };
  }

  const data = await res.json();
  const text = data.content?.find((c) => c.type === "text")?.text ?? "{}";
  const clean = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    console.error("Failed to parse model output:", text);
    return { score: 0, reason: "не вдалося розібрати відповідь моделі" };
  }
}

async function generateCoverLetter(resumeText, jobTitle, jobDescription) {
  const prompt = `You help a candidate write a cover letter for a job application.

RESUME:
${resumeText}

JOB LISTING:
Title: ${jobTitle}
Description: ${jobDescription.slice(0, 3000)}

Detect the language of the listing primarily from the DESCRIPTION text, and write
the cover letter in THAT SAME language (e.g. if the description is in English, write
the letter in English; if in Ukrainian, write it in Ukrainian; if in another language,
match that language). Some job boards append a company name and location in Ukrainian
at the end of the title regardless of the listing's actual language — ignore that part
of the title for language detection and trust the description body instead.
Keep the letter short (2-4 sentences), first person, with no greeting or sign-off
like "Best regards" — just the letter text.
Mention 2-3 skills/projects from the resume most relevant to this listing.
Do not use em dashes ("—") anywhere in the letter; use periods or commas instead.
If the letter ends up in English, write it the way a non-native speaker at a B1+/B2-
level would: simple, natural sentences and everyday word choices, not polished
corporate or native-level phrasing. Avoid buzzwords like "passionate", "leverage",
"synergy", or "excited to apply".
Answer STRICTLY in JSON format with no markdown formatting:
{"coverLetter": "<letter text in the job listing's language>"}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    console.error("Anthropic API error", res.status, await res.text());
    return { coverLetter: "" };
  }

  const data = await res.json();
  const text = data.content?.find((c) => c.type === "text")?.text ?? "{}";
  const clean = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    console.error("Failed to parse model output:", text);
    return { coverLetter: "" };
  }
}

async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
  });
  if (!res.ok) {
    console.error("Telegram send failed", res.status, await res.text());
  }
}

// ---------- MAIN PROCESS ----------

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is not set");
  if (!process.env.TELEGRAM_CHAT_ID) throw new Error("TELEGRAM_CHAT_ID is not set");

  const resumeText = readFileSync(RESUME_PATH, "utf-8");
  const seen = loadSeen();
  let newCount = 0;
  let matchCount = 0;

  let sheetsToken = null;
  if (googleSheetsEnabled()) {
    sheetsToken = await getGoogleAccessToken();
    if (sheetsToken) {
      await ensureSheetHeader(sheetsToken);
    } else {
      console.error("Failed to get a Google access token — writing to the sheet is disabled for this run");
    }
  }

  for (const feedUrl of FEEDS) {
    console.log(`Checking: ${feedUrl}`);
    const items = await fetchFeed(feedUrl);

    for (const item of items) {
      const link = String(item.link ?? "").trim();
      const title = stripHtml(item.title);
      const description = stripHtml(item.description ?? item["content:encoded"] ?? "");

      if (!link || seen.has(link)) continue;
      seen.add(link);
      newCount++;

      const { score, reason } = await scoreMatch(resumeText, title, description);
      console.log(`  [${score}] ${title} — ${reason}`);

      if (score >= MATCH_THRESHOLD) {
        matchCount++;
        const { coverLetter } = await generateCoverLetter(resumeText, title, description);
        const parts = [
          `🎯 <b>Збіг ${score}/100</b>`,
          `<b>${escapeHtml(title)}</b>`,
          escapeHtml(reason),
        ];
        if (coverLetter) {
          parts.push(`\n📝 <b>Супровідний лист:</b>\n<pre>${escapeHtml(coverLetter)}</pre>`);
        }
        parts.push(`\n🔗 ${link}`);
        await sendTelegram(parts.join("\n"));

        if (sheetsToken) {
          await appendRows(sheetsToken, [
            [new Date().toISOString().slice(0, 10), score, title, link, reason, coverLetter, ""],
          ]);
        }
      }
    }
  }

  saveSeen(seen);
  console.log(`Done. New listings: ${newCount}, matches sent: ${matchCount}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
