// fetch-jobs.mjs
// Проверяет RSS-ленты вакансий (Djinni + DOU), сравнивает новые вакансии
// с резюме через Claude API и шлёт подходящие в Telegram.
//
// Запуск: node fetch-jobs.mjs
// Требуемые переменные окружения (см. README.md):
//   ANTHROPIC_API_KEY
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";

// ---------- НАСТРОЙКИ ----------

// Список RSS-фидов, которые проверяем. Добавляй/убирай строки под себя.
const FEEDS = [
  // Djinni — фильтр по одному ключевому слову за раз
  "https://djinni.co/jobs/rss/?primary_keyword=React.js",
  "https://djinni.co/jobs/rss/?primary_keyword=Node.js",
  "https://djinni.co/jobs/rss/?primary_keyword=Fullstack",
  "https://djinni.co/jobs/rss/?primary_keyword=JavaScript",

  // DOU — фильтр по категории
  "https://jobs.dou.ua/vacancies/feeds/?category=Front%20End",
  "https://jobs.dou.ua/vacancies/feeds/?category=Node.js",
];

// Порог релевантности (0-100), выше которого шлём уведомление
const MATCH_THRESHOLD = 65;

// Модель для оценки соответствия
const MODEL = "claude-sonnet-4-6";

// ---------- СЛУЖЕБНОЕ ----------

const STATE_PATH = new URL("./seen.json", import.meta.url);
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
  // Храним только последние 2000 ссылок, чтобы файл не разрастался бесконечно
  const arr = Array.from(seenSet).slice(-2000);
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
    // Дефолтный лимит в 1000 расширений сущностей (защита от entity-expansion
    // атак) слишком мал для реальных RSS-описаний вакансий — поднимаем его.
    processEntities: { enabled: true, maxTotalExpansions: 10000, maxExpandedLength: 1000000 },
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

// Экранирование для Telegram parse_mode=HTML (title/description из RSS
// могут содержать &, <, > и т.д.)
function escapeHtml(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function scoreMatch(resumeText, jobTitle, jobDescription) {
  const prompt = `Ты помогаешь оценить соответствие вакансии резюме кандидата.

РЕЗЮМЕ:
${resumeText}

ВАКАНСИЯ:
Название: ${jobTitle}
Описание: ${jobDescription.slice(0, 3000)}

Оцени соответствие от 0 до 100, где 100 — идеальное совпадение стека и уровня опыта.
Ответь СТРОГО в формате JSON без markdown-разметки:
{"score": <число>, "reason": "<1 короткое предложение на русском, почему>"}`;

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
    return { score: 0, reason: "ошибка оценки" };
  }

  const data = await res.json();
  const text = data.content?.find((c) => c.type === "text")?.text ?? "{}";
  const clean = text.replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    console.error("Failed to parse model output:", text);
    return { score: 0, reason: "не удалось разобрать ответ модели" };
  }
}

async function generateCoverLetter(resumeText, jobTitle, jobDescription) {
  const prompt = `Ты помогаешь кандидату написать сопроводительное письмо для отклика на вакансию.

РЕЗЮМЕ:
${resumeText}

ВАКАНСИЯ:
Название: ${jobTitle}
Описание: ${jobDescription.slice(0, 3000)}

Определи язык, на котором написан текст вакансии (название + описание), и напиши
сопроводительное письмо на ЭТОМ ЖЕ языке (например, если вакансия на английском —
письмо на английском, если на украинском — на украинском, если на русском — на русском).
Письмо короткое (2-4 предложения), от первого лица, без приветствий и подписи
типа "С уважением"/"Best regards" — только текст письма.
Упомяни 2-3 самых релевантных для этой вакансии навыка/проекта из резюме.
Ответь СТРОГО в формате JSON без markdown-разметки:
{"coverLetter": "<текст письма на языке вакансии>"}`;

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

// ---------- ОСНОВНОЙ ПРОЦЕСС ----------

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY не задан");
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN не задан");
  if (!process.env.TELEGRAM_CHAT_ID) throw new Error("TELEGRAM_CHAT_ID не задан");

  const resumeText = readFileSync(RESUME_PATH, "utf-8");
  const seen = loadSeen();
  let newCount = 0;
  let matchCount = 0;

  for (const feedUrl of FEEDS) {
    console.log(`Проверяю: ${feedUrl}`);
    const items = await fetchFeed(feedUrl);

    for (const item of items) {
      const link = String(item.link ?? "").trim();
      const title = stripHtml(item.title);
      const description = stripHtml(item.description ?? item["content:encoded"] ?? "");

      if (!link || seen.has(link)) continue;
      seen.add(link);
      newCount++;

      const { score, reason } = await scoreMatch(resumeText, title, description);
      console.log(`  [${score}] ${title}`);

      if (score >= MATCH_THRESHOLD) {
        matchCount++;
        const { coverLetter } = await generateCoverLetter(resumeText, title, description);
        const parts = [
          `🎯 <b>Совпадение ${score}/100</b>`,
          `<b>${escapeHtml(title)}</b>`,
          escapeHtml(reason),
        ];
        if (coverLetter) {
          parts.push(`\n📝 <b>Сопроводительное письмо:</b>\n${escapeHtml(coverLetter)}`);
        }
        parts.push(`\n🔗 ${link}`);
        await sendTelegram(parts.join("\n"));
      }
    }
  }

  saveSeen(seen);
  console.log(`Готово. Новых вакансий: ${newCount}, совпадений отправлено: ${matchCount}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
