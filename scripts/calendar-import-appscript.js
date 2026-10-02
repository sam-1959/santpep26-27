// Google Apps Script — Importació de calendaris de partits a Firebase.
//
// Ús:
// 1) Copia aquest fitxer en un projecte d'Apps Script.
// 2) Executa `importarCalendarisPartits()` una vegada manualment.
// 3) Executa `crearTriggerImportacioCalendaris()` per programar-ho cada hora.
// 4) Autoritza MailApp: quan hi hagi canvis amb restriccions de taula, envia un avís a Direcció Tècnica.
//
// Escriu a Firebase RTDB:
//   calendarGames/season-26-27

var FIREBASE_DB_URL = "https://coord-fa09e-default-rtdb.europe-west1.firebasedatabase.app";
var SEASON = "season-26-27";
var CALENDAR_FIREBASE_PATH = "calendarGames/" + SEASON;
var TABLE_ASSIGNMENTS_FIREBASE_PATH = "miniTablesAssignments/" + SEASON;
var TABLE_PEOPLE_FIREBASE_PATH = "miniTablesPeople/" + SEASON;
// Es desa dins del calendari perquè aquest node ja està autoritzat per a la
// importació d'Apps Script; el node independent de taules està protegit per
// les regles de Firebase.
var TABLE_RESTRICTIONS_ALERT_PATH = CALENDAR_FIREBASE_PATH + "/tableRestrictionAlerts";
var TABLE_RESTRICTIONS_ALERT_EMAIL = "dtecnic@cbsantjosep.cat";

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
  "2026-10-04|JAF": { loc: "Pavelló Bufalà", home: true },
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

function tableNormalize(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function tableCanonicalTeam(value) {
  return tableNormalize(value) === "cadet-b-f" ? "Cadet F" : String(value || "").trim();
}

function tableTeamLabel(game) {
  return tableCanonicalTeam([game.team || "", game.sex || ""].join(" ").trim());
}

function tableGameId(game) {
  return [
    game.date, game.time, game.team, game.sex, game.rival,
    game.loc || "", game.home ? "home" : "away", game.friendly ? "friendly" : "official"
  ].map(tableNormalize).join("_");
}

function tableAssignmentMatchKey(game) {
  return [game.team, game.sex || "", game.rival || "", game.home ? "home" : "away", game.friendly ? "friendly" : "official"]
    .map(tableNormalize)
    .join("_");
}

function tablePersonKey(name) {
  return tableNormalize(name);
}

function tableDayPart(game) {
  var match = String(game.time || "").match(/(\d{1,2})/);
  if (!match) return "";
  return Number(match[1]) < 14 ? "morning" : "afternoon";
}

function tableIsClubVenue(game) {
  var loc = tableNormalize(game.loc || "");
  return !!game.home || loc.indexOf("la-colina") !== -1 || loc.indexOf("montigala") !== -1 || loc.indexOf("bufala") !== -1 || loc.indexOf("pomar") !== -1;
}

function tableNeedsExperience(game) {
  return ["mini-a-m", "mini-b-m", "mini-f"].indexOf(tableNormalize(tableTeamLabel(game))) !== -1;
}

function tableTeamList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value || "").split(",").map(function(item) { return item.trim(); }).filter(Boolean);
}

function tableProfilesByPerson(rawProfiles) {
  var profiles = {};
  Object.keys(rawProfiles || {}).forEach(function(key) {
    var profile = rawProfiles[key];
    if (!profile || !profile.name) return;
    profiles[tablePersonKey(profile.name)] = {
      name: profile.name,
      active: profile.active !== false,
      experienced: profile.experienced === true,
      playerTeams: tableTeamList(profile.playerTeams),
      assistantTeams: tableTeamList(profile.assistantTeams)
    };
  });
  return profiles;
}

function tableCurrentGameForAssignment(assignmentId, assignment, gamesById, tableGames) {
  if (gamesById[assignmentId]) return gamesById[assignmentId];
  if (!assignment || !assignment.game) return null;
  var saved = assignment.game;
  var matchKey = tableAssignmentMatchKey(saved);
  var candidates = tableGames.filter(function(game) {
    return tableAssignmentMatchKey(game) === matchKey && mondayISO(game.date) === mondayISO(saved.date);
  });
  return candidates.length === 1 ? candidates[0] : null;
}

function tableRestrictionIssues(calendarData, rawAssignments, rawProfiles) {
  var all = allGames(calendarData);
  var tableGames = all.filter(function(game) {
    return tableIsClubVenue(game) && (game.fam === "MINI" || game.fam === "PREMINI" || game.friendly);
  });
  var gamesById = {};
  tableGames.forEach(function(game) { gamesById[tableGameId(game)] = game; });
  var profiles = tableProfilesByPerson(rawProfiles);
  var issues = [];

  Object.keys(rawAssignments || {}).forEach(function(assignmentId) {
    var assignment = rawAssignments[assignmentId] || {};
    if (!assignment.table1 && !assignment.table2) return;
    var game = tableCurrentGameForAssignment(assignmentId, assignment, gamesById, tableGames);
    if (!game) {
      issues.push({
        fingerprint: "assignment-not-mapped|" + assignmentId,
        text: "Assignació sense partit mini coincident al calendari actual: " + assignmentId + "."
      });
      return;
    }

    var people = [assignment.table1 || "", assignment.table2 || ""].filter(Boolean);
    var gameText = game.date + " " + (game.time || "hora pendent") + " · " + tableTeamLabel(game) + " vs " + (game.rival || "rival pendent");
    if (assignment.table1 && assignment.table2 && assignment.table1 === assignment.table2) {
      issues.push({
        fingerprint: "duplicate|" + tableGameId(game) + "|" + tablePersonKey(assignment.table1),
        text: gameText + ": " + assignment.table1 + " està assignada dues vegades."
      });
    }

    people.forEach(function(person) {
      var profile = profiles[tablePersonKey(person)] || { name: person, active: true, experienced: false, playerTeams: [], assistantTeams: [] };
      var blockedTeams = profile.playerTeams.concat(profile.assistantTeams).map(tableCanonicalTeam).map(tableNormalize);
      var currentTeam = tableNormalize(tableTeamLabel(game));
      if (profile.active === false) {
        issues.push({ fingerprint: "inactive|" + tableGameId(game) + "|" + tablePersonKey(person), text: gameText + ": " + person + " no està activa." });
      }
      if (blockedTeams.indexOf(currentTeam) !== -1) {
        issues.push({ fingerprint: "own-team|" + tableGameId(game) + "|" + tablePersonKey(person), text: gameText + ": " + person + " juga o ajuda en aquest equip." });
      }
      var dayPart = tableDayPart(game);
      if (dayPart) {
        all.some(function(otherGame) {
          if (otherGame.date !== game.date || tableDayPart(otherGame) !== dayPart) return false;
          if (blockedTeams.indexOf(tableNormalize(tableTeamLabel(otherGame))) === -1) return false;
          var partLabel = dayPart === "morning" ? "matí" : "tarda";
          issues.push({
            fingerprint: "same-day|" + tableGameId(game) + "|" + tablePersonKey(person) + "|" + tableGameId(otherGame),
            text: gameText + ": " + person + " té partit amb " + tableTeamLabel(otherGame) + " el mateix dia i franja de " + partLabel + "."
          });
          return true;
        });
      }
    });

    if (tableNeedsExperience(game)) {
      var hasExperience = people.some(function(person) {
        return profiles[tablePersonKey(person)] && profiles[tablePersonKey(person)].experienced === true;
      });
      if (!hasExperience) {
        issues.push({
          fingerprint: "experience|" + tableGameId(game),
          text: gameText + ": aquest partit mini necessita almenys una persona amb experiència a la taula."
        });
      }
    }
  });
  return issues;
}

function restrictionAlertSignature(issues) {
  return issues.map(function(issue) { return issue.fingerprint; }).sort().join("\n");
}

function escapeAlertHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function(character) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character];
  });
}

function formatRestrictionIssueHtml(text) {
  var value = String(text || "");
  var separator = value.lastIndexOf(": ");
  if (separator === -1) return '<strong style="color:#4B1D6D;">' + escapeAlertHtml(value) + '</strong>';
  var game = value.slice(0, separator);
  var reason = value.slice(separator + 2);
  return '<div style="font-weight:700;color:#4B1D6D;font-size:15px;line-height:1.35;margin-bottom:7px;">' + escapeAlertHtml(game) + '</div>' +
    '<div style="color:#333;line-height:1.45;">' +
      '<span style="display:inline-block;margin:0 6px 3px 0;padding:2px 6px;border-radius:4px;background-color:#F9F6FC;color:#4B1D6D;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;">Restricció</span>' +
      escapeAlertHtml(reason) +
    '</div>';
}

function restrictionAlertEmailHtml(issues, forceCheck, changeCount) {
  var tableRows = issues.map(function(issue, index) {
    return '<tr>' +
      '<td style="width:12%;padding:12px 10px;border-bottom:1px solid #E5E5E5;font-weight:bold;background-color:#F9F6FC;color:#4B1D6D;vertical-align:top;">' + (index + 1) + '</td>' +
      '<td style="width:88%;padding:12px 10px;border-bottom:1px solid #E5E5E5;color:#333333;vertical-align:top;">' + formatRestrictionIssueHtml(issue.text) + '</td>' +
      '</tr>';
  }).join("");
  var introduction = forceCheck
    ? "S'ha executat una verificació manual de les restriccions de planificació."
    : "S'han detectat " + changeCount + " canvi(s) al calendari i s'han verificat les restriccions de planificació.";
  var url = "https://sam-1959.github.io/santpep26-27/taules-planificacio.html";

  return '<div style="font-family:\'Helvetica Neue\',Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;border:1px solid #E5E5E5;border-radius:8px;overflow:hidden;">' +
    '<div style="background-color:#4B1D6D;padding:25px;text-align:center;border-bottom:4px solid #FFC72C;">' +
      '<h1 style="color:#FFC72C;margin:0;font-size:22px;text-transform:uppercase;letter-spacing:1px;">CB Sant Josep Badalona</h1>' +
      '<p style="color:#FFFFFF;margin:5px 0 0;font-size:13px;opacity:.9;">Alerta de planificació de taules</p>' +
    '</div>' +
    '<div style="padding:25px;background-color:#FFFFFF;">' +
      '<h3 style="color:#4B1D6D;margin-top:0;font-size:18px;">Restriccions detectades</h3>' +
      '<p style="margin:0 0 15px;color:#333;line-height:1.45;">' + escapeAlertHtml(introduction) + '</p>' +
      '<table style="width:100%;table-layout:fixed;border-collapse:collapse;margin:15px 0 20px;">' +
        '<thead><tr style="background-color:#4B1D6D;color:#FFC72C;">' +
          '<th style="width:12%;padding:10px;text-align:left;font-size:14px;">#</th>' +
          '<th style="width:88%;padding:10px;text-align:left;font-size:14px;">Incidència</th>' +
        '</tr></thead><tbody>' + tableRows + '</tbody>' +
      '</table>' +
      '<div style="text-align:center;margin:30px 0 10px;padding:20px;background-color:#F9F6FC;border-radius:6px;border:1px dashed #4B1D6D;">' +
        '<p style="margin:0 0 15px;font-weight:bold;color:#4B1D6D;font-size:15px;">Planificació de taules</p>' +
        '<a href="' + url + '" target="_blank" style="background-color:#4B1D6D;color:#FFC72C;padding:12px 24px;text-decoration:none;font-weight:bold;border-radius:5px;display:inline-block;font-size:14px;border:2px solid #FFC72C;">Revisar les restriccions</a>' +
      '</div>' +
    '</div>' +
    '<div style="background-color:#F4F4F4;padding:15px;text-align:center;border-top:1px solid #EEEEEE;">' +
      '<p style="font-size:12px;color:#666;margin:0;"><strong>CB Sant Josep Badalona</strong> — Notificació automàtica del club.</p>' +
    '</div>' +
  '</div>';
}

function verifyTableRestrictionsAndAlert(calendarData, latestChanges, checkedAt, forceCheck) {
  if ((!latestChanges || !latestChanges.length) && !forceCheck) return { checked: false, issues: 0, emailed: false };
  var assignments = readFirebase(TABLE_ASSIGNMENTS_FIREBASE_PATH) || {};
  var profiles = readFirebase(TABLE_PEOPLE_FIREBASE_PATH) || {};
  var alertStatus = readFirebase(TABLE_RESTRICTIONS_ALERT_PATH) || {};
  var issues = tableRestrictionIssues(calendarData, assignments, profiles);
  var signature = restrictionAlertSignature(issues);
  var status = {
    checkedAt: checkedAt,
    changesDetected: latestChanges.length,
    issueCount: issues.length,
    lastIssueSignature: issues.length ? signature : "",
    lastIssues: issues.map(function(issue) { return issue.text; })
  };

  if (!issues.length) {
    if (alertStatus.lastIssueSignature) status.resolvedAt = checkedAt;
    writeFirebase(TABLE_RESTRICTIONS_ALERT_PATH, status);
    return { checked: true, issues: 0, emailed: false };
  }

  if (alertStatus.lastIssueSignature === signature) {
    status.lastAlertAt = alertStatus.lastAlertAt || "";
    writeFirebase(TABLE_RESTRICTIONS_ALERT_PATH, status);
    return { checked: true, issues: issues.length, emailed: false, duplicate: true };
  }

  var subject = "Alerta: restriccions de taules després d'actualitzar calendaris";
  var intro = forceCheck
    ? "S'ha executat una verificació manual de les restriccions de taules."
    : "S'han detectat " + latestChanges.length + " canvi(s) al calendari.";
  var body = [
    intro,
    "La verificació de Planificació de taules ha trobat " + issues.length + " incidència(es):",
    ""
  ].concat(issues.map(function(issue) { return "- " + issue.text; })).concat([
    "",
    "Revisa Planificació de taules: https://sam-1959.github.io/santpep26-27/taules-planificacio.html"
  ]).join("\n");
  MailApp.sendEmail(TABLE_RESTRICTIONS_ALERT_EMAIL, subject, body, {
    htmlBody: restrictionAlertEmailHtml(issues, forceCheck, latestChanges.length),
    name: "CB Sant Josep Badalona"
  });
  status.lastAlertAt = checkedAt;
  writeFirebase(TABLE_RESTRICTIONS_ALERT_PATH, status);
  return { checked: true, issues: issues.length, emailed: true };
}

// Executa-la manualment després d'actualitzar el codi si cal recuperar una
// alerta que no s'havia pogut enviar. Respecta la mateixa protecció antirepetició.
function verificarRestriccionsTaulesAra() {
  var calendarData = readFirebase(CALENDAR_FIREBASE_PATH);
  return verifyTableRestrictionsAndAlert(calendarData, [], new Date().toISOString(), true);
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
  var restrictions = verifyTableRestrictionsAndAlert(data, latestChanges, now);
  var total = allGames(data).length;
  Logger.log("Calendaris importats: " + data.weeks.length + " setmanes, " + total + " partits, " + latestChanges.length + " canvi(s) nous. Restriccions: " + restrictions.issues + ".");
  return { ok: true, checkedAt: now, weeks: data.weeks.length, games: total, changes: latestChanges.length, restrictions: restrictions };
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
