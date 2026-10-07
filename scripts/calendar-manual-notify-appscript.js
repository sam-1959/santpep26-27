// Apps Script Web App — avís immediat dels canvis manuals de Calendaris de partits.
//
// Desplegament:
// 1. Crea un projecte nou a https://script.google.com/ i enganxa-hi aquest fitxer.
// 2. Deploy > New deployment > Web app.
// 3. Execute as: Me.
// 4. Who has access: Anyone.
// 5. Autoritza MailApp i UrlFetchApp.
// 6. Copia la URL acabada en /exec a CALENDAR_MANUAL_NOTIFY_URL de partits.html.
//
// El servei valida el token de Firebase de l'usuari que desa el canvi i només
// accepta correus inclosos a la taula de contactes de la temporada.

var FIREBASE_DB_URL = "https://coord-fa09e-default-rtdb.europe-west1.firebasedatabase.app";
var FIREBASE_API_KEY = "AIzaSyDge8IFez-I-HhyFDx0ch0Jr1-NYLHDWRU";
var SEASON_CONTACTS_PATH = "seasonContacts/season-26-27";

function doGet() {
  return respostaJson({ ok: true, service: "calendar-manual-notify" });
}

function doPost(e) {
  try {
    var request = JSON.parse((e.postData && e.postData.contents) || "{}");
    if (request.action !== "manualCalendarEdit") {
      throw new Error("Acció no permesa.");
    }
    var user = validarUsuariFirebase(request.idToken);
    if (!usuariAutoritzat(user.email)) {
      throw new Error("Aquest usuari no té permís per enviar avisos de calendari.");
    }
    var destinatari = correuCoordinacioGeneral();
    if (!destinatari) throw new Error("No hi ha correu de Coordinació general configurat.");

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
    MailApp.sendEmail(destinatari, subject, construirTextCanvisCalendar(teamLabel, [change]), {
      htmlBody: calendarChangeEmailHtml(teamLabel, [change]),
      name: "CB Sant Josep Badalona"
    });
    return respostaJson({ ok: true, sentTo: destinatari });
  } catch (error) {
    Logger.log("Error enviant l'avís manual de calendari: " + error);
    return respostaJson({ ok: false, error: String(error) });
  }
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

function usuariAutoritzat(email) {
  var contacts = llegirContactes();
  var authorized = []
    .concat(contacts.coordinators || [])
    .concat(contacts.headCoaches || [])
    .concat(contacts.physicalTrainers || []);
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
