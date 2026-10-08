// Apps Script Web App — avís immediat dels canvis manuals de Calendaris de partits.
//
// Desplegament:
// 1. Crea un projecte nou a https://script.google.com/ i enganxa-hi aquest fitxer.
// 2. Deploy > New deployment > Web app.
// 3. Execute as: Me.
// 4. Who has access: Anyone.
// 5. Executa `autoritzarAvisosCanvisManualsCalendar()` des de l'editor i
//    autoritza MailApp i UrlFetchApp (no envia cap correu).
// 6. Copia la URL acabada en /exec a CALENDAR_MANUAL_NOTIFY_URL de partits.html.
//
// El servei valida el token de Firebase de l'usuari que desa el canvi i només
// accepta correus inclosos a la taula de contactes de la temporada.

var FIREBASE_DB_URL = "https://coord-fa09e-default-rtdb.europe-west1.firebasedatabase.app";
var FIREBASE_API_KEY = "AIzaSyDge8IFez-I-HhyFDx0ch0Jr1-NYLHDWRU";
var SEASON_CONTACTS_PATH = "seasonContacts/season-26-27";
var CALENDAR_FIREBASE_PATH = "calendarGames/season-26-27";
var TABLE_ASSIGNMENTS_FIREBASE_PATH = "miniTablesAssignments/season-26-27";
var TABLE_PEOPLE_FIREBASE_PATH = "miniTablesPeople/season-26-27";
var TABLE_RESTRICTIONS_ALERT_PATH = CALENDAR_FIREBASE_PATH + "/tableRestrictionAlerts";
var OWN_TEAM_CODES = {
  "Infantil A|M": "IAM", "Infantil B|M": "IBM", "Premini B|M": "PBM", "Premini A|M": "PAM",
  "Mini A|M": "MAM", "Mini B|M": "MBM", "Cadet A|M": "CAM", "Cadet B|M": "CBM",
  "Júnior A|M": "JAM", "Júnior B|M": "JBM", "Sènior A|M": "SAM", "Sènior B|M": "SBM",
  "Infantil|F": "IF", "Mini|F": "MF", "Cadet|F": "CF", "Cadet B|F": "CBF",
  "Júnior A|F": "JAF", "Júnior B|F": "JBF", "Sènior A|F": "SAF"
};

function doGet() {
  return respostaJson({ ok: true, service: "calendar-manual-notify" });
}

function doPost(e) {
  try {
    var request = JSON.parse(((e && e.postData && e.postData.contents) || "{}"));
    if (request.action !== "manualCalendarEdit") {
      throw new Error("Acció no permesa.");
    }
    var user = validarUsuariFirebase(request.idToken);
    if (!usuariAutoritzat(user.email)) {
      throw new Error("Aquest usuari no té permís per enviar avisos de calendari.");
    }
    var game = request.game || {};
    if (!game.team || !game.sex || !game.date || !game.time || !game.rival) {
      throw new Error("Falten dades del partit.");
    }
    var changes = Array.isArray(request.changes) ? request.changes.filter(function(change) {
      return change && change.label && String(change.from || "") !== String(change.to || "");
    }) : [];
    if (!changes.length) return respostaJson({ ok: true, skipped: true, reason: "without_changes" });

    var teamLabel = String(game.team) + " " + String(game.sex);
    var change = { type: "changed", game: game, fields: changes };
    var subject = "Canvi de calendari · " + teamLabel;
    var coachEmail = correuPrimerEntrenador(game);
    var coordinationEmail = correuCoordinacioGeneral();
    var destinatari = coachEmail || coordinationEmail;
    if (!destinatari) throw new Error("No hi ha correu de primer entrenador/a ni de Coordinació general configurat.");
    var mailOptions = {
      htmlBody: calendarChangeEmailHtml(teamLabel, [change]),
      name: "CB Sant Josep Badalona"
    };
    if (coachEmail && coordinationEmail && coachEmail.toLowerCase() !== coordinationEmail.toLowerCase()) {
      mailOptions.cc = coordinationEmail;
    }
    MailApp.sendEmail(destinatari, subject, construirTextCanvisCalendar(teamLabel, [change]), mailOptions);

    // L'avís intern no pot dependre de Calendar: si la sincronització falla,
    // Coordinació igualment ha de conèixer el canvi i poder actuar.
    var googleSync;
    try {
      googleSync = sincronitzarPartitGoogleCalendar(game);
    } catch (syncError) {
      Logger.log("No s'ha pogut sincronitzar el canvi manual amb Google Calendar: " + syncError);
      googleSync = { ok: false, error: String(syncError) };
    }
    var tableRestrictions;
    try {
      tableRestrictions = verificarRestriccionsTaulesDespresCanviManual(game, changes);
    } catch (restrictionError) {
      Logger.log("No s'han pogut verificar les restriccions de taules després del canvi manual: " + restrictionError);
      tableRestrictions = { checked: false, error: String(restrictionError) };
    }
    return respostaJson({ ok: true, sentTo: destinatari, cc: mailOptions.cc || "", googleSync: googleSync, tableRestrictions: tableRestrictions });
  } catch (error) {
    Logger.log("Error enviant l'avís manual de calendari: " + error);
    return respostaJson({ ok: false, error: String(error) });
  }
}

// Executa aquesta funció una vegada des de l'editor d'Apps Script per
// autoritzar MailApp i UrlFetchApp. No envia cap correu.
function autoritzarAvisosCanvisManualsCalendar() {
  var quota = MailApp.getRemainingDailyQuota();
  var response = UrlFetchApp.fetch(FIREBASE_DB_URL + "/.json", { muteHttpExceptions: true });
  return { ok: true, mailQuota: quota, firebaseStatus: response.getResponseCode() };
}

// Requereix habilitar el servei avançat "Google Calendar API" al projecte
// d'Apps Script. Cerca l'esdeveniment per iCalUID i en manté la durada.
function sincronitzarPartitGoogleCalendar(game) {
  if (!game.calendarId || !game.icalUid) {
    throw new Error("Falta l'identificador de Google Calendar del partit. Torna a importar els calendaris abans d'editar-lo.");
  }
  var result = Calendar.Events.list(game.calendarId, { iCalUID: game.icalUid, maxResults: 2 });
  var event = result.items && result.items[0];
  if (!event) throw new Error("No s'ha trobat l'esdeveniment original de Google Calendar.");

  var durationMinutes = 90;
  if (event.start && event.start.dateTime && event.end && event.end.dateTime) {
    var duration = new Date(event.end.dateTime).getTime() - new Date(event.start.dateTime).getTime();
    if (duration > 0) durationMinutes = Math.round(duration / 60000);
  }
  var startDate = new Date(game.date + "T" + game.time + ":00");
  var endDate = new Date(startDate.getTime() + durationMinutes * 60000);
  var teamCode = OWN_TEAM_CODES[String(game.team) + "|" + String(game.sex)];
  if (!teamCode) throw new Error("No s'ha identificat el codi de l'equip.");
  var markers = String(event.summary || "").match(/[🏀🤝🍼]/g);
  var summary = (markers && markers.length ? markers.join("") + " " : "") +
    (game.home ? teamCode + " Vs " + game.rival : game.rival + " Vs " + teamCode);
  var patch = {
    summary: summary,
    location: game.loc || "",
    start: { dateTime: formatCalendarDateTime(startDate), timeZone: "Europe/Madrid" },
    end: { dateTime: formatCalendarDateTime(endDate), timeZone: "Europe/Madrid" }
  };
  Calendar.Events.patch(patch, game.calendarId, event.id);
  return { ok: true, calendarId: game.calendarId, eventId: event.id };
}

function formatCalendarDateTime(date) {
  return Utilities.formatDate(date, "Europe/Madrid", "yyyy-MM-dd'T'HH:mm:ss");
}

// Executa aquesta funció per autoritzar i comprovar l'accés als dos calendaris.
function comprovarPermisosCalendarisGoogle() {
  var calendars = [
    "e6e366d49523bee10af33b961767a8c3228b60cb30066e3fdc04704077f65a9f@group.calendar.google.com",
    "6vssihbaio24d4s1220h8km6v8@group.calendar.google.com"
  ];
  return calendars.map(function(calendarId) {
    var calendar = Calendar.Calendars.get(calendarId);
    return { id: calendar.id, summary: calendar.summary, accessRole: calendar.accessRole };
  });
}

function validarUsuariFirebase(idToken) {
  if (!idToken) throw new Error("Falta l'autenticació de l'usuari.");
  var response = UrlFetchApp.fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + encodeURIComponent(FIREBASE_API_KEY),
    { method: "post", contentType: "application/json", payload: JSON.stringify({ idToken: idToken }), muteHttpExceptions: true }
  );
  if (response.getResponseCode() !== 200) throw new Error("No s'ha pogut validar l'usuari.");
  var data = JSON.parse(response.getContentText() || "{}");
  var user = data.users && data.users[0];
  if (!user || !user.email) throw new Error("No s'ha identificat cap correu d'usuari.");
  return { email: String(user.email).trim().toLowerCase() };
}

function llegirContactes() {
  var url = FIREBASE_DB_URL + "/" + SEASON_CONTACTS_PATH.split("/").map(encodeURIComponent).join("/") + ".json";
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) throw new Error("No s'han pogut llegir els contactes.");
  return JSON.parse(response.getContentText() || "{}") || {};
}

function firebaseUrl(pathName) {
  return FIREBASE_DB_URL + "/" + pathName.split("/").map(encodeURIComponent).join("/") + ".json";
}

function llegirFirebase(pathName) {
  var response = UrlFetchApp.fetch(firebaseUrl(pathName), { muteHttpExceptions: true });
  if (response.getResponseCode() === 404) return null;
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error("Firebase GET " + response.getResponseCode() + ": " + response.getContentText());
  }
  var text = response.getContentText();
  return text && text !== "null" ? JSON.parse(text) : null;
}

function escriureFirebase(pathName, value) {
  var response = UrlFetchApp.fetch(firebaseUrl(pathName), {
    method: "put", contentType: "application/json; charset=utf-8", payload: JSON.stringify(value), muteHttpExceptions: true
  });
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error("Firebase PUT " + response.getResponseCode() + ": " + response.getContentText());
  }
}

function taulaNormalitza(value) {
  return String(value || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function taulaEquipCanonical(value) {
  return taulaNormalitza(value) === "cadet-b-f" ? "Cadet F" : String(value || "").trim();
}

function taulaEtiquetaEquip(game) {
  return taulaEquipCanonical([game.team || "", game.sex || ""].join(" ").trim());
}

function taulaIdPartit(game) {
  return [game.date, game.time, game.team, game.sex, game.rival, game.loc || "", game.home ? "home" : "away", game.friendly ? "friendly" : "official"]
    .map(taulaNormalitza).join("_");
}

function taulaClauPartit(game) {
  return [game.team, game.sex || "", game.rival || "", game.home ? "home" : "away", game.friendly ? "friendly" : "official"]
    .map(taulaNormalitza).join("_");
}

function taulaDilluns(dateValue) {
  var date = new Date(String(dateValue) + "T12:00:00");
  date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  return Utilities.formatDate(date, "Europe/Madrid", "yyyy-MM-dd");
}

function taulaFranja(game) {
  var match = String(game.time || "").match(/(\d{1,2})/);
  return match ? (Number(match[1]) < 14 ? "morning" : "afternoon") : "";
}

function taulaEsPistaClub(game) {
  var loc = taulaNormalitza(game.loc || "");
  return !!game.home || loc.indexOf("la-colina") !== -1 || loc.indexOf("montigala") !== -1 || loc.indexOf("bufala") !== -1 || loc.indexOf("pomar") !== -1;
}

function taulaNecessitaExperiencia(game) {
  return ["mini-a-m", "mini-b-m", "mini-f"].indexOf(taulaNormalitza(taulaEtiquetaEquip(game))) !== -1;
}

function taulaLlistaEquips(value) {
  return Array.isArray(value) ? value.filter(Boolean) : String(value || "").split(",").map(function(item) { return item.trim(); }).filter(Boolean);
}

function taulaTotsElsPartits(calendarData) {
  return (calendarData.weeks || []).reduce(function(all, week) { return all.concat(week.games || []); }, []);
}

function taulaPartitAnterior(game, changes) {
  var previous = {
    date: game.date, time: game.time, rival: game.rival, loc: game.loc || "", home: !!game.home, friendly: !!game.friendly,
    team: game.team, sex: game.sex
  };
  (changes || []).forEach(function(change) {
    if (!change) return;
    if (change.label === "Data") previous.date = change.from;
    if (change.label === "Hora") previous.time = change.from;
    if (change.label === "Rival") previous.rival = change.from;
    if (change.label === "Lloc") previous.loc = change.from;
    if (change.label === "Casa/fora") previous.home = change.from === "casa";
    if (change.label === "Amistós") previous.friendly = change.from === "sí";
  });
  return previous;
}

function aplicarCanviManualAlCalendari(calendarData, game, changes) {
  var previous = taulaPartitAnterior(game, changes);
  var targetKey = taulaIdPartit(previous);
  var matched = false;
  var fallback = [];
  (calendarData.weeks || []).forEach(function(week) {
    (week.games || []).forEach(function(existing) {
      if (existing.team === previous.team && existing.sex === previous.sex && existing.rival === previous.rival) fallback.push(existing);
      if (taulaIdPartit(existing) !== targetKey) return;
      ["date", "time", "rival", "loc", "home", "friendly"].forEach(function(field) { existing[field] = game[field]; });
      matched = true;
    });
  });
  // Les edicions manuals viuen en un node separat del calendari importat.
  // Si aquest partit ja s'havia editat abans, la clau exacta pot no coincidir;
  // l'equip, el sexe i el rival identifiquen el mateix enfrontament.
  if (!matched && fallback.length === 1) {
    ["date", "time", "rival", "loc", "home", "friendly"].forEach(function(field) { fallback[0][field] = game[field]; });
    matched = true;
  }
  if (!matched) throw new Error("No s'ha trobat el partit original per verificar les taules.");
  return calendarData;
}

function incidenciesRestriccionsTaules(calendarData, assignments, rawProfiles) {
  var all = taulaTotsElsPartits(calendarData);
  var tableGames = all.filter(function(game) { return taulaEsPistaClub(game) && (game.fam === "MINI" || game.fam === "PREMINI" || game.friendly); });
  var gamesById = {};
  tableGames.forEach(function(game) { gamesById[taulaIdPartit(game)] = game; });
  var profiles = {};
  Object.keys(rawProfiles || {}).forEach(function(key) {
    var profile = rawProfiles[key];
    if (profile && profile.name) profiles[taulaNormalitza(profile.name)] = profile;
  });
  var issues = [];
  Object.keys(assignments || {}).forEach(function(assignmentId) {
    var assignment = assignments[assignmentId] || {};
    if (!assignment.table1 && !assignment.table2) return;
    var game = gamesById[assignmentId];
    if (!game && assignment.game) {
      var candidates = tableGames.filter(function(candidate) {
        return taulaClauPartit(candidate) === taulaClauPartit(assignment.game) && taulaDilluns(candidate.date) === taulaDilluns(assignment.game.date);
      });
      game = candidates.length === 1 ? candidates[0] : null;
    }
    if (!game) {
      issues.push({ fingerprint:"assignment-not-mapped|" + assignmentId, text:"Assignació sense partit mini coincident al calendari actual: " + assignmentId + "." });
      return;
    }
    var people = [assignment.table1 || "", assignment.table2 || ""].filter(Boolean);
    var gameText = game.date + " " + (game.time || "hora pendent") + " · " + taulaEtiquetaEquip(game) + " vs " + (game.rival || "rival pendent");
    if (assignment.table1 && assignment.table2 && assignment.table1 === assignment.table2) {
      issues.push({ fingerprint:"duplicate|" + taulaIdPartit(game) + "|" + taulaNormalitza(assignment.table1), text:gameText + ": " + assignment.table1 + " està assignada dues vegades." });
    }
    people.forEach(function(person) {
      var profile = profiles[taulaNormalitza(person)] || { active:true, experienced:false, playerTeams:[], assistantTeams:[] };
      var blockedTeams = taulaLlistaEquips(profile.playerTeams).concat(taulaLlistaEquips(profile.assistantTeams)).map(taulaEquipCanonical).map(taulaNormalitza);
      if (profile.active === false) issues.push({ fingerprint:"inactive|" + taulaIdPartit(game) + "|" + taulaNormalitza(person), text:gameText + ": " + person + " no està activa." });
      if (blockedTeams.indexOf(taulaNormalitza(taulaEtiquetaEquip(game))) !== -1) issues.push({ fingerprint:"own-team|" + taulaIdPartit(game) + "|" + taulaNormalitza(person), text:gameText + ": " + person + " juga o ajuda en aquest equip." });
      var part = taulaFranja(game);
      if (part) all.some(function(otherGame) {
        if (otherGame.date !== game.date || taulaFranja(otherGame) !== part || blockedTeams.indexOf(taulaNormalitza(taulaEtiquetaEquip(otherGame))) === -1) return false;
        issues.push({ fingerprint:"same-day|" + taulaIdPartit(game) + "|" + taulaNormalitza(person) + "|" + taulaIdPartit(otherGame), text:gameText + ": " + person + " té partit amb " + taulaEtiquetaEquip(otherGame) + " el mateix dia i franja de " + (part === "morning" ? "matí" : "tarda") + "." });
        return true;
      });
    });
    if (taulaNecessitaExperiencia(game) && !people.some(function(person) { return profiles[taulaNormalitza(person)] && profiles[taulaNormalitza(person)].experienced === true; })) {
      issues.push({ fingerprint:"experience|" + taulaIdPartit(game), text:gameText + ": aquest partit mini necessita almenys una persona amb experiència a la taula." });
    }
  });
  return issues;
}

function htmlRestriccionsTaules(issues) {
  var rows = issues.map(function(issue, index) {
    return '<tr><td style="padding:10px;border-bottom:1px solid #E5E5E5;color:#4B1D6D;font-weight:bold;vertical-align:top;">' + (index + 1) + '</td><td style="padding:10px;border-bottom:1px solid #E5E5E5;line-height:1.45;">' + escapeAlertHtml(issue.text) + '</td></tr>';
  }).join("");
  return '<div style="font-family:Helvetica,Arial,sans-serif;color:#333;max-width:620px;margin:0 auto;border:1px solid #E5E5E5;border-radius:8px;overflow:hidden;"><div style="background:#4B1D6D;padding:24px;text-align:center;border-bottom:4px solid #FFC72C;"><h1 style="color:#FFC72C;margin:0;font-size:22px;">CB SANT JOSEP BADALONA</h1><p style="color:#fff;margin:5px 0 0;font-size:13px;">Alerta de planificació de taules</p></div><div style="padding:24px;"><h2 style="color:#4B1D6D;margin:0 0 10px;font-size:18px;">Restriccions detectades</h2><p style="line-height:1.45;">S'ha verificat la planificació de taules després d'un canvi manual de calendari.</p><table style="width:100%;border-collapse:collapse;"><thead><tr style="background:#4B1D6D;color:#FFC72C;"><th style="padding:9px;text-align:left;">#</th><th style="padding:9px;text-align:left;">Incidència</th></tr></thead><tbody>' + rows + '</tbody></table><p style="text-align:center;margin:24px 0 0;"><a href="https://sam-1959.github.io/santpep26-27/taules-planificacio.html" style="background:#4B1D6D;color:#FFC72C;padding:11px 18px;text-decoration:none;font-weight:bold;border-radius:5px;">Revisar les restriccions</a></p></div></div>';
}

function verificarRestriccionsTaulesDespresCanviManual(game, changes) {
  var calendarData = aplicarCanviManualAlCalendari(llegirFirebase(CALENDAR_FIREBASE_PATH), game, changes);
  var issues = incidenciesRestriccionsTaules(calendarData, llegirFirebase(TABLE_ASSIGNMENTS_FIREBASE_PATH) || {}, llegirFirebase(TABLE_PEOPLE_FIREBASE_PATH) || {});
  var signature = issues.map(function(issue) { return issue.fingerprint; }).sort().join("\n");
  var previous = llegirFirebase(TABLE_RESTRICTIONS_ALERT_PATH) || {};
  var now = new Date().toISOString();
  var status = { checkedAt:now, changesDetected:1, issueCount:issues.length, lastIssueSignature:issues.length ? signature : "", lastIssues:issues.map(function(issue) { return issue.text; }) };
  if (!issues.length) {
    if (previous.lastIssueSignature) status.resolvedAt = now;
    escriureFirebase(TABLE_RESTRICTIONS_ALERT_PATH, status);
    return { checked:true, issues:0, emailed:false };
  }
  if (previous.lastIssueSignature === signature) {
    status.lastAlertAt = previous.lastAlertAt || "";
    escriureFirebase(TABLE_RESTRICTIONS_ALERT_PATH, status);
    return { checked:true, issues:issues.length, emailed:false, duplicate:true };
  }
  var recipient = correuCoordinacioGeneral();
  if (!recipient) throw new Error("No hi ha correu de Coordinació general configurat per a les restriccions de taules.");
  var body = ["S'han detectat " + issues.length + " incidència(es) de planificació després d'un canvi manual de calendari.", ""].concat(issues.map(function(issue) { return "- " + issue.text; })).join("\n");
  MailApp.sendEmail(recipient, "Alerta: restriccions de taules després d'un canvi manual", body, { htmlBody:htmlRestriccionsTaules(issues), name:"CB Sant Josep Badalona" });
  status.lastAlertAt = now;
  escriureFirebase(TABLE_RESTRICTIONS_ALERT_PATH, status);
  return { checked:true, issues:issues.length, emailed:true };
}

function usuariAutoritzat(email) {
  var contacts = llegirContactes();
  function contactList(group) {
    if (Array.isArray(group)) return group;
    if (group && typeof group === "object") return Object.keys(group).map(function(key) { return group[key]; });
    return [];
  }
  var authorized = []
    .concat(contactList(contacts.coordinators))
    .concat(contactList(contacts.headCoaches))
    .concat(contactList(contacts.physicalTrainers));
  return authorized.some(function(contact) {
    return contact && String(contact.email || "").trim().toLowerCase() === email;
  });
}

function correuCoordinacioGeneral() {
  var contacts = llegirContactes();
  var contact = (contacts.coordinators || []).filter(function(item) {
    return item && item.role === "general" && item.receivesTeamEmails !== false && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(item.email || "").trim());
  })[0];
  return contact ? String(contact.email).trim() : "";
}

function correuPrimerEntrenador(game) {
  var teamCode = OWN_TEAM_CODES[String(game.team || "") + "|" + String(game.sex || "")];
  if (!teamCode) return "";
  var contacts = llegirContactes();
  var contact = contacts.headCoaches && contacts.headCoaches[teamCode];
  var email = contact && String(contact.email || "").trim();
  if (!contact || contact.receivesTeamEmails === false || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
  return email;
}

function formatCalendarEmailDate(value) {
  var iso = String(value || "").trim();
  var match = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? match[3] + "/" + match[2] + "/" + match[1] : (iso || "sense data");
}

function calendarChangeDescription(change) {
  var game = change.game || {};
  var matchup = game.home ? game.team + " vs " + game.rival : game.rival + " vs " + game.team;
  var base = formatCalendarEmailDate(game.date) + " " + (game.time || "sense hora") + " · " + matchup;
  var details = (change.fields || []).map(function(field) {
    return field.label + ": " + (field.label === "Data" ? formatCalendarEmailDate(field.from) + " → " + formatCalendarEmailDate(field.to) : field.from + " → " + field.to);
  }).join(" · ");
  return "Partit modificat: " + base + (details ? "\n" + details : "");
}

function construirTextCanvisCalendar(teamLabel, changes) {
  return [
    "S'han detectat " + changes.length + " canvi(s) en el calendari de " + teamLabel + ".",
    ""
  ].concat(changes.map(function(change) { return "- " + calendarChangeDescription(change); })).concat([
    "",
    "Calendari de partits: https://sam-1959.github.io/santpep26-27/partits.html"
  ]).join("\n");
}

function escapeAlertHtml(value) {
  return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function calendarChangeEmailHtml(teamLabel, changes) {
  var rows = changes.map(function(change) {
    var game = change.game || {};
    var matchup = game.home ? game.team + " vs " + game.rival : game.rival + " vs " + game.team;
    var details = (change.fields || []).map(function(field) {
      var from = field.label === "Data" ? formatCalendarEmailDate(field.from) : field.from;
      var to = field.label === "Data" ? formatCalendarEmailDate(field.to) : field.to;
      return '<div style="margin-top:4px;"><strong>' + escapeAlertHtml(field.label) + ':</strong> <span style="color:#777;text-decoration:line-through;">' + escapeAlertHtml(from) + '</span> <span style="color:#4B1D6D;font-weight:700;">→ ' + escapeAlertHtml(to) + '</span></div>';
    }).join("");
    return '<tr><td style="padding:13px 10px;border-bottom:1px solid #E5E5E5;color:#333;line-height:1.45;vertical-align:top;"><div style="font-weight:700;color:#4B1D6D;font-size:15px;">' + escapeAlertHtml(matchup) + '</div><div style="color:#666;font-size:12px;margin-top:3px;">' + escapeAlertHtml(formatCalendarEmailDate(game.date) + " · " + (game.time || "sense hora")) + '</div></td><td style="padding:13px 10px;border-bottom:1px solid #E5E5E5;color:#333;line-height:1.45;vertical-align:top;"><span style="display:inline-block;padding:2px 6px;border-radius:4px;background:#F9F6FC;color:#4B1D6D;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;">Partit modificat</span>' + details + '</td></tr>';
  }).join("");
  return '<div style="font-family:Helvetica,Arial,sans-serif;color:#333;max-width:680px;margin:0 auto;border:1px solid #E5E5E5;border-radius:8px;overflow:hidden;"><div style="background:#4B1D6D;padding:24px;text-align:center;border-bottom:4px solid #FFC72C;"><h1 style="color:#FFC72C;margin:0;font-size:22px;text-transform:uppercase;">CB Sant Josep Badalona</h1><p style="color:#fff;margin:5px 0 0;font-size:13px;opacity:.9;">Actualització de calendari</p></div><div style="padding:24px;background:#fff;"><h2 style="color:#4B1D6D;margin:0 0 10px;font-size:18px;">Canvis per a ' + escapeAlertHtml(teamLabel) + '</h2><p style="margin:0 0 16px;line-height:1.45;">S’han detectat ' + changes.length + ' canvi(s) en el calendari de l’equip.</p><table style="border-collapse:collapse;width:100%;"><thead><tr style="background:#F9F6FC;"><th style="padding:9px 10px;text-align:left;color:#4B1D6D;">Partit</th><th style="padding:9px 10px;text-align:left;color:#4B1D6D;">Canvi</th></tr></thead><tbody>' + rows + '</tbody></table><div style="text-align:center;margin:24px 0 4px;"><a href="https://sam-1959.github.io/santpep26-27/partits.html" target="_blank" style="background:#4B1D6D;color:#FFC72C;padding:11px 20px;text-decoration:none;font-weight:bold;border-radius:5px;display:inline-block;">Calendari de partits</a></div></div><div style="background:#F4F4F4;padding:14px;text-align:center;border-top:1px solid #EEEEEE;font-size:12px;color:#666;">CB Sant Josep Badalona · Notificació automàtica</div></div>';
}

function respostaJson(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
