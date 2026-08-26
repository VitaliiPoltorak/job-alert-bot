// backfill-telegram-history.mjs
// One-off transfer of already-sent Telegram job listings into Google Sheets —
// without a single call to the Anthropic API. Data source: a chat history
// export from Telegram Desktop (Settings → chat with the bot → ⋮ → Export
// chat history → JSON format), which already contains the full text of the
// bot's past messages.
//
// Run: node backfill-telegram-history.mjs path/to/result.json
// Environment variables (same as for writing to the sheet from fetch-jobs.mjs):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
//   GOOGLE_SHEET_ID
//   GOOGLE_SHEET_NAME (defaults to "Sheet1")
//
// Handles both the old (Russian) and current (Ukrainian) bot message labels,
// since a single export can contain history sent under either format.

import { readFileSync } from "node:fs";
import { googleSheetsEnabled, getGoogleAccessToken, ensureSheetHeader, getExistingLinks, appendRows } from "./google-sheets.mjs";

function flattenText(text) {
  if (typeof text === "string") return text;
  if (Array.isArray(text)) {
    return text.map((part) => (typeof part === "string" ? part : part.text ?? "")).join("");
  }
  return "";
}

// Parses a bot message of the form:
// 🎯 Match 90/100 (or the old "Совпадение 90/100")
// Job title
// Match reason
//
// 📝 Cover letter: (or the old "Сопроводительное письмо:")
// Letter text
//
// 🔗 https://link
//
// The cover letter block is optional (older messages may not have one).
function parseBotMessage(text) {
  const lines = text.split("\n");
  if (lines.length < 3) return null;

  const scoreMatch = lines[0].match(/(?:Збіг|Совпадение)\s*(\d+)\s*\/\s*100/);
  if (!scoreMatch) return null;
  const score = Number(scoreMatch[1]);
  const title = (lines[1] ?? "").trim();
  if (!title) return null;

  const linkLineIdx = lines.findIndex((l) => l.trim().startsWith("🔗"));
  if (linkLineIdx === -1) return null;
  const link = lines[linkLineIdx].replace(/^[^\S\n]*🔗\s*/, "").trim();
  if (!link) return null;

  const coverLetterHeaderIdx = lines.findIndex(
    (l) => l.includes("Супровідний лист") || l.includes("Сопроводительное письмо")
  );
  let reasonLines;
  let coverLetter = "";
  if (coverLetterHeaderIdx !== -1) {
    reasonLines = lines.slice(2, coverLetterHeaderIdx).filter((l) => l.trim() !== "");
    coverLetter = lines
      .slice(coverLetterHeaderIdx + 1, linkLineIdx)
      .filter((l) => l.trim() !== "")
      .join("\n")
      .trim();
  } else {
    reasonLines = lines.slice(2, linkLineIdx).filter((l) => l.trim() !== "");
  }
  const reason = reasonLines.join(" ").trim();

  return { score, title, reason, coverLetter, link };
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error("Usage: node backfill-telegram-history.mjs path/to/result.json");
    process.exit(1);
  }
  if (!googleSheetsEnabled()) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY / GOOGLE_SHEET_ID are not set"
    );
  }

  const exportData = JSON.parse(readFileSync(filePath, "utf-8"));
  const messages = exportData.messages ?? [];
  console.log(`Messages in export: ${messages.length}`);

  const parsed = [];
  for (const msg of messages) {
    if (msg.type !== "message") continue;
    const text = flattenText(msg.text);
    if (!text.startsWith("🎯")) continue;
    const match = parseBotMessage(text);
    if (!match) {
      console.error("Failed to parse message, skipping:", text.slice(0, 80));
      continue;
    }
    const date = (msg.date ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10);
    parsed.push([date, match.score, match.title, match.link, match.reason, match.coverLetter, ""]);
  }
  console.log(`Listings recognized: ${parsed.length}`);

  const accessToken = await getGoogleAccessToken();
  if (!accessToken) throw new Error("Failed to get a Google access token");

  await ensureSheetHeader(accessToken);
  const existingLinks = await getExistingLinks(accessToken);

  const newRows = parsed.filter((row) => !existingLinks.has(row[3]));
  console.log(`Already in the sheet: ${parsed.length - newRows.length}, adding: ${newRows.length}`);

  await appendRows(accessToken, newRows);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
