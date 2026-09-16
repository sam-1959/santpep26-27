#!/usr/bin/env node
// Envia per WhatsApp (Twilio) un resum dels canvis detectats a partits.html.
// S'executa despres de regenerar partits.html i abans de fer commit.

const fs = require("fs");
const https = require("https");
const { execFileSync } = require("child_process");

const PAGE_URL = "https://sam-1959.github.io/santpep26-27/partits.html";

function requiredEnv(name) {
  return (process.env[name] || "").trim();
}

function extractData(html) {
  const m = html.match(/<script id="partitsData"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("No s'ha trobat el bloc partitsData");
  return JSON.parse(m[1]);
}

function allGames(data) {
  return data.weeks.flatMap((w) => w.games || []);
}

function gameKey(g) {
  return [g.date, g.time, g.team, g.sex, g.rival, g.loc || "", g.home ? "home" : "away", g.friendly ? "friendly" : ""].join("|");
}

function identityKey(g) {
  return [g.team, g.sex, g.rival].join("|");
}

function shortGame(g) {
  const sex = g.sex === "F" ? "F" : "M";
  const where = g.home ? "casa" : "fora";
  const friendly = g.friendly ? " [amistos]" : "";
  const loc = g.loc ? `, ${g.loc}` : "";
  return `${g.date} ${g.time} - ${g.team} ${sex} vs ${g.rival} (${where}${loc})${friendly}`;
}

function changedFields(oldGame, newGame) {
  const fields = [];
  if (oldGame.date !== newGame.date) fields.push(`data ${oldGame.date} -> ${newGame.date}`);
  if (oldGame.time !== newGame.time) fields.push(`hora ${oldGame.time} -> ${newGame.time}`);
  if ((oldGame.loc || "") !== (newGame.loc || "")) fields.push(`lloc ${(oldGame.loc || "sense lloc")} -> ${(newGame.loc || "sense lloc")}`);
  if (!!oldGame.home !== !!newGame.home) fields.push(`casa/fora ${oldGame.home ? "casa" : "fora"} -> ${newGame.home ? "casa" : "fora"}`);
  if (!!oldGame.friendly !== !!newGame.friendly) fields.push(`tipus ${oldGame.friendly ? "amistos" : "oficial"} -> ${newGame.friendly ? "amistos" : "oficial"}`);
  return fields;
}

function buildSummary(oldGames, newGames) {
  const oldExact = new Set(oldGames.map(gameKey));
  const newExact = new Set(newGames.map(gameKey));
  const addedRaw = newGames.filter((g) => !oldExact.has(gameKey(g)));
  const removedRaw = oldGames.filter((g) => !newExact.has(gameKey(g)));

  const removedByIdentity = new Map();
  removedRaw.forEach((g) => {
    const k = identityKey(g);
    if (!removedByIdentity.has(k)) removedByIdentity.set(k, []);
    removedByIdentity.get(k).push(g);
  });

  const changed = [];
  const added = [];
  const usedRemoved = new Set();

  addedRaw.forEach((g) => {
    const candidates = removedByIdentity.get(identityKey(g)) || [];
    const match = candidates.find((old) => !usedRemoved.has(old) && changedFields(old, g).length);
    if (match) {
      usedRemoved.add(match);
      changed.push({ old: match, next: g, fields: changedFields(match, g) });
    } else {
      added.push(g);
    }
  });

  const removed = removedRaw.filter((g) => !usedRemoved.has(g));
  return { added, removed, changed };
}

function buildMessage(summary) {
  const lines = ["Canvis al calendari de partits:"];

  summary.changed.forEach((c) => {
    lines.push("", `Canvi: ${c.next.team} ${c.next.sex} vs ${c.next.rival}`);
    c.fields.forEach((f) => lines.push(`- ${f}`));
    lines.push(`- actual: ${shortGame(c.next)}`);
  });

  summary.added.forEach((g) => {
    lines.push("", `Afegit: ${shortGame(g)}`);
  });

  summary.removed.forEach((g) => {
    lines.push("", `Eliminat: ${shortGame(g)}`);
  });

  lines.push("", PAGE_URL);
  return lines.join("\n");
}

function buildTestMessage() {
  return [
    "Prova d'avisos WhatsApp del calendari de partits.",
    "",
    "Si reps aquest missatge, la connexió amb Twilio funciona correctament.",
    "",
    PAGE_URL,
  ].join("\n");
}

function parseRecipients(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).map((x) => x.trim()).filter(Boolean);
  } catch (_) {
    // Accepta tambe llista separada per comes o salts de linia.
  }
  return raw.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
}

function twilioRequest({ sid, token, from, to, body }) {
  const data = new URLSearchParams({
    From: from,
    To: to.startsWith("whatsapp:") ? to : `whatsapp:${to}`,
    Body: body,
  }).toString();

  const auth = Buffer.from(`${sid}:${token}`).toString("base64");
  const req = {
    method: "POST",
    hostname: "api.twilio.com",
    path: `/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Content-Length": Buffer.byteLength(data),
    },
  };

  return new Promise((resolve, reject) => {
    const r = https.request(req, (res) => {
      let bodyText = "";
      res.on("data", (chunk) => (bodyText += chunk));
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(bodyText);
        else reject(new Error(`Twilio HTTP ${res.statusCode}: ${bodyText}`));
      });
    });
    r.on("error", reject);
    r.write(data);
    r.end();
  });
}

async function main() {
  const forceTest = /^(1|true|yes|si|sí)$/i.test(requiredEnv("WHATSAPP_FORCE_TEST"));

  let hasDiff = true;
  try {
    execFileSync("git", ["diff", "--quiet", "--", "partits.html"], { stdio: "ignore" });
    hasDiff = false;
  } catch (_) {
    hasDiff = true;
  }
  if (!hasDiff && !forceTest) {
    console.log("Sense canvis als partits: no s'envia WhatsApp.");
    return;
  }

  let message;
  if (forceTest) {
    message = buildTestMessage();
  } else {
    let oldHtml;
    try {
      oldHtml = execFileSync("git", ["show", "HEAD:partits.html"], { encoding: "utf8" });
    } catch (err) {
      throw new Error("No s'ha pogut llegir partits.html de HEAD");
    }

    const currentHtml = fs.readFileSync("partits.html", "utf8");
    const summary = buildSummary(allGames(extractData(oldHtml)), allGames(extractData(currentHtml)));
    const hasChanges = summary.added.length || summary.removed.length || summary.changed.length;
    if (!hasChanges) {
      console.log("No hi ha canvis de partits per notificar.");
      return;
    }
    message = buildMessage(summary);
  }

  const sid = requiredEnv("TWILIO_ACCOUNT_SID");
  const token = requiredEnv("TWILIO_AUTH_TOKEN");
  const fromRaw = requiredEnv("TWILIO_WHATSAPP_FROM");
  const testRecipient = requiredEnv("WHATSAPP_TEST_RECIPIENT");
  const recipients = testRecipient ? [testRecipient] : parseRecipients(requiredEnv("WHATSAPP_RECIPIENTS"));
  console.log(message);

  if (!sid || !token || !fromRaw || recipients.length === 0) {
    console.log("Falten secrets de Twilio: s'omet l'enviament de WhatsApp.");
    return;
  }

  const from = fromRaw.startsWith("whatsapp:") ? fromRaw : `whatsapp:${fromRaw}`;
  for (const to of recipients) {
    await twilioRequest({ sid, token, from, to, body: message });
    console.log(`WhatsApp enviat a ${to}`);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
