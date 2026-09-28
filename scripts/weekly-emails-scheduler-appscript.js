// Google Apps Script autònom per enviar els correus setmanals del portal.
//
// Objectiu:
// - No dependre de GitHub Actions per als avisos setmanals.
// - Llegir Firebase RTDB directament.
// - Enviar correus amb GmailApp.
// - Guardar estat a ScriptProperties per evitar duplicats.
//
// Configuració:
// 1) Crea un projecte nou a https://script.google.com/.
// 2) Enganxa aquest fitxer.
// 3) Executa `crearTriggersSetmanals()` una vegada i autoritza permisos.
// 4) Per provar sense enviar, executa `provarSetmanalVisitesFisioDryRun()` o
//    `provarSetmanalRpeDryRun()`.
//
// Nota horària:
// Apps Script programa per franges horàries, no garanteix minut exacte.

var FIREBASE_DB_URL = "https://coord-fa09e-default-rtdb.europe-west1.firebasedatabase.app";
var SEASON = "season-26-27";
var TIMEZONE = "Europe/Madrid";
var WEEK_OFFSET_DAYS = 7;

var PHYSIO_VISITS_PATH = "physioVisits/" + SEASON;
var WELLNESS_RESPONSES_PATH = "wellnessResponses/" + SEASON;
var RPE_ROSTERS_PATH = "rpeRosters/" + SEASON;
var CONTACTS_PATH = "seasonContacts/" + SEASON;

var FIXED_PHYSIO_VISITS_RECIPIENTS = [
  { email: "dtecnic@cbsantjosep.cat", name: "Direcció tècnica" }
];

var DEFAULT_TEAM_ORDER = ["CBM", "CAM", "CF", "JBM", "JAM", "JBF", "JAF", "SBM", "SAM", "SAF"];
var DEFAULT_TEAM_NAMES_BY_KEY = {
  CBM: "Cadet B M",
  CAM: "Cadet A M",
  CF: "Cadet F",
  IAM: "Infantil A M",
  IBM: "Infantil B M",
  IF: "Infantil F",
  JBM: "Júnior B M",
  JAM: "Júnior A M",
  JBF: "Júnior B F",
  JAF: "Júnior A F",
  SBM: "Sènior B M",
  SAM: "Sènior A M",
  SAF: "Sènior A F"
};

function doGet() {
  return jsonResponse({
    ok: true,
    service: "Sant Pep weekly emails",
    firebase: FIREBASE_DB_URL,
    handlers: [
      "crearTriggersSetmanals",
      "enviarSetmanalRpe",
      "enviarSetmanalVisitesFisio",
      "provarSetmanalRpeDryRun",
      "provarSetmanalVisitesFisioDryRun"
    ],
    checkedAt: nowIso()
  });
}

function doPost(e) {
  try {
    var request = JSON.parse((e.postData && e.postData.contents) || "{}");
    if (request.type === "physio_visits_weekly") {
      return jsonResponse(enviarCorreuVisitesFisioPayload(request));
    }
    if (request.type === "rpe_weekly_grouped" || request.teams) {
      return jsonResponse(enviarCorreuRpePayload(request));
    }
    throw new Error("Tipus de petició no suportat: " + valor(request.type));
  } catch (error) {
    Logger.log("Error doPost avisos setmanals: " + error);
    return jsonResponse({ ok: false, error: String(error) });
  }
}

function enviarCorreuVisitesFisioPayload(payload) {
  var recipients = normalitzarCorreus(payload.recipient || "");
  if (!recipients.length) throw new Error("No hi ha destinataris configurats.");
  sendEmailToRecipients(
    recipients,
    "Resum setmanal de visites de fisioteràpia - " + valor(payload.weekLabel),
    buildPhysioVisitsText(payload),
    buildPhysioVisitsHtml(payload)
  );
  return { ok: true, sentTo: recipients, sentCount: recipients.length };
}

function enviarCorreuRpePayload(payload) {
  var recipients = normalitzarCorreus(payload.recipient || "");
  if (!recipients.length) throw new Error("No hi ha destinataris configurats.");
  sendEmailToRecipients(
    recipients,
    "Seguiment RPE setmanal - " + valor(payload.weekLabel),
    buildRpeGroupedText(payload),
    buildRpeGroupedHtml(payload)
  );
  return { ok: true, sentTo: recipients, sentCount: recipients.length };
}

function crearTriggersSetmanals() {
  eliminarTriggersSetmanals();

  ScriptApp.newTrigger("enviarSetmanalRpe")
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(9)
    .nearMinute(15)
    .inTimezone(TIMEZONE)
    .create();

  ScriptApp.newTrigger("enviarSetmanalVisitesFisio")
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(9)
    .nearMinute(30)
    .inTimezone(TIMEZONE)
    .create();
}

function eliminarTriggersSetmanals() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    var handler = trigger.getHandlerFunction();
    if (handler === "enviarSetmanalRpe" || handler === "enviarSetmanalVisitesFisio") {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

function provarSetmanalRpeDryRun() {
  return enviarSetmanalRpe({ dryRun: true, force: true });
}

function provarSetmanalVisitesFisioDryRun() {
  return enviarSetmanalVisitesFisio({ dryRun: true, force: true });
}

function enviarSetmanalVisitesFisio(options) {
  options = options || {};
  var selectedWeek = selectedWeekKey();
  var stateKey = "physioVisitsWeekly:" + selectedWeek;
  if (!options.force && alreadySent(stateKey)) {
    Logger.log("Visites Fisio ja enviat per la setmana " + selectedWeek + ".");
    return { status: "already_sent", week: selectedWeek };
  }

  var dates = weekDates(selectedWeek);
  var visitsData = readFirebase(PHYSIO_VISITS_PATH) || {};
  var contacts = readFirebase(CONTACTS_PATH) || {};
  var records = Object.keys(visitsData)
    .map(function(id) { return normalizeVisit(visitsData[id] || {}, id); })
    .filter(function(record) { return dates.indexOf(record.date) !== -1; })
    .sort(function(a, b) {
      return String(a.date).localeCompare(String(b.date)) || String(a.name).localeCompare(String(b.name), "ca");
    });

  if (!records.length) {
    setState(stateKey, { status: "skipped_no_data", week: selectedWeek, at: nowIso(), records: 0 });
    Logger.log("No s'envia Visites Fisio: no hi ha dades.");
    return { status: "skipped_no_data", week: selectedWeek };
  }

  var recipients = weeklyPhysioRecipients(contacts);
  var payload = buildPhysioVisitsPayload(selectedWeek, dates, records);
  if (options.dryRun) {
    Logger.log("[DRY_RUN] Visites Fisio a " + recipients.names.join(", ") + ". Registres: " + records.length);
    return { status: "dry_run", recipients: recipients.names, records: records.length };
  }

  sendEmailToRecipients(
    recipients.emails,
    "Resum setmanal de visites de fisioteràpia - " + payload.weekLabel,
    buildPhysioVisitsText(payload),
    buildPhysioVisitsHtml(payload)
  );
  setState(stateKey, {
    status: "sent",
    week: selectedWeek,
    weekLabel: payload.weekLabel,
    at: nowIso(),
    recipients: recipients.emails,
    recipientNames: recipients.names,
    records: records.length,
    players: payload.summary.players
  });
  return { status: "sent", recipients: recipients.names, records: records.length };
}

function enviarSetmanalRpe(options) {
  options = options || {};
  var selectedWeek = selectedWeekKey();
  var stateKey = "rpeWeekly:" + selectedWeek;
  if (!options.force && alreadySent(stateKey)) {
    Logger.log("ERP ja enviat per la setmana " + selectedWeek + ".");
    return { status: "already_sent", week: selectedWeek };
  }

  var dates = weekDates(selectedWeek);
  var contacts = readFirebase(CONTACTS_PATH) || {};
  var rostersData = readFirebase(RPE_ROSTERS_PATH) || {};
  var rosterInfo = loadRosterInfo(rostersData);
  var responses = readFirebase(WELLNESS_RESPONSES_PATH) || {};
  var allRecords = Object.keys(responses).map(function(id) {
    return normalizeRpeRecord(responses[id] || {}, id, rosterInfo);
  });
  var recipientMap = {};
  var teamResults = [];

  selectedTeamKeys(rosterInfo.teamNamesByKey).forEach(function(teamKey) {
    var teamName = rosterInfo.teamNamesByKey[teamKey] || teamKey;
    var records = allRecords.filter(function(record) {
      return record.teamKey === teamKey && dates.indexOf(record.trainingDate) !== -1;
    });
    if (!records.length) {
      teamResults.push({ teamKey: teamKey, status: "skipped_no_data", records: 0 });
      Logger.log("No s'envia ERP " + teamKey + ": sense dades.");
      return;
    }
    var recipients = rpeRecipientsForTeam(teamKey, contacts);
    var teamPayload = buildRpeTeamPayload(teamKey, teamName, selectedWeek, dates, records, rosterInfo);
    recipients.contacts.forEach(function(contact) {
      addRecipientTeamPayload(recipientMap, contact, teamPayload);
    });
    teamResults.push({ teamKey: teamKey, status: "prepared", records: records.length });
  });

  var recipientKeys = Object.keys(recipientMap);
  if (!recipientKeys.length) {
    setState(stateKey, { status: "skipped_no_data", week: selectedWeek, at: nowIso(), teams: teamResults });
    return { status: "skipped_no_data", week: selectedWeek };
  }

  if (options.dryRun) {
    Logger.log("[DRY_RUN] ERP destinataris: " + recipientKeys.map(function(key) { return recipientMap[key].name; }).join(", "));
    return { status: "dry_run", recipients: recipientKeys.length, teams: teamResults };
  }

  recipientKeys.forEach(function(key) {
    var recipient = recipientMap[key];
    var payload = {
      week: selectedWeek,
      weekLabel: weekRangeLabel(selectedWeek),
      teams: recipient.teams
    };
    sendEmailToRecipients(
      [recipient.email],
      "Seguiment RPE setmanal - " + payload.weekLabel,
      buildRpeGroupedText(payload),
      buildRpeGroupedHtml(payload)
    );
  });

  setState(stateKey, {
    status: "sent",
    week: selectedWeek,
    weekLabel: weekRangeLabel(selectedWeek),
    at: nowIso(),
    recipients: recipientKeys.map(function(key) { return recipientMap[key].email; }),
    recipientNames: recipientKeys.map(function(key) { return recipientMap[key].name; }),
    teams: teamResults
  });
  return { status: "sent", recipients: recipientKeys.length, teams: teamResults };
}

function readFirebase(path) {
  var url = FIREBASE_DB_URL.replace(/\/$/, "") + "/" + path.split("/").map(encodeURIComponent).join("/") + ".json";
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  var code = response.getResponseCode();
  var text = response.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error("No s'ha pogut llegir " + path + ": HTTP " + code + " " + text);
  }
  return text ? JSON.parse(text) : null;
}

function sendEmailToRecipients(emails, subject, textBody, htmlBody) {
  normalitzarCorreus(emails).forEach(function(email) {
    GmailApp.sendEmail(email, subject, textBody, {
      htmlBody: htmlBody,
      name: "CB Sant Josep Badalona"
    });
    Logger.log("Correu enviat a: " + email);
  });
}

function selectedWeekKey() {
  return isoFromDate(mondayOf(addDays(dateInMadrid(), -WEEK_OFFSET_DAYS)));
}

function dateInMadrid() {
  var formatted = Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd");
  return dateFromISO(formatted);
}

function isoFromDate(date) {
  return Utilities.formatDate(date, TIMEZONE, "yyyy-MM-dd");
}

function dateFromISO(value) {
  var parts = String(value || "").split("-").map(Number);
  return parts[0] && parts[1] && parts[2] ? new Date(parts[0], parts[1] - 1, parts[2]) : null;
}

function mondayOf(date) {
  var copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  var day = copy.getDay() || 7;
  copy.setDate(copy.getDate() - day + 1);
  return copy;
}

function addDays(date, days) {
  var copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  copy.setDate(copy.getDate() + days);
  return copy;
}

function weekDates(weekKey) {
  var start = dateFromISO(weekKey);
  return Array.from({ length: 7 }, function(_, index) {
    return isoFromDate(addDays(start, index));
  });
}

function formatDate(value) {
  var parts = String(value || "").split("-");
  return parts[0] && parts[1] && parts[2] ? parts[2] + "/" + parts[1] + "/" + parts[0] : value || "—";
}

function formatShortDate(value) {
  var parts = String(value || "").split("-");
  return parts[1] && parts[2] ? parts[2] + "/" + parts[1] : value || "—";
}

function formatDateTime(value) {
  if (!value) return "—";
  var date = new Date(value);
  if (isNaN(date.getTime())) return String(value);
  return Utilities.formatDate(date, TIMEZONE, "dd/MM/yyyy HH:mm");
}

function weekRangeLabel(key) {
  var start = dateFromISO(key);
  return formatDate(isoFromDate(start)) + " – " + formatDate(isoFromDate(addDays(start, 6)));
}

function nowIso() {
  return new Date().toISOString();
}

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function normalitzarCorreus(value) {
  var values = Array.isArray(value) ? value : String(value || "").split(/[,\n;]/);
  var seen = {};
  return values.map(function(email) {
    return String(email || "").trim();
  }).filter(function(email) {
    var key = email.toLowerCase();
    if (!isValidEmail(email) || seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function contactName(contact) {
  return contact && contact.name ? contact.name : contact && contact.email ? contact.email : "";
}

function recipientKey(email) {
  return String(email || "").trim().toLowerCase().replace(/[.#$\[\]\/]/g, "_");
}

function getProps() {
  return PropertiesService.getScriptProperties();
}

function alreadySent(key) {
  var raw = getProps().getProperty(key);
  if (!raw) return false;
  try {
    return JSON.parse(raw).status === "sent";
  } catch (error) {
    return false;
  }
}

function setState(key, value) {
  getProps().setProperty(key, JSON.stringify(value));
}

function valor(input) {
  return input == null || input === "" ? "—" : String(input);
}

function escaparHtml(input) {
  return valor(input).replace(/[&<>"']/g, function(char) {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    }[char];
  });
}

function numeric(value) {
  var num = Number(value);
  return isFinite(num) ? num : 0;
}

function average(records, field) {
  var values = records.map(function(item) { return numeric(item[field]); }).filter(function(value) { return value > 0; });
  if (!values.length) return null;
  return values.reduce(function(sum, value) { return sum + value; }, 0) / values.length;
}

function formatNumber(value, decimals) {
  decimals = decimals == null ? 1 : decimals;
  return value === null || value === undefined || isNaN(value)
    ? "—"
    : Number(value).toLocaleString("ca-ES", { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
}

function teamCategory(value) {
  var code = normalize(value).toUpperCase();
  if (code.indexOf("I") === 0) return "INFANTIL";
  if (code.indexOf("M") === 0) return "MINI";
  if (code.indexOf("C") === 0) return "CADET";
  if (code.indexOf("J") === 0) return "JÚNIOR";
  if (code.indexOf("S") === 0) return "SÉNIOR";
  return value || "—";
}

function courtStatusLabel(value) {
  var labels = {
    pending: "Pendent",
    red: "No pista",
    orange: "Pista condicionada",
    green: "Pista normal"
  };
  return labels[value] || labels.pending;
}

function visitTypeValue(value, assignedPhysio) {
  var normalized = String(value || "").trim().toLowerCase();
  if (normalized === "readaptacio" || normalized === "readaptació") return "readaptacio";
  if (normalized === "fisio" || normalized === "fisioterapia" || normalized === "fisioteràpia") return "fisio";
  return String(assignedPhysio || "").trim() === "Miquel Sánchez" ? "readaptacio" : "fisio";
}

function visitTypeLabel(value, assignedPhysio) {
  return visitTypeValue(value, assignedPhysio) === "readaptacio" ? "Readaptació" : "Fisioteràpia";
}

function shortVisitTypeLabel(value, assignedPhysio) {
  return visitTypeValue(value, assignedPhysio) === "readaptacio" ? "Readap." : "Fisio";
}

function normalizeVisit(row, id) {
  return {
    id: id,
    createdAt: row.createdAt || "",
    updatedAt: row.updatedAt || "",
    date: row.date || "",
    name: row.name || [row.firstName, row.lastName].filter(Boolean).join(" "),
    team: row.team || "",
    teamCategory: teamCategory(row.team || ""),
    assignedPhysio: row.assignedPhysio || row.physio || "",
    visitType: visitTypeValue(row.visitType, row.assignedPhysio || row.physio || ""),
    structure: row.structure || "",
    location: row.location || "",
    guidelines: row.guidelines || "",
    courtStatus: row.courtStatus || "pending",
    prepaRead: Boolean(row.prepaRead),
    prepaReadAt: row.prepaReadAt || "",
    prepaFeedbackText: row.prepaFeedback && row.prepaFeedback.text || "",
    prepaFeedbackAt: row.prepaFeedback && row.prepaFeedback.updatedAt || ""
  };
}

function weeklyPhysioRecipients(contacts) {
  var coordinators = Array.isArray(contacts.coordinators) ? contacts.coordinators : [];
  var includedRoles = { masculi: true, femeni: true, coordinador_prepa: true, dt: true, prepa: true };
  var all = coordinators.filter(function(contact) {
    return includedRoles[String(contact.role || "").trim()];
  }).concat(FIXED_PHYSIO_VISITS_RECIPIENTS);
  return contactsToRecipients(all, "No hi ha destinataris vàlids per al resum setmanal de Visites Fisio.");
}

function contactsToRecipients(contacts, errorMessage) {
  var byEmail = {};
  contacts.forEach(function(contact) {
    var email = String(contact && contact.email || "").trim();
    if (!isValidEmail(email)) return;
    var key = email.toLowerCase();
    if (!byEmail[key]) byEmail[key] = { email: email, name: contactName(contact) || email };
  });
  var list = Object.keys(byEmail).map(function(key) { return byEmail[key]; });
  if (!list.length) throw new Error(errorMessage);
  return {
    emails: list.map(function(item) { return item.email; }),
    names: list.map(function(item) { return item.name; })
  };
}

function buildPhysioVisitsPayload(selectedWeek, dates, records) {
  var players = groupPhysioByPlayer(records).map(function(group) {
    var latest = group.latest;
    return {
      player: group.player,
      visits: group.visits,
      latestDate: formatDate(latest.date),
      team: latest.team || "—",
      teamCategory: latest.teamCategory || "—",
      assignedPhysio: latest.assignedPhysio || "—",
      visitType: visitTypeLabel(latest.visitType, latest.assignedPhysio),
      courtStatus: courtStatusLabel(latest.courtStatus),
      structure: latest.structure || "—",
      location: latest.location || "—",
      guidelines: latest.guidelines || "Sense pauta",
      prepaRead: latest.prepaRead ? "Sí" : "No",
      prepaReadAt: latest.prepaReadAt ? formatDateTime(latest.prepaReadAt) : "—",
      prepaFeedback: latest.prepaFeedbackText || "—"
    };
  });
  var byType = {};
  var byCourt = {};
  records.forEach(function(record) {
    var typeLabel = visitTypeLabel(record.visitType, record.assignedPhysio);
    var courtLabel = courtStatusLabel(record.courtStatus);
    byType[typeLabel] = (byType[typeLabel] || 0) + 1;
    byCourt[courtLabel] = (byCourt[courtLabel] || 0) + 1;
  });
  return {
    week: selectedWeek,
    weekLabel: weekRangeLabel(selectedWeek),
    summary: {
      records: records.length,
      players: players.length,
      from: formatDate(dates[0]),
      to: formatDate(dates[dates.length - 1]),
      byType: byType,
      byCourt: byCourt
    },
    visits: records.map(function(record) {
      return {
        date: formatShortDate(record.date),
        player: record.name || "—",
        teamCategory: record.teamCategory || "—",
        assignedPhysio: record.assignedPhysio || "—",
        visitType: shortVisitTypeLabel(record.visitType, record.assignedPhysio),
        courtStatus: courtStatusLabel(record.courtStatus),
        structure: record.structure || "—",
        location: record.location || "—",
        guidelines: record.guidelines || "Sense pauta"
      };
    }),
    players: players
  };
}

function groupPhysioByPlayer(records) {
  var groups = {};
  records.forEach(function(record) {
    var key = normalize(record.name) || record.id;
    if (!groups[key]) groups[key] = { player: record.name || "Sense nom", records: [] };
    groups[key].records.push(record);
  });
  return Object.keys(groups).map(function(key) {
    var sorted = groups[key].records.sort(function(a, b) {
      return String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt));
    });
    return { player: groups[key].player, visits: sorted.length, latest: sorted[0] || {} };
  }).sort(function(a, b) {
    return a.player.localeCompare(b.player, "ca");
  });
}

function buildPhysioVisitsText(payload) {
  var lines = [
    "CB SANT JOSEP BADALONA",
    "",
    "Resum setmanal de visites de fisioteràpia",
    "Setmana: " + payload.weekLabel,
    "",
    "Resum:",
    "- Visites: " + payload.summary.records,
    "- Jugador/es amb visita: " + payload.summary.players,
    "- Període: " + payload.summary.from + " - " + payload.summary.to,
    "",
    "Visites de la setmana:"
  ];
  payload.visits.forEach(function(visit) {
    lines.push(
      valor(visit.date) + " · " + valor(visit.player) + " · " + valor(visit.teamCategory),
      "  Visita: " + valor(visit.assignedPhysio) + " · " + valor(visit.visitType),
      "  Pista: " + valor(visit.courtStatus),
      "  Pautes: " + valor(visit.guidelines),
      ""
    );
  });
  return lines.join("\n");
}

function buildPhysioVisitsHtml(payload) {
  return emailShell(
    "Resum setmanal de visites de fisioteràpia",
    '<h2 style="color:#4B1D6D;margin:0 0 4px;font-size:20px;">Setmana ' + escaparHtml(payload.weekLabel) + '</h2>' +
    '<p style="margin:0 0 18px;color:#666;font-weight:bold;">' + escaparHtml(payload.summary.from) + ' - ' + escaparHtml(payload.summary.to) + '</p>' +
    '<table style="width:100%;border-collapse:collapse;margin-bottom:20px;"><tr>' +
      kpi("Visites", payload.summary.records) +
      kpi("Jugador/es", payload.summary.players) +
      kpi("Fisioteràpia", payload.summary.byType["Fisioteràpia"] || 0) +
      kpi("Readaptació", payload.summary.byType["Readaptació"] || 0) +
    '</tr></table>' +
    physioCourtSummary(payload.summary.byCourt) +
    physioVisitsTable(payload.visits)
  );
}

function physioCourtSummary(byCourt) {
  byCourt = byCourt || {};
  return '<div style="margin:0 0 18px;">' +
    ["Pendent", "No pista", "Pista condicionada", "Pista normal"].map(function(label) {
      return '<span style="display:inline-block;margin:3px 6px 3px 0;padding:5px 9px;border-radius:999px;background:#F9F6FC;color:#4B1D6D;font-size:12px;font-weight:bold;">' +
        escaparHtml(label) + ': ' + escaparHtml(byCourt[label] || 0) + '</span>';
    }).join("") +
    '</div>';
}

function physioVisitsTable(visits) {
  var rows = visits.map(function(visit) {
    return '<tr>' +
      emailCell(visit.date, "5%", false, true, false) +
      emailCell(visit.player, "17%", true, true, true) +
      emailCell(visit.teamCategory, "7%", false, true, true) +
      emailCell(visit.assignedPhysio, "13%", false, true, true) +
      emailCell(visit.visitType, "9%", false, true, true) +
      emailCell(visit.structure, "10%", false, false, true) +
      emailCell(visit.location, "9%", false, false, true) +
      emailCell(visit.courtStatus, "7%", false, false, true) +
      emailCell(visit.guidelines, "23%", false, false, true) +
      '</tr>';
  }).join("");
  return '<h3 style="color:#4B1D6D;margin:20px 0 8px;font-size:16px;">Visites de la setmana</h3>' +
    '<table style="width:100%;border-collapse:collapse;margin-bottom:12px;font-size:11px;table-layout:fixed;">' +
    '<colgroup><col style="width:5%;"><col style="width:17%;"><col style="width:7%;"><col style="width:13%;"><col style="width:9%;"><col style="width:10%;"><col style="width:9%;"><col style="width:7%;"><col style="width:23%;"></colgroup>' +
    '<thead><tr style="background-color:#4B1D6D;color:#FFC72C;">' +
    emailHead("Data", false) + emailHead("Jugador/a", true) + emailHead("Equip", true) + emailHead("Visita", true) + emailHead("Tipus", true) + emailHead("Estructura", true) + emailHead("Localització", true) + emailHead("Pista", true) + emailHead("Pautes", true) +
    '</tr></thead><tbody>' + (rows || '<tr><td style="padding:10px;" colspan="9">No hi ha dades.</td></tr>') + '</tbody></table>';
}

function loadRosterInfo(data) {
  var teamNamesByKey = {};
  Object.keys(DEFAULT_TEAM_NAMES_BY_KEY).forEach(function(key) {
    teamNamesByKey[key] = DEFAULT_TEAM_NAMES_BY_KEY[key];
  });
  var teamRosters = {};
  Object.keys(data || {}).forEach(function(key) {
    var normalizedKey = String(key || "").trim().toUpperCase();
    var team = data[key] || {};
    var name = String(team.name || teamNamesByKey[normalizedKey] || normalizedKey).trim();
    var players = Array.isArray(team.players)
      ? team.players.map(function(player) {
        return [String(player.number || ""), String(player.name || "").trim()];
      }).filter(function(item) { return item[1]; })
      : [];
    teamNamesByKey[normalizedKey] = name;
    if (players.length) teamRosters[name] = players;
  });
  return { teamNamesByKey: teamNamesByKey, teamRosters: teamRosters };
}

function selectedTeamKeys(teamNamesByKey) {
  var keys = Object.keys(teamNamesByKey || {});
  return DEFAULT_TEAM_ORDER.filter(function(key) { return keys.indexOf(key) !== -1; })
    .concat(keys.filter(function(key) { return DEFAULT_TEAM_ORDER.indexOf(key) === -1; }).sort());
}

function rosterNumber(rosterInfo, team, player) {
  var roster = rosterInfo.teamRosters[team] || [];
  var normalizedPlayer = normalize(player);
  var match = roster.filter(function(item) { return normalize(item[1]) === normalizedPlayer; })[0];
  return match ? match[0] : "";
}

function numberSortValue(value) {
  var numericValue = Number(String(value || "").replace(/\D/g, ""));
  return isFinite(numericValue) ? numericValue : 9999;
}

function normalizeRpeRecord(record, id, rosterInfo) {
  var teamKey = String(record.teamKey || "").trim().toUpperCase() || "JBF";
  var fallbackTeam = rosterInfo.teamNamesByKey[teamKey] || DEFAULT_TEAM_NAMES_BY_KEY[teamKey] || "Júnior B F";
  var durationTotalMinutes = numeric(record.durationTotalMinutes) || numeric(record.durationHours) * 60 + numeric(record.durationMinutes);
  var rpe = numeric(record.rpe);
  return {
    id: id,
    teamKey: teamKey,
    team: record.team || fallbackTeam,
    player: record.player || "",
    playerNumber: record.playerNumber || rosterNumber(rosterInfo, record.team || fallbackTeam, record.player),
    trainingDate: record.trainingDate || "",
    durationTotalMinutes: durationTotalMinutes,
    rpe: rpe,
    muscleFatigue: numeric(record.muscleFatigue),
    sleepQuality: numeric(record.sleepQuality),
    load: numeric(record.load) || rpe * durationTotalMinutes
  };
}

function coordinatorRoleForTeam(teamKey) {
  return String(teamKey || "").toUpperCase().slice(-1) === "F" ? "femeni" : "masculi";
}

function rpeRecipientsForTeam(teamKey, contacts) {
  var role = coordinatorRoleForTeam(teamKey);
  var coordinators = Array.isArray(contacts.coordinators) ? contacts.coordinators : [];
  var coordinator = coordinators.filter(function(contact) { return String(contact.role || "") === role; })[0];
  var prepaCoordinator = coordinators.filter(function(contact) { return String(contact.role || "") === "coordinador_prepa"; })[0];
  var technicalDirector = coordinators.filter(function(contact) { return String(contact.role || "") === "dt"; })[0];
  var headCoach = contacts.headCoaches && contacts.headCoaches[teamKey];
  var prepas = coordinators.filter(function(contact) {
    return String(contact.role || "") === "prepa" &&
      Array.isArray(contact.teams) &&
      contact.teams.map(function(team) { return String(team || "").trim().toUpperCase(); }).indexOf(teamKey) !== -1;
  });
  var contactsList = [coordinator, headCoach, prepaCoordinator, technicalDirector].concat(prepas);
  return { contacts: uniqueContacts(contactsList) };
}

function uniqueContacts(contacts) {
  var byEmail = {};
  contacts.forEach(function(contact) {
    var email = String(contact && contact.email || "").trim();
    if (!isValidEmail(email)) return;
    var key = email.toLowerCase();
    if (!byEmail[key]) byEmail[key] = { email: email, name: contactName(contact) || email };
  });
  return Object.keys(byEmail).map(function(key) { return byEmail[key]; });
}

function addRecipientTeamPayload(map, contact, teamPayload) {
  var email = String(contact && contact.email || "").trim();
  if (!isValidEmail(email)) return;
  var key = recipientKey(email);
  if (!map[key]) map[key] = { email: email, name: contactName(contact) || email, teams: [] };
  if (!map[key].teams.some(function(team) { return team.teamKey === teamPayload.teamKey; })) {
    map[key].teams.push(teamPayload);
  }
}

function buildRpeTeamPayload(teamKey, team, selectedWeek, dates, records, rosterInfo) {
  var groups = {};
  records.forEach(function(record) {
    var key = record.player || "Sense nom";
    if (!groups[key]) groups[key] = { player: key, team: record.team, records: [] };
    groups[key].records.push(record);
  });
  var players = Object.keys(groups).map(function(key) {
    var group = groups[key];
    var rpeAvg = average(group.records, "rpe");
    var fatigueAvg = average(group.records, "muscleFatigue");
    var sleepAvg = average(group.records, "sleepQuality");
    var loadTotal = group.records.reduce(function(sum, record) { return sum + numeric(record.load); }, 0);
    var numberedRecord = group.records.filter(function(record) { return record.playerNumber; })[0];
    var number = rosterNumber(rosterInfo, team, group.player) || (numberedRecord ? numberedRecord.playerNumber : "") || "";
    return {
      player: group.player,
      team: group.team,
      number: number,
      records: group.records,
      rpe: rpeAvg,
      fatigue: fatigueAvg,
      sleep: sleepAvg,
      load: loadTotal
    };
  }).sort(function(a, b) {
    return numberSortValue(a.number) - numberSortValue(b.number) || a.player.localeCompare(b.player, "ca");
  });
  var totalLoad = records.reduce(function(sum, record) { return sum + numeric(record.load); }, 0);
  var rpeHigh = players.filter(function(group) { return alertLabels(group).indexOf("RPE") !== -1; }).map(function(group) { return group.player; });
  var fatigueHigh = players.filter(function(group) { return alertLabels(group).indexOf("Fatiga") !== -1; }).map(function(group) { return group.player; });
  var sleepLow = players.filter(function(group) { return alertLabels(group).indexOf("Son") !== -1; }).map(function(group) { return group.player; });
  return {
    teamKey: teamKey,
    team: team,
    week: selectedWeek,
    weekLabel: weekRangeLabel(selectedWeek),
    summary: {
      records: records.length,
      rpe: formatNumber(average(records, "rpe")),
      fatigue: formatNumber(average(records, "muscleFatigue")),
      sleep: formatNumber(average(records, "sleepQuality")),
      load: totalLoad ? Math.round(totalLoad).toLocaleString("ca-ES") : "—",
      alerts: { rpe: rpeHigh, fatigue: fatigueHigh, sleep: sleepLow }
    },
    dates: dates.map(function(date) { return { iso: date, label: formatDate(date).slice(0, 5) }; }),
    players: players.map(function(group) {
      return {
        number: group.number,
        player: group.player,
        alerts: alertLabels(group),
        rpe: valuesFor(group, dates, function(record) { return record.rpe; }),
        fatigue: valuesFor(group, dates, function(record) { return record.muscleFatigue; }),
        sleep: valuesFor(group, dates, function(record) { return record.sleepQuality; }),
        load: valuesFor(group, dates, function(record) { return record.load; }).map(function(value) { return value === "" ? "" : Math.round(value); }),
        averages: {
          rpe: formatNumber(group.rpe),
          fatigue: formatNumber(group.fatigue),
          sleep: formatNumber(group.sleep),
          load: Math.round(group.load).toLocaleString("ca-ES")
        }
      };
    })
  };
}

function valuesFor(group, dates, fieldFn) {
  return dates.map(function(date) {
    var dayRecords = group.records.filter(function(record) { return record.trainingDate === date; });
    if (!dayRecords.length) return "";
    var value = dayRecords.reduce(function(sum, record) { return sum + numeric(fieldFn(record)); }, 0) / dayRecords.length;
    return Math.round(value * 10) / 10;
  });
}

function alertLabels(group) {
  var labels = [];
  if (group.rpe !== null && group.rpe >= 8) labels.push("RPE");
  if (group.fatigue !== null && group.fatigue >= 4) labels.push("Fatiga");
  if (group.sleep !== null && group.sleep <= 2) labels.push("Son");
  return labels;
}

function buildRpeGroupedText(payload) {
  var lines = ["CB SANT JOSEP BADALONA", "", "Seguiment RPE setmanal", "Setmana: " + payload.weekLabel, ""];
  payload.teams.forEach(function(team) {
    lines.push("==== " + team.team + " ====");
    lines.push("Registres: " + team.summary.records);
    lines.push("RPE mitjà: " + team.summary.rpe);
    lines.push("Fatiga mitjana: " + team.summary.fatigue);
    lines.push("Son mitjana: " + team.summary.sleep);
    lines.push("Càrrega total: " + team.summary.load);
    lines.push("Alertes RPE: " + alertesResum(team.summary.alerts.rpe));
    lines.push("Alertes Fatiga: " + alertesResum(team.summary.alerts.fatigue));
    lines.push("Alertes Son: " + alertesResum(team.summary.alerts.sleep));
    lines.push("");
  });
  return lines.join("\n");
}

function buildRpeGroupedHtml(payload) {
  return emailShell(
    "Seguiment RPE setmanal",
    '<p style="margin:0 0 18px;color:#666;font-weight:bold;">Setmana ' + escaparHtml(payload.weekLabel) + '</p>' +
    payload.teams.map(function(team) {
      return '<div style="margin:0 0 28px;padding-bottom:22px;border-bottom:3px solid #F1E8F7;">' +
        '<h2 style="color:#4B1D6D;margin:0 0 14px;font-size:20px;">' + escaparHtml(team.team) + '</h2>' +
        '<table style="width:100%;border-collapse:collapse;margin-bottom:20px;"><tr>' +
          kpi("Registres", team.summary.records) +
          kpi("RPE mitjà", team.summary.rpe) +
          kpi("Fatiga mitjana", team.summary.fatigue) +
          kpi("Son mitjana", team.summary.sleep) +
          kpi("Càrrega total", team.summary.load) +
        '</tr></table>' +
        rpeAlertsBlock(team.summary.alerts) +
        rpeMetricTable("RPE", team.dates, team.players, "rpe", "rpe") +
        rpeMetricTable("Fatiga", team.dates, team.players, "fatigue", "fatigue") +
        rpeMetricTable("Qualitat de la son", team.dates, team.players, "sleep", "sleep") +
        rpeMetricTable("Càrrega", team.dates, team.players, "load", "load") +
      '</div>';
    }).join("")
  );
}

function rpeAlertsBlock(alerts) {
  alerts = alerts || {};
  return '<div style="margin:0 0 20px;padding:14px;background:#FFFDF3;border:1px solid #F0D66A;border-radius:8px;">' +
    '<h3 style="color:#4B1D6D;margin:0 0 10px;font-size:16px;">Alertes</h3>' +
    '<table style="width:100%;border-collapse:collapse;font-size:13px;">' +
    '<tr><td style="padding:8px;border-bottom:1px solid #F5E9A8;font-weight:bold;color:#8A1F1F;">RPE alt</td><td style="padding:8px;border-bottom:1px solid #F5E9A8;">' + escaparHtml(alertesResum(alerts.rpe)) + '</td></tr>' +
    '<tr><td style="padding:8px;border-bottom:1px solid #F5E9A8;font-weight:bold;color:#8A3D00;">Fatiga alta</td><td style="padding:8px;border-bottom:1px solid #F5E9A8;">' + escaparHtml(alertesResum(alerts.fatigue)) + '</td></tr>' +
    '<tr><td style="padding:8px;font-weight:bold;color:#6B5200;">Son baixa</td><td style="padding:8px;">' + escaparHtml(alertesResum(alerts.sleep)) + '</td></tr>' +
    '</table></div>';
}

function rpeMetricTable(title, dates, players, field, averageField) {
  var headerDates = dates.map(function(date) {
    return '<th style="padding:8px;border-bottom:1px solid #E5E5E5;text-align:center;">' + escaparHtml(date.label || date.iso) + '</th>';
  }).join("");
  var rows = players.map(function(player) {
    var values = (player[field] || []).map(function(value) {
      return '<td style="padding:8px;border-bottom:1px solid #E5E5E5;text-align:center;">' + escaparHtml(value === "" || value == null ? "—" : value) + '</td>';
    }).join("");
    return '<tr>' +
      '<td style="padding:8px;border-bottom:1px solid #E5E5E5;font-weight:bold;color:#4B1D6D;white-space:nowrap;">' + (player.number ? "#" + escaparHtml(player.number) + " " : "") + escaparHtml(player.player) + '</td>' +
      '<td style="padding:8px;border-bottom:1px solid #E5E5E5;text-align:left;">' + alertesHtml(player.alerts) + '</td>' +
      values +
      '<td style="padding:8px;border-bottom:1px solid #E5E5E5;text-align:center;font-weight:bold;">' + escaparHtml(player.averages && player.averages[averageField]) + '</td>' +
      '</tr>';
  }).join("");
  return '<h3 style="color:#4B1D6D;margin:20px 0 8px;font-size:16px;">' + escaparHtml(title) + '</h3>' +
    '<table style="width:100%;border-collapse:collapse;margin-bottom:12px;font-size:13px;">' +
    '<thead><tr style="background-color:#4B1D6D;color:#FFC72C;">' +
    head("Jugador/a") + head("Alertes") + headerDates + '<th style="padding:8px;text-align:center;">Mitjana</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table>';
}

function alertesResum(players) {
  return players && players.length ? players.join(", ") : "Sense alertes";
}

function alertesHtml(alerts) {
  if (!alerts || !alerts.length) {
    return '<span style="display:inline-block;padding:3px 7px;border-radius:999px;background:#F4F4F4;color:#666;font-size:11px;font-weight:bold;">Sense alertes</span>';
  }
  return alerts.map(function(alerta) {
    var colors = alerta === "Fatiga"
      ? { bg:"#FFE8D6", fg:"#8A3D00", border:"#FFC79A" }
      : alerta === "Son"
        ? { bg:"#FFF4C2", fg:"#6B5200", border:"#F0D66A" }
        : { bg:"#FDE2E2", fg:"#8A1F1F", border:"#F5B8B8" };
    return '<span style="display:inline-block;margin:2px 3px 2px 0;padding:3px 7px;border-radius:999px;background:' + colors.bg + ';color:' + colors.fg + ';border:1px solid ' + colors.border + ';font-size:11px;font-weight:bold;">' + escaparHtml(alerta) + '</span>';
  }).join("");
}

function kpi(label, value) {
  return '<td style="padding:10px;border:1px solid #E5E5E5;background:#F9F6FC;">' +
    '<div style="font-size:11px;color:#6B5B75;text-transform:uppercase;font-weight:bold;">' + escaparHtml(label) + '</div>' +
    '<div style="font-size:20px;color:#4B1D6D;font-weight:bold;margin-top:4px;">' + escaparHtml(value) + '</div>' +
    '</td>';
}

function head(value) {
  return '<th style="padding:8px;text-align:left;">' + escaparHtml(value) + '</th>';
}

function cell(value, strong) {
  return '<td style="padding:8px;border-bottom:1px solid #E5E5E5;' + (strong ? 'font-weight:bold;color:#4B1D6D;' : '') + '">' + escaparHtml(value) + '</td>';
}

function emailHead(value, separated) {
  return '<th style="padding:7px 9px;text-align:left;white-space:normal;line-height:1.15;word-break:normal;overflow-wrap:normal;' +
    (separated ? 'border-left:1px solid rgba(255,255,255,0.24);' : '') +
    '">' + escaparHtml(value) + '</th>';
}

function emailCell(value, width, strong, nowrap, separated) {
  return '<td style="width:' + width + ';padding:8px 9px;border-bottom:1px solid #E5E5E5;vertical-align:top;line-height:1.2;word-break:normal;overflow-wrap:break-word;' +
    (nowrap ? 'white-space:nowrap;' : '') +
    (separated ? 'border-left:1px solid #EFEFEF;' : '') +
    (strong ? 'font-weight:bold;color:#4B1D6D;' : '') +
    '">' + escaparHtml(value) + '</td>';
}

function emailShell(subtitle, content) {
  return '<div style="font-family:Helvetica Neue,Arial,sans-serif;color:#333;max-width:980px;margin:0 auto;border:1px solid #E5E5E5;border-radius:8px;overflow:hidden;">' +
    '<div style="background-color:#4B1D6D;padding:24px;text-align:center;border-bottom:4px solid #FFC72C;">' +
      '<h1 style="color:#FFC72C;margin:0;font-size:22px;text-transform:uppercase;letter-spacing:1px;">CB Sant Josep Badalona</h1>' +
      '<p style="color:#FFFFFF;margin:6px 0 0 0;font-size:14px;">' + escaparHtml(subtitle) + '</p>' +
    '</div>' +
    '<div style="padding:22px;background-color:#FFFFFF;">' + content + '</div>' +
    '<div style="background-color:#F4F4F4;padding:14px;text-align:center;border-top:1px solid #EEEEEE;">' +
      '<p style="font-size:12px;color:#666666;margin:0;"><strong>CB Sant Josep Badalona</strong> — Notificació automàtica del club.</p>' +
    '</div>' +
  '</div>';
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload, null, 2))
    .setMimeType(ContentService.MimeType.JSON);
}
