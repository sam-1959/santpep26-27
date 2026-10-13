// Apps Script independent per sincronitzar les quotes de fisioteràpia.
// No s'ha de vincular al full: crea un projecte a https://script.google.com/
// i enganxa-hi aquest fitxer.

var QUOTA_SPREADSHEET_ID = "15Ep8VIQWEHi_ST9vbnDz6Y_97FBCT_uU";
var QUOTA_SHEET_ID = 1209425339;
var FIREBASE_DB_URL = "https://coord-fa09e-default-rtdb.europe-west1.firebasedatabase.app";
var QUOTA_FIREBASE_PATH = "physioQuota/season-26-27";
var FIREBASE_SCOPE = "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email";
var FIREBASE_ACCESS_TOKEN = "";

function actualitzarQuotaFisio() {
  var sheet = SpreadsheetApp.openById(QUOTA_SPREADSHEET_ID).getSheetById(QUOTA_SHEET_ID);
  if (!sheet) throw new Error("No s'ha trobat la pestanya de quota de fisioteràpia.");

  var values = sheet.getDataRange().getDisplayValues();
  var paidNames = extreureNomsAmbQuota(values);
  var previous = llegirFirebase(QUOTA_FIREBASE_PATH) || {};
  var previousNames = Array.isArray(previous.paidNames) ? previous.paidNames.slice().sort() : [];

  var changed = JSON.stringify(previousNames) !== JSON.stringify(paidNames);
  var payload = {
    paidNames: paidNames,
    updatedAt: new Date().toISOString(),
    source: "google-sheet-appscript",
    count: paidNames.length
  };
  escriureFirebase(QUOTA_FIREBASE_PATH, payload);
  Logger.log("Quota de fisioteràpia " + (changed ? "actualitzada" : "comprovada") + " a Firebase: " + paidNames.length + " claus.");
  return { ok: true, changed: changed, count: paidNames.length, updatedAt: payload.updatedAt };
}

function extreureNomsAmbQuota(values) {
  if (!values || !values.length) return [];
  var headers = values[0].map(normalitzarNom);
  var nameIndex = headers.indexOf("nom complet");
  var quotaIndex = headers.indexOf("quota");
  if (nameIndex < 0 || quotaIndex < 0) {
    throw new Error("Falten les columnes 'Nom complet' o 'Quota' al full de quotes.");
  }

  var paidNames = [];
  values.slice(1).forEach(function(row) {
    var fullName = String(row[nameIndex] || "").trim();
    var normalized = normalitzarNom(fullName);
    var quota = Number(String(row[quotaIndex] || "").replace(",", "."));
    if (!normalized || /\b(total|femeni|masculi)\b/.test(normalized) || !(quota > 0)) return;
    paidNames.push(normalized);
    paidNames.push(normalitzarNom(nomCurt(fullName)));
  });
  return Array.from(new Set(paidNames.filter(Boolean))).sort();
}

function normalitzarNom(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function nomCurt(value) {
  var parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).join(" ");
}

function firebaseUrl(pathName) {
  return FIREBASE_DB_URL.replace(/\/$/, "") + "/" + pathName.split("/").map(encodeURIComponent).join("/") + ".json";
}

function firebaseHeaders() {
  return { Authorization: "Bearer " + firebaseAccessToken() };
}

// Desa FIREBASE_SERVICE_ACCOUNT_EMAIL i FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY
// a Project settings > Script properties. No incloguis mai la clau al codi.
function firebaseAccessToken() {
  if (FIREBASE_ACCESS_TOKEN) return FIREBASE_ACCESS_TOKEN;
  var properties = PropertiesService.getScriptProperties();
  var email = properties.getProperty("FIREBASE_SERVICE_ACCOUNT_EMAIL");
  var privateKey = properties.getProperty("FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY");
  if (!email || !privateKey) {
    throw new Error("Falten FIREBASE_SERVICE_ACCOUNT_EMAIL o FIREBASE_SERVICE_ACCOUNT_PRIVATE_KEY a les propietats de l'script.");
  }
  var now = Math.floor(Date.now() / 1000);
  var header = base64Url({ alg: "RS256", typ: "JWT" });
  var claim = base64Url({ iss: email, scope: FIREBASE_SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 });
  var unsignedJwt = header + "." + claim;
  var signature = Utilities.computeRsaSha256Signature(unsignedJwt, privateKey.replace(/\\n/g, "\n"));
  var assertion = unsignedJwt + "." + Utilities.base64EncodeWebSafe(signature).replace(/=+$/, "");
  var response = UrlFetchApp.fetch("https://oauth2.googleapis.com/token", {
    method: "post",
    contentType: "application/x-www-form-urlencoded",
    payload: { grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: assertion },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    throw new Error("No s'ha pogut autenticar el compte de servei: " + response.getContentText());
  }
  FIREBASE_ACCESS_TOKEN = JSON.parse(response.getContentText()).access_token;
  return FIREBASE_ACCESS_TOKEN;
}

function base64Url(value) {
  return Utilities.base64EncodeWebSafe(JSON.stringify(value)).replace(/=+$/, "");
}

function llegirFirebase(pathName) {
  var response = UrlFetchApp.fetch(firebaseUrl(pathName), { method: "get", headers: firebaseHeaders(), muteHttpExceptions: true });
  if (response.getResponseCode() === 404) return null;
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error("Firebase GET " + response.getResponseCode() + ": " + response.getContentText());
  }
  var text = response.getContentText();
  return text && text !== "null" ? JSON.parse(text) : null;
}

function escriureFirebase(pathName, value) {
  var response = UrlFetchApp.fetch(firebaseUrl(pathName), {
    method: "put",
    contentType: "application/json; charset=utf-8",
    payload: JSON.stringify(value),
    headers: firebaseHeaders(),
    muteHttpExceptions: true
  });
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error("Firebase PUT " + response.getResponseCode() + ": " + response.getContentText());
  }
}

// Executa una vegada aquesta funció per crear un activador diari.
// Configura abans la zona horària del projecte com Europe/Madrid.
function crearActivadorDiariQuotaFisio() {
  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === "actualitzarQuotaFisio") ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger("actualitzarQuotaFisio").timeBased().everyDays(1).atHour(7).create();
}
