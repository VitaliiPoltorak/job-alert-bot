// google-sheets.mjs
// Shared helpers for writing to Google Sheets via a service account (JWT-bearer
// OAuth2 flow on built-in node:crypto, no googleapis SDK).
// Used both by fetch-jobs.mjs (writing new matches) and by
// backfill-telegram-history.mjs (transferring history from a Telegram export).
//
// Environment variables:
//   GOOGLE_SERVICE_ACCOUNT_EMAIL
//   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY
//   GOOGLE_SHEET_ID
//   GOOGLE_SHEET_NAME (defaults to "Sheet1")

import { createSign } from "node:crypto";

export const GOOGLE_SHEET_NAME = process.env.GOOGLE_SHEET_NAME || "Sheet1";
export const SHEET_HEADER = ["Date", "Score", "Job", "Link", "Reason", "Cover Letter", "Response Status"];

export function googleSheetsEnabled() {
  return Boolean(
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL &&
      process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY &&
      process.env.GOOGLE_SHEET_ID
  );
}

function base64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Get an access token via the OAuth2 JWT-bearer flow directly (no googleapis SDK),
// signing the JWT with the service account's private key using built-in node:crypto.
export async function getGoogleAccessToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, "\n");
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer
    .sign(privateKey)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    console.error("Google auth failed", res.status, await res.text());
    return null;
  }
  const data = await res.json();
  return data.access_token;
}

export async function ensureSheetHeader(accessToken) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const range = `${GOOGLE_SHEET_NAME}!A1:G1`;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    console.error("Sheets header check failed", res.status, await res.text());
    return;
  }
  const data = await res.json();
  if (data.values && data.values.length > 0) return;

  const putRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values: [SHEET_HEADER] }),
    }
  );
  if (!putRes.ok) {
    console.error("Sheets header write failed", putRes.status, await putRes.text());
  }
}

// Links (column D) already present in the sheet — used for dedup during backfill.
export async function getExistingLinks(accessToken) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const range = `${GOOGLE_SHEET_NAME}!D2:D`;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!res.ok) {
    console.error("Sheets read failed", res.status, await res.text());
    return new Set();
  }
  const data = await res.json();
  return new Set((data.values ?? []).map((row) => row[0]).filter(Boolean));
}

export async function appendRows(accessToken, rows) {
  if (rows.length === 0) return;
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const range = `${GOOGLE_SHEET_NAME}!A:G`;
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ values: rows }),
  });
  if (!res.ok) {
    console.error("Sheets append failed", res.status, await res.text());
  }
}
