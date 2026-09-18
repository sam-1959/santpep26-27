#!/usr/bin/env node
// Actualitza a Firebase la llista de jugadors/es amb quota anual de fisio
// pagada. Pensat per executar-se periòdicament amb GitHub Actions.

const https = require("https");

const FIREBASE_DB_URL =
  process.env.FIREBASE_DB_URL ||
  "https://coord-fa09e-default-rtdb.europe-west1.firebasedatabase.app";
const QUOTA_CACHE_PATH = "physioQuota/season-26-27";
const QUOTA_CSV_URL =
  "https://docs.google.com/spreadsheets/d/15Ep8VIQWEHi_ST9vbnDz6Y_97FBCT_uU/export?format=csv&gid=1209425339";

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "santpep26-27-quota-bot" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(fetchText(res.headers.location));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} en llegir ${url}`));
          return;
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      })
      .on("error", reject);
  });
}

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body || ""),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode} en escriure Firebase: ${text}`));
            return;
          }
          resolve(text);
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function firebaseUrl(path) {
  const base = FIREBASE_DB_URL.replace(/\/$/, "");
  const safePath = path.split("/").map(encodeURIComponent).join("/");
  const auth = process.env.FIREBASE_AUTH_TOKEN || process.env.FIREBASE_DATABASE_SECRET || "";
  return `${base}/${safePath}.json${auth ? `?auth=${encodeURIComponent(auth)}` : ""}`;
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function shortName(value) {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 2) return parts.join(" ") || "";
  return parts.slice(0, 2).join(" ");
}

function parseCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && line[i + 1] === '"') {
      current += '"';
      i++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function parsePaidQuotaNames(csv) {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const headers = lines.length ? parseCsvLine(lines[0]).map(normalizeName) : [];
  const nameIndex = headers.indexOf("nom complet");
  const quotaIndex = headers.indexOf("quota");
  const paidNames = [];

  lines
    .slice(1)
    .map(parseCsvLine)
    .filter((cells) => {
      const name = normalizeName(cells[nameIndex >= 0 ? nameIndex : 0]);
      const quota = Number(String(cells[quotaIndex >= 0 ? quotaIndex : 1] || "").replace(",", "."));
      return name && !/\b(total|femeni|masculi)\b/.test(name) && quota > 0;
    })
    .forEach((cells) => {
      const fullName = cells[nameIndex >= 0 ? nameIndex : 0];
      paidNames.push(normalizeName(fullName));
      paidNames.push(normalizeName(shortName(fullName)));
    });

  return Array.from(new Set(paidNames.filter(Boolean))).sort();
}

async function main() {
  const csv = await fetchText(QUOTA_CSV_URL);
  const paidNames = parsePaidQuotaNames(csv);
  const payload = {
    paidNames,
    updatedAt: new Date().toISOString(),
    source: "google-sheet",
    count: paidNames.length,
  };

  await request("PUT", firebaseUrl(QUOTA_CACHE_PATH), JSON.stringify(payload));
  console.log(`Quota actualitzada a Firebase: ${paidNames.length} claus de nom.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
