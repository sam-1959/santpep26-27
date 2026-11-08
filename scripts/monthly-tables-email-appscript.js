// Google Apps Script autònom — Enviament mensual de taules.
//
// Configuració:
// 1. Crea un projecte nou a https://script.google.com/.
// 2. Enganxa aquest fitxer.
// 3. Executa `crearTriggerEnviamentMensualTaules()` una vegada i autoritza
//    GmailApp, UrlFetchApp i ScriptApp.
// 4. Opcionalment, executa `provarEnviamentMensualTaules()` per enviar una
//    prova real del mes actual a dtecnic@cbsantjosep.cat.
//
// El trigger es comprova cada dia a les 09:10 (Europe/Madrid). Envia l'1 de
// cada mes si és laborable; si l'1 és dissabte o diumenge, envia el dilluns
// següent. ScriptProperties evita un segon enviament del mateix mes.

var FIREBASE_DB_URL = "https://coord-fa09e-default-rtdb.europe-west1.firebasedatabase.app";
var SEASON = "season-26-27";
var TIMEZONE = "Europe/Madrid";
var CALENDAR_PATH = "calendarGames/" + SEASON;
var ASSIGNMENTS_PATH = "miniTablesAssignments/" + SEASON;
var RECIPIENT = "dtecnic@cbsantjosep.cat";
var PLANNING_URL = "https://sam-1959.github.io/santpep26-27/taules-planificacio.html";
var STATE_PREFIX = "monthlyTablesEmail:";
var TABLE_COST = 10;

function crearTriggerEnviamentMensualTaules() {
  eliminarTriggersEnviamentMensualTaules();
  ScriptApp.newTrigger("enviarTaulesMensualsProgramat")
    .timeBased()
    .everyDays(1)
    .atHour(9)
    .nearMinute(10)
    .inTimezone(TIMEZONE)
    .create();
}

function eliminarTriggersEnviamentMensualTaules() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === "enviarTaulesMensualsProgramat") {
      ScriptApp.deleteTrigger(trigger);
      removed += 1;
    }
  });
  return { ok:true, removed:removed };
}

function enviarTaulesMensualsProgramat() {
  var now = new Date();
  if (!esDiaEnviamentMensualTaules(now)) {
    return { status:"skipped_not_scheduled_day", date:localIsoDate(now) };
  }
  return enviarTaulesMensuals({ now:now });
}

function provarEnviamentMensualTaules() {
  return enviarTaulesMensuals({ force:true });
}

function esDiaEnviamentMensualTaules(date) {
  var parts = localIsoDate(date || new Date()).split("-").map(Number);
  var day = parts[2];
  var weekday = new Date(Date.UTC(parts[0], parts[1] - 1, day)).getUTCDay();
  if (day === 1 && weekday !== 0 && weekday !== 6) return true;
  // Si l'1 és dissabte, s'envia dilluns 3; si és diumenge, dilluns 2.
  return weekday === 1 && day <= 3;
}

function enviarTaulesMensuals(options) {
  options = options || {};
  var now = options.now || new Date();
  var monthKey = Utilities.formatDate(now, TIMEZONE, "yyyy-MM");
  var stateKey = STATE_PREFIX + monthKey;
  var properties = PropertiesService.getScriptProperties();
  if (!options.force && properties.getProperty(stateKey)) {
    return { status:"already_sent", month:monthKey };
  }

  var calendar = readFirebase(CALENDAR_PATH) || {};
  applyManualChanges(calendar);
  var all = allGames(calendar);
  var games = all.filter(function(game) {
    return String(game.date || "").slice(0, 7) === monthKey && isTableGame(game);
  }).sort(function(a, b) {
    return (String(a.date) + " " + String(a.time)).localeCompare(String(b.date) + " " + String(b.time));
  });
  var assignments = readFirebase(ASSIGNMENTS_PATH) || {};
  var assignmentsByGame = assignmentsForGames(games, assignments);
  var monthlyCosts = monthlyCostByPerson(games, assignmentsByGame);
  var monthLabel = monthName(monthKey);
  var subject = "Taules de " + monthLabel + " · CB Sant Josep Badalona";

  GmailApp.sendEmail(RECIPIENT, subject, buildText(games, assignmentsByGame, monthlyCosts, monthLabel), {
    htmlBody:buildHtml(games, assignmentsByGame, monthlyCosts, monthLabel),
    name:"CB Sant Josep Badalona",
    from:"dtecnic@cbsantjosep.cat"
  });
  properties.setProperty(stateKey, JSON.stringify({ sentAt:new Date().toISOString(), games:games.length, recipient:RECIPIENT }));
  return { status:"sent", month:monthKey, games:games.length, recipient:RECIPIENT };
}

function readFirebase(path) {
  var url = FIREBASE_DB_URL.replace(/\/$/, "") + "/" + path.split("/").map(encodeURIComponent).join("/") + ".json";
  var response = UrlFetchApp.fetch(url, { method:"get", muteHttpExceptions:true });
  if (response.getResponseCode() === 404) return null;
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error("Firebase GET " + response.getResponseCode() + ": " + response.getContentText());
  }
  var text = response.getContentText();
  return text && text !== "null" ? JSON.parse(text) : null;
}

function allGames(calendar) {
  return (calendar.weeks || []).reduce(function(games, week) {
    return games.concat((week && week.games) || []);
  }, []);
}

function normalized(value) {
  return String(value || "").trim().toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function gameId(game) {
  return [game.date, game.time, game.team, game.sex, game.rival, game.loc || "", game.home ? "home" : "away", game.friendly ? "friendly" : "official"]
    .map(normalized).join("_");
}

function gameMatchKey(game) {
  return [game.team, game.sex || "", game.rival || "", game.home ? "home" : "away", game.friendly ? "friendly" : "official"]
    .map(normalized).join("_");
}

function isTableGame(game) {
  var location = normalized(game.loc);
  var clubVenue = !!game.home || /la-colina|montigala|bufala|pomar/.test(location);
  var family = String(game.fam || "").toUpperCase();
  return clubVenue && (family === "MINI" || family === "PREMINI" || game.friendly === true);
}

function applyManualChanges(calendar) {
  var games = allGames(calendar);
  Object.keys(calendar.manualChanges || {}).map(function(key) { return calendar.manualChanges[key]; })
    .filter(function(change) { return change && change.manual && change.type === "changed" && change.game; })
    .sort(function(a, b) { return String(a.importedAt || "").localeCompare(String(b.importedAt || "")); })
    .forEach(function(change) {
      var before = {};
      ["date", "time", "rival", "loc", "home", "friendly", "team", "sex"].forEach(function(field) { before[field] = change.game[field]; });
      (change.fields || []).forEach(function(field) {
        if (field.label === "Data") before.date = field.from;
        if (field.label === "Hora") before.time = field.from;
        if (field.label === "Rival") before.rival = field.from;
        if (field.label === "Lloc") before.loc = field.from;
        if (field.label === "Casa/fora") before.home = field.from === "casa";
        if (field.label === "Amistós") before.friendly = field.from === "sí";
      });
      var matches = games.filter(function(game) { return gameId(game) === gameId(before); });
      if (matches.length !== 1) return;
      ["date", "time", "rival", "loc", "home", "friendly"].forEach(function(field) { matches[0][field] = change.game[field]; });
    });
}

function assignmentsForGames(games, assignments) {
  var byId = {};
  games.forEach(function(game) { byId[gameId(game)] = game; });
  var result = {};
  Object.keys(assignments || {}).forEach(function(id) {
    var assignment = assignments[id] || {};
    var game = byId[id] || (assignment.game && byId[gameId(assignment.game)]);
    if (!game && assignment.game) {
      var candidates = games.filter(function(candidate) { return gameMatchKey(candidate) === gameMatchKey(assignment.game); });
      if (candidates.length === 1) game = candidates[0];
    }
    if (game) result[gameId(game)] = assignment;
  });
  return result;
}

function monthlyCostByPerson(games, assignments) {
  var people = {};
  games.forEach(function(game) {
    var assignment = assignments[gameId(game)] || {};
    [assignment.table1, assignment.table2].forEach(function(name) {
      name = String(name || "").trim();
      if (!name) return;
      if (!people[name]) people[name] = { name:name, tables:0 };
      people[name].tables += 1;
    });
  });
  return Object.keys(people).map(function(name) {
    var item = people[name];
    item.amount = item.tables * TABLE_COST;
    return item;
  }).sort(function(a, b) {
    return b.tables - a.tables || a.name.localeCompare(b.name, "ca");
  });
}

function teamLabel(game) {
  return String(game.team || "Equip pendent") + (game.sex ? " " + game.sex : "");
}

function dateLabel(value) {
  var match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? match[3] + "/" + match[2] + "/" + match[1] : (value || "Sense data");
}

function monthName(key) {
  var parts = String(key || "").split("-");
  var months = ["gener", "febrer", "març", "abril", "maig", "juny", "juliol", "agost", "setembre", "octubre", "novembre", "desembre"];
  return (months[Number(parts[1]) - 1] || key) + " " + (parts[0] || "");
}

function matchup(game) {
  return game.home ? teamLabel(game) + " vs " + (game.rival || "Rival pendent") : (game.rival || "Rival pendent") + " vs " + teamLabel(game);
}

function formatEuros(amount) {
  return Number(amount || 0).toFixed(2).replace(".", ",") + " €";
}

function buildText(games, assignments, costs, label) {
  var lines = ["Planificació de taules · " + label, "", "Partits amb taula: " + games.length, ""];
  if (!games.length) lines.push("No hi ha partits amb taula previstos aquest mes.");
  games.forEach(function(game) {
    var assignment = assignments[gameId(game)] || {};
    lines.push(dateLabel(game.date) + " · " + (game.time || "Hora pendent") + " · " + matchup(game));
    lines.push("Lloc: " + (game.loc || "Pendent"));
    lines.push("Taula 1: " + (assignment.table1 || "Pendent") + " · Taula 2: " + (assignment.table2 || "Pendent"));
    lines.push("");
  });
  lines.push("Cost mensual per persona");
  if (!costs.length) {
    lines.push("Encara no hi ha cap assignació en aquest mes.");
  } else {
    costs.forEach(function(item) {
      lines.push(item.name + ": " + item.tables + " taula(es) × " + formatEuros(TABLE_COST) + " = " + formatEuros(item.amount));
    });
    lines.push("Total mensual: " + formatEuros(costs.reduce(function(total, item) { return total + item.amount; }, 0)));
  }
  lines.push("");
  lines.push("Planificació de taules: " + PLANNING_URL);
  return lines.join("\n");
}

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(/[&<>"']/g, function(character) {
    return { "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;", "'":"&#39;" }[character];
  });
}

function buildHtml(games, assignments, costs, label) {
  var rows = games.length ? games.map(function(game, index) {
    var assignment = assignments[gameId(game)] || {};
    var pending = !assignment.table1 || !assignment.table2;
    return '<tr><td style="width:48px;padding:11px 12px;border-bottom:1px solid #E5E5E5;vertical-align:top;color:#4B1D6D;font-weight:bold;">' + (index + 1) + '</td>' +
      '<td style="padding:11px 9px;border-bottom:1px solid #E5E5E5;vertical-align:top;"><strong style="color:#4B1D6D;">' + escapeHtml(matchup(game)) + '</strong><br><span style="color:#666;font-size:12px;">' + escapeHtml(dateLabel(game.date) + " · " + (game.time || "Hora pendent") + " · " + (game.loc || "Lloc pendent")) + '</span></td>' +
      '<td style="padding:11px 9px;border-bottom:1px solid #E5E5E5;vertical-align:top;line-height:1.5;"><strong>Taula 1:</strong> ' + escapeHtml(assignment.table1 || "Pendent") + '<br><strong>Taula 2:</strong> ' + escapeHtml(assignment.table2 || "Pendent") + (pending ? '<br><span style="display:inline-block;margin-top:4px;padding:2px 6px;border-radius:4px;background:#FFF1F1;color:#B3261E;font-size:11px;font-weight:700;">PENDENT</span>' : '') + '</td></tr>';
  }).join("") : '<tr><td colspan="3" style="padding:16px 9px;text-align:center;color:#666;">No hi ha partits amb taula previstos aquest mes.</td></tr>';
  var costRows = costs.length ? costs.map(function(item, index) {
    return '<tr><td style="width:48px;padding:8px 12px;border-bottom:1px solid #E5E5E5;color:#666;text-align:right;">' + (index + 1) + '</td><td style="padding:8px 9px;border-bottom:1px solid #E5E5E5;">' + escapeHtml(item.name) + '</td><td style="padding:8px 9px;border-bottom:1px solid #E5E5E5;text-align:right;">' + item.tables + '</td><td style="padding:8px 9px;border-bottom:1px solid #E5E5E5;text-align:right;">' + formatEuros(TABLE_COST) + '</td><td style="padding:8px 9px;border-bottom:1px solid #E5E5E5;text-align:right;font-weight:700;">' + formatEuros(item.amount) + '</td></tr>';
  }).join("") + '<tr><td colspan="4" style="padding:9px;text-align:right;background:#FFF8D8;font-weight:700;">Total mensual</td><td style="padding:9px;text-align:right;background:#FFF8D8;font-weight:700;">' + formatEuros(costs.reduce(function(total, item) { return total + item.amount; }, 0)) + '</td></tr>' : '<tr><td colspan="5" style="padding:14px;text-align:center;color:#666;">Encara no hi ha cap assignació en aquest mes.</td></tr>';
  return '<div style="font-family:Helvetica,Arial,sans-serif;color:#333;max-width:720px;margin:0 auto;border:1px solid #E5E5E5;border-radius:8px;overflow:hidden;">' +
    '<div style="background:#4B1D6D;padding:24px;text-align:center;border-bottom:4px solid #FFC72C;"><h1 style="color:#FFC72C;margin:0;font-size:22px;text-transform:uppercase;">CB Sant Josep Badalona</h1><p style="color:#fff;margin:5px 0 0;font-size:13px;opacity:.9;">Planificació mensual de taules</p></div>' +
    '<div style="padding:24px;background:#fff;"><h2 style="color:#4B1D6D;margin:0 0 8px;font-size:19px;">Taules de ' + escapeHtml(label) + '</h2><p style="margin:0 0 18px;line-height:1.45;color:#555;">Relació de partits amb taula i persones assignades. Partits previstos: <strong>' + games.length + '</strong>.</p>' +
    '<table style="border-collapse:collapse;width:100%;"><thead><tr style="background:#F9F6FC;"><th style="width:48px;padding:9px 12px;text-align:left;color:#4B1D6D;">#</th><th style="padding:9px;text-align:left;color:#4B1D6D;">Partit</th><th style="padding:9px;text-align:left;color:#4B1D6D;">Assignació</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<h3 style="color:#4B1D6D;margin:26px 0 10px;font-size:16px;">Cost mensual per persona</h3>' +
    '<table style="border-collapse:collapse;width:100%;"><thead><tr style="background:#F9F6FC;"><th style="width:48px;padding:8px 12px;text-align:right;color:#4B1D6D;">#</th><th style="padding:8px 9px;text-align:left;color:#4B1D6D;">Persona</th><th style="padding:8px 9px;text-align:right;color:#4B1D6D;">Taules</th><th style="padding:8px 9px;text-align:right;color:#4B1D6D;">Preu/taula</th><th style="padding:8px 9px;text-align:right;color:#4B1D6D;">Total</th></tr></thead><tbody>' + costRows + '</tbody></table>' +
    '</div><div style="background:#F4F4F4;padding:14px;text-align:center;border-top:1px solid #EEEEEE;font-size:12px;color:#666;">CB Sant Josep Badalona · Notificació automàtica</div></div>';
}

function localIsoDate(date) {
  return Utilities.formatDate(date || new Date(), TIMEZONE, "yyyy-MM-dd");
}
