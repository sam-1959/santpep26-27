#!/usr/bin/env node
// Baixa el calendari ICS de partits, el converteix a JSON i actualitza el
// bloc de dades incrustat a partits.html. Pensat per executar-se en un
// GitHub Action (o localment amb `node scripts/update-partits.js`).
//
// No regenera el HTML/CSS/JS de la pàgina: només substitueix el contingut
// del bloc <script id="partitsData" type="application/json">…</script>.

const fs = require("fs");
const path = require("path");
const https = require("https");

// Dos calendaris: masculí i femení.
const CALENDARS = [
  {
    sex: "M",
    url: "https://calendar.google.com/calendar/ical/e6e366d49523bee10af33b961767a8c3228b60cb30066e3fdc04704077f65a9f%40group.calendar.google.com/public/basic.ics",
  },
  {
    sex: "F",
    url: "https://calendar.google.com/calendar/ical/6vssihbaio24d4s1220h8km6v8%40group.calendar.google.com/public/basic.ics",
  },
];

// Categories pròpies per sigla: nom, família de filtre i gènere.
const OWN = {
  // Masculí
  IAM: { team: "Infantil A", fam: "INFANTIL", sex: "M" },
  IBM: { team: "Infantil B", fam: "INFANTIL", sex: "M" },
  PBM: { team: "Premini B",  fam: "PREMINI",  sex: "M" },
  PAM: { team: "Premini A",  fam: "PREMINI",  sex: "M" },
  MAM: { team: "Mini A",     fam: "MINI",     sex: "M" },
  MBM: { team: "Mini B",     fam: "MINI",     sex: "M" },
  CAM: { team: "Cadet A",    fam: "CADET",    sex: "M" },
  CBM: { team: "Cadet B",    fam: "CADET",    sex: "M" },
  JAM: { team: "Júnior A",   fam: "JÚNIOR",   sex: "M" },
  JBM: { team: "Júnior B",   fam: "JÚNIOR",   sex: "M" },
  SAM: { team: "Sènior A",   fam: "SÈNIOR",   sex: "M" },
  SBM: { team: "Sènior B",   fam: "SÈNIOR",   sex: "M" },
  // Femení
  IF:  { team: "Infantil",   fam: "INFANTIL", sex: "F" },
  MF:  { team: "Mini",       fam: "MINI",     sex: "F" },
  CF:  { team: "Cadet",      fam: "CADET",    sex: "F" },
  JAF: { team: "Júnior A",   fam: "JÚNIOR",   sex: "F" },
  JBF: { team: "Júnior B",   fam: "JÚNIOR",   sex: "F" },
  SAF: { team: "Sènior A",   fam: "SÈNIOR",   sex: "F" },
};

// Només mostrem partits a partir d'aquesta data (inici temporada 26-27).
const FROM = Date.UTC(2026, 7, 1); // 1 d'agost de 2026

// Correccions manuals de pavelló. El calendari de Google situa alguns partits
// locals a La Colina, però es juguen en una altra pista pròpia del club (p. ex.
// quan hi ha més de 3 partits locals alhora, els que sobren van a Montigalà).
// Clau: "dateISO|sigla" → { loc, home } (home força que compti com a local).
const VENUE_OVERRIDES = {
  "2026-09-13|IF":  { loc: "Pavelló de Montigalà", home: true }, // Infantil femení
  "2026-09-13|IBM": { loc: "Pavelló de Montigalà", home: true }, // Infantil B masculí
  "2026-09-13|IAM": { loc: "Pavelló de Montigalà", home: true }, // Infantil A masculí
};

// Ordre manual de les files dins d'una franja de la graella de casa. Per
// defecte els partits d'una mateixa hora s'ordenen per nom d'equip; aquí es
// pot forçar l'ordre desitjat (de dalt a baix). Clau: "dateISO|time".
const ROW_ORDER = {
  "2026-09-13|19:30": ["Infantil A", "Cadet B"], // Infantil A a dalt, Cadet B a sota
};

// Costos manuals dels partits amistosos. Clau: "sigla|rival normalitzat".
const FRIENDLY_COSTS = {
  "JAM|MANRESA": 17,
  "JAM|LLUISOS": 14.5,
  "JBM|CN TERRASSA": 25,
  "PAM|AB PREMIA": 12.5,
  "PAM|ALELLA": 15,
  "SAM|CERDANYOLA": 23.5,
  "SAM|MONTCADA": 21,
  "IAM|GRUP BARNA": 11.5,
  "JAF|LLUISOS": 14.5,
  "JBF|LLUISOS": 18,
};

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "santpep26-27-bot" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return resolve(fetchText(res.headers.location));
        }
        if (res.statusCode !== 200) {
          return reject(new Error("HTTP " + res.statusCode + " en baixar l'ICS"));
        }
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          const utf8 = body.toString("utf8");
          resolve(utf8.includes("\uFFFD") ? body.toString("latin1") : utf8);
        });
      })
      .on("error", reject);
  });
}

function field(block, name) {
  const m = block.match(new RegExp(name + "[^:]*:(.*)"));
  return m ? m[1].trim() : "";
}

function parseDTStart(s) {
  const m = s.match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  const [, Y, Mo, D, h, mi, se, z] = m;
  if (h === undefined) return { allday: true };
  if (z === "Z") return { allday: false, d: new Date(Date.UTC(+Y, +Mo - 1, +D, +h, +mi, +se)) };
  return { allday: false, d: new Date(+Y, +Mo - 1, +D, +h, +mi, +se) };
}

// Components de data/hora en horari de Madrid (gestiona canvi d'hora).
function madrid(d) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  });
  const p = {};
  f.formatToParts(d).forEach((x) => (p[x.type] = x.value));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, wd: p.weekday };
}

function cleanLoc(loc) {
  if (!loc) return "";
  return cleanText(loc).replace(/\\,/g, ",").split(",")[0].trim();
}

function cleanText(value) {
  return String(value || "")
    .replace(/\uFFFD/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function mondayISO(dateStr) {
  const [Y, M, D] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(Y, M - 1, D));
  const wd = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - wd);
  return dt.toISOString().slice(0, 10);
}

function parseCalendar(ics) {
  const raw = ics.replace(/\r?\n[ \t]/g, ""); // unfold RFC5545
  const events = [...raw.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)].map((m) => m[1]);
  const wdmap = { Sat: 6, Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5 };

  return events
    .map((b) => ({
      sum: field(b, "SUMMARY"),
      loc: field(b, "LOCATION"),
      start: parseDTStart(field(b, "DTSTART")),
    }))
    .filter((e) => e.start && !e.start.allday && e.start.d.getTime() >= FROM)
    .map((e) => {
      // La 🤝 al títol marca un partit amistós.
      const friendly = /🤝/.test(e.sum);
      const s = cleanText(e.sum).replace(/🏀|🤝|🍼/g, "").trim();
      const parts = s.split(/\s+Vs\s+/i).map((x) => x.trim());
      let ownSide = -1, sigla = "";
      parts.forEach((p, i) => { if (OWN[p]) { ownSide = i; sigla = p; } });
      if (ownSide < 0) return null; // partit sense equip propi identificable
      const rival = cleanText(parts[ownSide === 0 ? 1 : 0] || "");
      let home = /LA COLINA|GRAN BRETANYA/i.test(e.loc); // casa = pavelló propi
      const M = madrid(e.start.d);
      const info = OWN[sigla];
      let loc = cleanLoc(e.loc);

      // Aplica correcció manual de pavelló si n'hi ha per aquest partit
      const ov = VENUE_OVERRIDES[M.date + "|" + sigla];
      if (ov) {
        if (ov.loc != null) loc = ov.loc;
        if (ov.home != null) home = ov.home;
      }

      const cost = friendly ? friendlyCost(sigla, rival) : null;
      return {
        date: M.date, dow: wdmap[M.wd], time: M.time,
        team: info.team, fam: info.fam, sex: info.sex,
        rival, home, loc,
        ...(friendly ? { friendly: true } : {}),
        ...(cost != null ? { cost } : {}),
      };
    })
    .filter(Boolean);
}

function buildData(calendars) {
  // calendars: [{ ics }] — s'uneixen tots els partits dels dos gèneres
  // Índex d'ordre manual per franja (ROW_ORDER): retorna la posició de l'equip
  // dins la llista forçada, o Infinity si no hi és (queda darrere).
  const rowRank = (g) => {
    const order = ROW_ORDER[g.date + "|" + g.time];
    if (!order) return null;
    const i = order.indexOf(g.team);
    return i < 0 ? Infinity : i;
  };

  const games = calendars
    .flatMap((c) => parseCalendar(c.ics))
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      if (a.time !== b.time) return a.time < b.time ? -1 : 1;
      // Ordre manual de files dins la mateixa franja, si està definit.
      const ra = rowRank(a), rb = rowRank(b);
      if (ra !== null && rb !== null && ra !== rb) return ra - rb;
      if (a.sex !== b.sex) return a.sex < b.sex ? -1 : 1;
      if (a.team !== b.team) return a.team < b.team ? -1 : 1;
      if (a.rival !== b.rival) return a.rival < b.rival ? -1 : 1;
      return 0;
    });

  const byWeek = {};
  games.forEach((g) => {
    const wk = mondayISO(g.date);
    (byWeek[wk] = byWeek[wk] || []).push(g);
  });
  const weeks = Object.keys(byWeek)
    .sort()
    .map((w) => ({ monday: w, games: byWeek[w] }));

  return { weeks };
}

function allGames(data) {
  return (data.weeks || []).flatMap((w) => w.games || []);
}

function gameKey(g) {
  return [g.date, g.time, cleanText(g.team), g.sex, cleanText(g.rival), cleanText(g.loc), g.home ? "home" : "away", g.friendly ? "friendly" : ""].join("|");
}

function normalizeHistoryText(value) {
  return String(value || "")
    .replace(/\uFFFD/g, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function isLocationSimplification(oldLoc, newLoc) {
  const oldText = normalizeHistoryText(oldLoc);
  const newText = normalizeHistoryText(newLoc);
  if (!oldText || !newText || oldText === newText) return true;
  if (oldText.startsWith(newText + ",") || oldText.startsWith(newText + " |")) return true;
  if (newText.startsWith(oldText + ",") || newText.startsWith(oldText + " |")) return true;
  if (oldText.includes("MONTIGALA") && newText.includes("MONTIGALA")) return true;
  return false;
}

function friendlyCost(sigla, rival) {
  const exact = FRIENDLY_COSTS[sigla + "|" + normalizeHistoryText(rival)];
  if (exact != null) return exact;

  const normalizedRival = normalizeHistoryText(rival)
    .replace(/\bCB\b/g, "")
    .replace(/\bCLUB BASQUET\b/g, "")
    .replace(/\bBASQUET\b/g, "")
    .replace(/\bDE GRACIA\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const loose = Object.entries(FRIENDLY_COSTS).find(([key]) => {
    const [keySigla, keyRival] = key.split("|");
    return keySigla === sigla && normalizedRival.includes(keyRival);
  });
  return loose ? loose[1] : null;
}

function historyGameKey(g) {
  return [
    g.date,
    g.time,
    normalizeHistoryText(g.team),
    g.sex,
    normalizeHistoryText(g.rival),
    normalizeHistoryText(g.loc),
    g.home ? "home" : "away",
    g.friendly ? "friendly" : "",
  ].join("|");
}

function identityKey(g) {
  return [normalizeHistoryText(g.team), g.sex, normalizeHistoryText(g.rival)].join("|");
}

function changedFields(oldGame, newGame) {
  const fields = [];
  if (oldGame.date !== newGame.date) fields.push({ label: "Data", from: oldGame.date, to: newGame.date });
  if (oldGame.time !== newGame.time) fields.push({ label: "Hora", from: oldGame.time, to: newGame.time });
  if ((oldGame.loc || "") !== (newGame.loc || "") && !isLocationSimplification(oldGame.loc, newGame.loc)) {
    fields.push({ label: "Lloc", from: oldGame.loc || "sense lloc", to: newGame.loc || "sense lloc" });
  }
  if (!!oldGame.home !== !!newGame.home) fields.push({ label: "Casa/fora", from: oldGame.home ? "casa" : "fora", to: newGame.home ? "casa" : "fora" });
  if (!!oldGame.friendly !== !!newGame.friendly) fields.push({ label: "Tipus", from: oldGame.friendly ? "amistós" : "oficial", to: newGame.friendly ? "amistós" : "oficial" });
  return fields;
}

function gameSnapshot(g) {
  return {
    date: g.date,
    time: g.time,
    team: g.team,
    sex: g.sex,
    rival: g.rival,
    home: !!g.home,
    loc: g.loc || "",
    friendly: !!g.friendly,
  };
}

function buildChangeList(oldData, newData) {
  const oldGames = allGames(oldData);
  const newGames = allGames(newData);
  const oldExact = new Set(oldGames.map(historyGameKey));
  const newExact = new Set(newGames.map(historyGameKey));
  const addedRaw = newGames.filter((g) => !oldExact.has(historyGameKey(g)));
  const removedRaw = oldGames.filter((g) => !newExact.has(historyGameKey(g)));

  const removedByIdentity = new Map();
  removedRaw.forEach((g) => {
    const k = identityKey(g);
    if (!removedByIdentity.has(k)) removedByIdentity.set(k, []);
    removedByIdentity.get(k).push(g);
  });

  const changes = [];
  const usedRemoved = new Set();

  addedRaw.forEach((g) => {
    const candidates = removedByIdentity.get(identityKey(g)) || [];
    const old = candidates.find((x) => !usedRemoved.has(x) && changedFields(x, g).length);
    if (old) {
      usedRemoved.add(old);
      changes.push({ type: "changed", game: gameSnapshot(g), fields: changedFields(old, g) });
    } else {
      changes.push({ type: "added", game: gameSnapshot(g) });
    }
  });

  removedRaw
    .filter((g) => !usedRemoved.has(g))
    .forEach((g) => changes.push({ type: "removed", game: gameSnapshot(g) }));

  return changes;
}

function changeKey(change) {
  const fields = (change.fields || [])
    .map((field) => [field.label, field.from, field.to].join("="))
    .join(";");
  return [change.type, historyGameKey(change.game || {}), fields].join("||");
}

function hasEncodingNoise(change) {
  const game = change.game || {};
  return [game.team, game.rival, game.loc]
    .concat((change.fields || []).flatMap((field) => [field.from, field.to]))
    .some((value) => String(value || "").includes("\uFFFD"));
}

function collapseAddedRemovedPairs(changes) {
  const result = [];
  const used = new Set();

  changes.forEach((change, index) => {
    if (used.has(index)) return;
    if (change.type !== "added") {
      result.push(change);
      return;
    }

    const addedGame = change.game || {};
    const removedIndex = changes.findIndex((candidate, candidateIndex) => {
      if (candidateIndex <= index || used.has(candidateIndex) || candidate.type !== "removed") return false;
      return identityKey(candidate.game || {}) === identityKey(addedGame);
    });

    if (removedIndex === -1) {
      result.push(change);
      return;
    }

    const removed = changes[removedIndex];
    const fields = changedFields(removed.game || {}, addedGame);
    used.add(removedIndex);
    if (fields.length) {
      result.push({
        type: "changed",
        game: gameSnapshot(addedGame),
        fields,
        importedAt: change.importedAt || removed.importedAt,
      });
    }
  });

  return result;
}

function looseGameKey(change) {
  const game = change.game || {};
  return [
    game.date,
    game.time,
    normalizeHistoryText(game.team),
    game.sex,
    normalizeHistoryText(game.rival).replace(/O/g, ""),
    normalizeHistoryText(game.loc),
    game.home ? "home" : "away",
    game.friendly ? "friendly" : "",
  ].join("|");
}

function mergeChangeHistory(oldData, newChanges, importedAt) {
  const previousImportedAt = oldData.latestChanges?.importedAt || importedAt;
  const previousChanges = Array.isArray(oldData.latestChanges?.changes)
    ? oldData.latestChanges.changes.map((change) => ({
        ...change,
        importedAt: change.importedAt || previousImportedAt,
      }))
    : [];
  if (!newChanges.length && !previousChanges.length) return null;

  const stampedNewChanges = newChanges.map((change) => ({
    ...change,
    importedAt,
  }));
  const combined = collapseAddedRemovedPairs([...stampedNewChanges, ...previousChanges])
    .filter((change) => !hasEncodingNoise(change));
  const looseAdded = new Map();
  const looseRemoved = new Map();
  combined.forEach((change) => {
    const key = looseGameKey(change);
    if (change.type === "added") {
      if (!looseAdded.has(key)) looseAdded.set(key, new Set());
      looseAdded.get(key).add(historyGameKey(change.game || {}));
    }
    if (change.type === "removed") {
      if (!looseRemoved.has(key)) looseRemoved.set(key, new Set());
      looseRemoved.get(key).add(historyGameKey(change.game || {}));
    }
  });
  const encodingOnlyPairs = new Set();
  looseAdded.forEach((addedKeys, key) => {
    const removedKeys = looseRemoved.get(key);
    if (!removedKeys) return;
    const exactOverlap = [...addedKeys].some((item) => removedKeys.has(item));
    if (!exactOverlap) encodingOnlyPairs.add(key);
  });
  const removedGameKeys = new Set(
    combined
      .filter((change) => change.type === "removed")
      .map((change) => historyGameKey(change.game || {}))
  );

  const seen = new Set();
  const visibleGames = new Set();
  const changes = [];
  combined.forEach((change) => {
    const looseKey = looseGameKey(change);
    if (
      (change.type === "added" || change.type === "removed") &&
      encodingOnlyPairs.has(looseKey)
    ) return;
    const gameHistoryKey = historyGameKey(change.game || {});
    if (change.type === "added" && removedGameKeys.has(gameHistoryKey)) return;
    if (change.type === "removed" && visibleGames.has(gameHistoryKey)) return;
    const key = changeKey(change);
    if (seen.has(key)) return;
    seen.add(key);
    if (change.type !== "removed") visibleGames.add(gameHistoryKey);
    changes.push(change);
  });

  return {
    importedAt: newChanges.length ? importedAt : oldData.latestChanges?.importedAt || importedAt,
    changes,
  };
}

async function main() {
  const pagePath = path.join(__dirname, "..", "partits.html");
  const html = fs.readFileSync(pagePath, "utf8");
  const re = /(<script id="partitsData"[^>]*>)([\s\S]*?)(<\/script>)/;
  const current = html.match(re);
  if (!current) {
    throw new Error("No s'ha trobat el bloc partitsData a partits.html");
  }
  const oldData = JSON.parse(current[2]);

  const calendars = await Promise.all(
    CALENDARS.map(async (c) => ({ sex: c.sex, ics: await fetchText(c.url) }))
  );
  const data = buildData(calendars);
  const latestChanges = buildChangeList(oldData, data);
  const mergedChanges = mergeChangeHistory(oldData, latestChanges, new Date().toISOString());
  if (mergedChanges) data.latestChanges = mergedChanges;
  const json = JSON.stringify(data);

  const out = html.replace(re, (_, open, _old, close) => open + json + close);

  if (out === html) {
    console.log("Sense canvis: les dades ja estaven al dia.");
    return;
  }
  fs.writeFileSync(pagePath, out);
  const total = data.weeks.reduce((a, w) => a + w.games.length, 0);
  console.log(`Actualitzat partits.html: ${data.weeks.length} caps de setmana, ${total} partits.`);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
