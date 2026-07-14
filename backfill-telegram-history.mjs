// backfill-telegram-history.mjs
// Разовый перенос уже отправленных в Telegram вакансий в Google Sheets —
// без единого обращения к Anthropic API. Источник данных — экспорт истории
// чата из Telegram Desktop (Settings → чат с ботом → ⋮ → Export chat history
// → формат JSON), в котором уже есть весь текст прошлых сообщений бота.
//
// Запуск: node backfill-telegram-history.mjs путь/к/result.json
// Переменные окружения (те же, что для записи в таблицу из fetch-jobs.mjs):
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
//   GOOGLE_SHEET_ID
//   GOOGLE_SHEET_NAME (по умолчанию "Sheet1")

import { readFileSync } from "node:fs";
import { googleSheetsEnabled, getGoogleAccessToken, ensureSheetHeader, getExistingLinks, appendRows } from "./google-sheets.mjs";

function flattenText(text) {
  if (typeof text === "string") return text;
  if (Array.isArray(text)) {
    return text.map((part) => (typeof part === "string" ? part : part.text ?? "")).join("");
  }
  return "";
}

// Разбирает текст сообщения бота вида:
// 🎯 Совпадение 90/100
// Название вакансии
// Причина совпадения
//
// 📝 Сопроводительное письмо:
// Текст письма
//
// 🔗 https://ссылка
//
// Блок с письмом опциональный (в старых сообщениях мог отсутствовать).
function parseBotMessage(text) {
  const lines = text.split("\n");
  if (lines.length < 3) return null;

  const scoreMatch = lines[0].match(/Совпадение\s*(\d+)\s*\/\s*100/);
  if (!scoreMatch) return null;
  const score = Number(scoreMatch[1]);
  const title = (lines[1] ?? "").trim();
  if (!title) return null;

  const linkLineIdx = lines.findIndex((l) => l.trim().startsWith("🔗"));
  if (linkLineIdx === -1) return null;
  const link = lines[linkLineIdx].replace(/^[^\S\n]*🔗\s*/, "").trim();
  if (!link) return null;

  const coverLetterHeaderIdx = lines.findIndex((l) => l.includes("Сопроводительное письмо"));
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
    console.error("Использование: node backfill-telegram-history.mjs путь/к/result.json");
    process.exit(1);
  }
  if (!googleSheetsEnabled()) {
    throw new Error(
      "Не заданы GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY / GOOGLE_SHEET_ID"
    );
  }

  const exportData = JSON.parse(readFileSync(filePath, "utf-8"));
  const messages = exportData.messages ?? [];
  console.log(`Сообщений в экспорте: ${messages.length}`);

  const parsed = [];
  for (const msg of messages) {
    if (msg.type !== "message") continue;
    const text = flattenText(msg.text);
    if (!text.startsWith("🎯")) continue;
    const match = parseBotMessage(text);
    if (!match) {
      console.error("Не удалось разобрать сообщение, пропускаю:", text.slice(0, 80));
      continue;
    }
    const date = (msg.date ?? "").slice(0, 10) || new Date().toISOString().slice(0, 10);
    parsed.push([date, match.score, match.title, match.link, match.reason, match.coverLetter, ""]);
  }
  console.log(`Распознано вакансий: ${parsed.length}`);

  const accessToken = await getGoogleAccessToken();
  if (!accessToken) throw new Error("Не удалось получить Google access token");

  await ensureSheetHeader(accessToken);
  const existingLinks = await getExistingLinks(accessToken);

  const newRows = parsed.filter((row) => !existingLinks.has(row[3]));
  console.log(`Уже есть в таблице: ${parsed.length - newRows.length}, добавляю: ${newRows.length}`);

  await appendRows(accessToken, newRows);
  console.log("Готово.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
