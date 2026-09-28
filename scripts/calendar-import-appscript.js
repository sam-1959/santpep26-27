// Google Apps Script — Importació de calendaris de partits a Firebase.
//
// Ús:
// 1) Copia aquest fitxer en un projecte d'Apps Script.
// 2) Executa `importarCalendarisPartits()` una vegada manualment.
// 3) Executa `crearTriggerImportacioCalendaris()` per programar-ho cada hora.
//
// Escriu a Firebase RTDB:
//   calendarGames/season-26-27

var FIREBASE_DB_URL = "https://coord-fa09e-default-rtdb.europe-west1.firebasedatabase.app";
var SEASON = "season-26-27";
var CALENDAR_FIREBASE_PATH = "calendarGames/" + SEASON;

var CALENDARS = [
  {
    sex: "M",
    url: "https://calendar.google.com/calendar/ical/e6e366d49523bee10af33b961767a8c3228b60cb30066e3fdc04704077f65a9f%40group.calendar.google.com/public/basic.ics",
  },
  {
    sex: "F",
    url: "https://calendar.google.com/calendar/ical/6vssihbaio24d4s1220h8km6v8%40group.calendar.google.com/public/basic.ics",
  },
];

var OWN = {
  IAM: { team: "Infantil A", fam: "INFANTIL", sex: "M" },
  IBM: { team: "Infantil B", fam: "INFANTIL", sex: "M" },
  PBM: { team: "Premini B", fam: "MINI", sex: "M" },
  PAM: { team: "Premini A", fam: "MINI", sex: "M" },
  MAM: { team: "Mini A", fam: "MINI", sex: "M" },
  MBM: { team: "Mini B", fam: "MINI", sex: "M" },
  CAM: { team: "Cadet A", fam: "CADET", sex: "M" },
  CBM: { team: "Cadet B", fam: "CADET", sex: "M" },
  JAM: { team: "Júnior A", fam: "JÚNIOR", sex: "M" },
  JBM: { team: "Júnior B", fam: "JÚNIOR", sex: "M" },
  SAM: { team: "Sènior A", fam: "SÈNIOR", sex: "M" },
  SBM: { team: "Sènior B", fam: "SÈNIOR", sex: "M" },
  IF: { team: "Infantil", fam: "INFANTIL", sex: "F" },
  MF: { team: "Mini", fam: "MINI", sex: "F" },
  CF: { team: "Cadet", fam: "CADET", sex: "F" },
  CBF: { team: "Cadet B", fam: "CADET", sex: "F" },
  JAF: { team: "Júnior A", fam: "JÚNIOR", sex: "F" },
  JBF: { team: "Júnior B", fam: "JÚNIOR", sex: "F" },
  SAF: { team: "Sènior A", fam: "SÈNIOR", sex: "F" },
};

var FROM = Date.UTC(2026, 7, 1);

var VENUE_OVERRIDES = {
  "2026-09-13|IF": { loc: "Pavelló de Montigalà", home: true },
  "2026-09-13|IBM": { loc: "Pavelló de Montigalà", home: true },
  "2026-09-13|IAM": { loc: "Pavelló de Montigalà", home: true },
};

var ROW_ORDER = {
  "2026-09-13|19:30": ["Infantil A", "Cadet B"],
};

var FRIENDLY_COSTS = {
  "JAM|MANRESA": 17,
  "JAM|LLUISOS": 14.5,
  "CAM|UE MONTGAT": 20,
  "JBM|CN TERRASSA": 25,
  "PAM|AB PREMIA": 12.5,
  "PAM|ALELLA": 15,
  "MAM|SESE": 22,
  "MBM|SESE": 10,
  "PBM|CERDANYOLA": 10,
  "SAM|CERDANYOLA": 23.5,
  "SAM|MONTCADA": 21,
  "SAM|CB VILADECANS": 25,
  "SBM|BOET": 20,
  "SAF|CB ARGENTONA": 20,
  "IAM|GRUP BARNA": 11.5,
  "CBF|GAVA": 25,
  "JAF|LLUISOS": 14.5,
  "JBF|LLUISOS": 18,
};

function firebaseUrl(pathName) {
  return FIREBASE_DB_URL.replace(/\/$/, "") + "/" + pathName.split("/").map(encodeURIComponent).join("/") + ".json";
}

function readFirebase(pathName) {
  var response = UrlFetchApp.fetch(firebaseUrl(pathName), {
    method: "get",
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() === 404) return null;
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error("Firebase GET " + response.getResponseCode() + ": " + response.getContentText());
  }
  var text = response.getContentText();
  return text && text !== "null" ? JSON.parse(text) : null;
}

function writeFirebase(pathName, value) {
  var response = UrlFetchApp.fetch(firebaseUrl(pathName), {
    method: "put",
    contentType: "application/json; charset=utf-8",
    payload: JSON.stringify(value),
    muteHttpExceptions: true,
  });
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error("Firebase PUT " + response.getResponseCode() + ": " + response.getContentText());
  }
}

function fetchText(url) {
  var response = UrlFetchApp.fetch(url, {
    method: "get",
    followRedirects: true,
    muteHttpExceptions: true,
    headers: { "User-Agent": "santpep26-27-appscript" },
  });
  if (response.getResponseCode() !== 200) {
    throw new Error("HTTP " + response.getResponseCode() + " en baixar l'ICS");
  }
  return response.getContentText("UTF-8").replace(/\uFFFD/g, "");
}

function field(block, name) {
  var m = block.match(new RegExp(name + "[^:]*:(.*)"));
  return m ? m[1].trim() : "";
}

function parseDTStart(s) {
  var m = String(s || "").match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  var Y = +m[1], Mo = +m[2], D = +m[3], h = m[4], mi = m[5], se = m[6], z = m[7];
  if (h === undefined) return { allday: true };
  if (z === "Z") return { allday: false, d: new Date(Date.UTC(Y, Mo - 1, D, +h, +mi, +se)) };
  return { allday: false, d: new Date(Y, Mo - 1, D, +h, +mi, +se) };
}

function madrid(d) {
  var formatted = Utilities.formatDate(d, "Europe/Madrid", "yyyy-MM-dd HH:mm EEE");
  var parts = formatted.split(" ");
  var wdmap = { Sat: 6, Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, sáb: 6, dom: 0, lun: 1, mar: 2, mié: 3, jue: 4, vie: 5 };
  return { date: parts[0], time: parts[1], wd: wdmap[parts[2]] };
}

function cleanText(value) {
  return String(value || "")
    .replace(/\uFFFD/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanLoc(loc) {
  if (!loc) return "";
  return cleanText(loc).replace(/\\,/g, ",").split(",")[0].trim();
}

function mondayISO(dateStr) {
  var p = dateStr.split("-").map(Number);
  var dt = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  var wd = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - wd);
  return dt.toISOString().slice(0, 10);
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

function friendlyCost(sigla, rival) {
  var exact = FRIENDLY_COSTS[sigla + "|" + normalizeHistoryText(rival)];
  if (exact != null) return exact;

  var normalizedRival = normalizeHistoryText(rival)
    .replace(/\bCB\b/g, "")
    .replace(/\bCLUB BASQUET\b/g, "")
    .replace(/\bBASQUET\b/g, "")
    .replace(/\bDE GRACIA\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  for (var key in FRIENDLY_COSTS) {
    var parts = key.split("|");
    if (parts[0] === sigla && normalizedRival.indexOf(parts[1]) !== -1) return FRIENDLY_COSTS[key];
  }
  return null;
}

function parseCalendar(ics) {
  var raw = String(ics || "").replace(/\r?\n[ \t]/g, "");
  var events = [];
  var re = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/g;
  var match;
  while ((match = re.exec(raw)) !== null) events.push(match[1]);
  var games = [];

  events.forEach(function(block) {
    var start = parseDTStart(field(block, "DTSTART"));
    if (!start || start.allday || start.d.getTime() < FROM) return;

    var summary = field(block, "SUMMARY");
    var friendly = /🤝/.test(summary);
    var s = cleanText(summary).replace(/🏀|🤝|🍼/g, "").trim();
    var parts = s.split(/\s+Vs\s+/i).map(function(x) { return x.trim(); });
    var ownSide = -1;
    var sigla = "";
    parts.forEach(function(part, index) {
      if (OWN[part]) {
        ownSide = index;
        sigla = part;
      }
    });
    if (ownSide < 0) return;

    var rival = cleanText(parts[ownSide === 0 ? 1 : 0] || "");
    var loc = cleanLoc(field(block, "LOCATION"));
    var home = /LA COLINA|GRAN BRETANYA/i.test(field(block, "LOCATION"));
    var M = madrid(start.d);
    var info = OWN[sigla];
    var ov = VENUE_OVERRIDES[M.date + "|" + sigla];
    if (ov) {
      if (ov.loc != null) loc = ov.loc;
      if (ov.home != null) home = ov.home;
    }
    var cost = friendly ? friendlyCost(sigla, rival) : null;
    var game = {
      date: M.date,
      dow: M.wd,
      time: M.time,
      team: info.team,
      fam: info.fam,
      sex: info.sex,
      rival: rival,
      home: home,
      loc: loc,
    };
    if (friendly) game.friendly = true;
    if (cost != null) game.cost = cost;
    games.push(game);
  });
  return games;
}

function buildData(calendars) {
  var games = [];
  calendars.forEach(function(calendar) {
    games = games.concat(parseCalendar(calendar.ics));
  });
  games.sort(function(a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.time !== b.time) return a.time < b.time ? -1 : 1;
    var order = ROW_ORDER[a.date + "|" + a.time];
    if (order) {
      var ra = order.indexOf(a.team);
      var rb = order.indexOf(b.team);
      ra = ra < 0 ? Infinity : ra;
      rb = rb < 0 ? Infinity : rb;
      if (ra !== rb) return ra - rb;
    }
    if (a.sex !== b.sex) return a.sex < b.sex ? -1 : 1;
    if (a.team !== b.team) return a.team < b.team ? -1 : 1;
    if (a.rival !== b.rival) return a.rival < b.rival ? -1 : 1;
    return 0;
  });

  var byWeek = {};
  games.forEach(function(g) {
    var wk = mondayISO(g.date);
    if (!byWeek[wk]) byWeek[wk] = [];
    byWeek[wk].push(g);
  });
  return {
    weeks: Object.keys(byWeek).sort().map(function(w) {
      return { monday: w, games: byWeek[w] };
    }),
  };
}

function allGames(data) {
  var out = [];
  (data.weeks || []).forEach(function(week) {
    out = out.concat(week.games || []);
  });
  return out;
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

function isLocationSimplification(oldLoc, newLoc) {
  var oldText = normalizeHistoryText(oldLoc);
  var newText = normalizeHistoryText(newLoc);
  if (!oldText || !newText || oldText === newText) return true;
  if (oldText.indexOf(newText + ",") === 0 || oldText.indexOf(newText + " |") === 0) return true;
  if (newText.indexOf(oldText + ",") === 0 || newText.indexOf(oldText + " |") === 0) return true;
  if (oldText.indexOf("MONTIGALA") !== -1 && newText.indexOf("MONTIGALA") !== -1) return true;
  return false;
}

function changedFields(oldGame, newGame) {
  var fields = [];
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
  var oldGames = allGames(oldData);
  var newGames = allGames(newData);
  var oldExact = {};
  var newExact = {};
  oldGames.forEach(function(g) { oldExact[historyGameKey(g)] = true; });
  newGames.forEach(function(g) { newExact[historyGameKey(g)] = true; });

  var addedRaw = newGames.filter(function(g) { return !oldExact[historyGameKey(g)]; });
  var removedRaw = oldGames.filter(function(g) { return !newExact[historyGameKey(g)]; });
  var removedByIdentity = {};
  removedRaw.forEach(function(g) {
    var k = identityKey(g);
    if (!removedByIdentity[k]) removedByIdentity[k] = [];
    removedByIdentity[k].push(g);
  });

  var changes = [];
  var usedRemoved = [];
  addedRaw.forEach(function(g) {
    var candidates = removedByIdentity[identityKey(g)] || [];
    var old = null;
    candidates.some(function(candidate) {
      if (usedRemoved.indexOf(candidate) === -1 && changedFields(candidate, g).length) {
        old = candidate;
        return true;
      }
      return false;
    });
    if (old) {
      usedRemoved.push(old);
      changes.push({ type: "changed", game: gameSnapshot(g), fields: changedFields(old, g) });
    } else {
      changes.push({ type: "added", game: gameSnapshot(g) });
    }
  });
  removedRaw.filter(function(g) { return usedRemoved.indexOf(g) === -1; })
    .forEach(function(g) { changes.push({ type: "removed", game: gameSnapshot(g) }); });
  return changes;
}

function changeKey(change) {
  var fields = (change.fields || []).map(function(field) {
    return [field.label, field.from, field.to].join("=");
  }).join(";");
  return [change.type, historyGameKey(change.game || {}), fields].join("||");
}

function hasEncodingNoise(change) {
  var game = change.game || {};
  var values = [game.team, game.rival, game.loc];
  (change.fields || []).forEach(function(field) {
    values.push(field.from);
    values.push(field.to);
  });
  return values.some(function(value) {
    return String(value || "").indexOf("\uFFFD") !== -1;
  });
}

function mergeChangeHistory(oldData, newChanges, importedAt) {
  var previousImportedAt = oldData.latestChanges && oldData.latestChanges.importedAt ? oldData.latestChanges.importedAt : importedAt;
  var previousChanges = oldData.latestChanges && Array.isArray(oldData.latestChanges.changes)
    ? oldData.latestChanges.changes.map(function(change) {
        var copy = {};
        Object.keys(change).forEach(function(k) { copy[k] = change[k]; });
        copy.importedAt = copy.importedAt || previousImportedAt;
        return copy;
      })
    : [];
  var stampedNewChanges = newChanges.map(function(change) {
    var copy = {};
    Object.keys(change).forEach(function(k) { copy[k] = change[k]; });
    copy.importedAt = importedAt;
    return copy;
  });
  var combined = stampedNewChanges.concat(previousChanges).filter(function(change) { return !hasEncodingNoise(change); });
  var seen = {};
  var changes = [];
  combined.forEach(function(change) {
    var key = changeKey(change);
    if (seen[key]) return;
    seen[key] = true;
    changes.push(change);
  });
  return {
    checkedAt: importedAt,
    importedAt: newChanges.length ? importedAt : (oldData.latestChanges && oldData.latestChanges.importedAt ? oldData.latestChanges.importedAt : importedAt),
    changes: changes,
  };
}

function importarCalendarisPartits() {
  var oldData = readFirebase(CALENDAR_FIREBASE_PATH);
  var oldHasWeeks = oldData && Array.isArray(oldData.weeks) && oldData.weeks.length;
  var calendars = CALENDARS.map(function(c) {
    return { sex: c.sex, ics: fetchText(c.url) };
  });
  var data = buildData(calendars);
  var now = new Date().toISOString();
  var latestChanges = oldHasWeeks ? buildChangeList(oldData, data) : [];
  data.latestChanges = oldHasWeeks
    ? mergeChangeHistory(oldData, latestChanges, now)
    : { checkedAt: now, importedAt: now, changes: [] };
  writeFirebase(CALENDAR_FIREBASE_PATH, data);
  var total = allGames(data).length;
  Logger.log("Calendaris importats: " + data.weeks.length + " setmanes, " + total + " partits, " + latestChanges.length + " canvi(s) nous.");
  return { ok: true, checkedAt: now, weeks: data.weeks.length, games: total, changes: latestChanges.length };
}

function crearTriggerImportacioCalendaris() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === "importarCalendarisPartits") {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  ScriptApp.newTrigger("importarCalendarisPartits")
    .timeBased()
    .everyHours(1)
    .nearMinute(30)
    .create();
}

function doGet() {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, service: "calendar-import", path: CALENDAR_FIREBASE_PATH }))
    .setMimeType(ContentService.MimeType.JSON);
}
