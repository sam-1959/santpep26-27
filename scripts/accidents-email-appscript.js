// Apps Script Web App per enviar avisos quan `accidents.html` rep un nou comunicat.
//
// Desplegament:
// 1. Enganxa aquest fitxer a https://script.google.com/.
// 2. Deploy > New deployment > Web app.
// 3. Execute as: Me.
// 4. Who has access: Anyone.
// 5. A Project Settings, activa "Show appsscript.json manifest file" i afegeix els scopes
//    del fitxer scripts/accidents-appsscript.json.
// 6. Autoritza GmailApp, DriveApp i UrlFetchApp.
// 7. Copia la URL /exec i posa-la a ACCIDENT_NOTIFY_URL dins accidents.html.

var FIREBASE_DB_URL = "https://coord-fa09e-default-rtdb.europe-west1.firebasedatabase.app";
var PRIVATE_REQUESTS_PATH = "accidentReportsPrivate/season-26-27";
var SEASON_CONTACTS_PATH = "seasonContacts/season-26-27";
var SEASON_CONTACTS_CACHE;
var ACCIDENT_PDFS_FOLDER_ID = "1Jjp1cx9prEseFwzUDEvfMFFt_B7TpSSJ";

function doPost(e) {
  try {
    var request = obtenirRequest(e);
    if (esCorreuProvaPdf(request)) {
      return respostaJson(enviarCorreuProvaPdf(request));
    }
    if (esEliminacioPdf(request)) {
      return respostaJson(eliminarPdfComunicat(request));
    }
    if (esPujadaPdf(request)) {
      return respostaJson(guardarPdfComunicat(request));
    }
    if (!esNovaPeticioValida(request)) {
      Logger.log("No s'envia correu intern: crida sense dades mínimes de nova petició.");
      return respostaJson({ ok: false, skipped: true, reason: "missing_required_request_fields" });
    }
    var resultat = enviarCorreuComunicatsAccident(adaptarComunicatANamedValues(request));
    return respostaJson({ ok: true, sentTo: resultat.sentTo, sentCount: resultat.sentTo.length });
  } catch (error) {
    Logger.log("Error enviant correu de comunicat d'accident: " + error);
    return respostaJson({ ok: false, error: String(error) });
  }
}

function esPujadaPdf(request) {
  if (!request) return false;
  var action = String(request.action || "").trim();
  return action === "uploadPdf" || !!request.dataBase64 || !!request.fileName;
}

function esEliminacioPdf(request) {
  if (!request) return false;
  return String(request.action || "").trim() === "deletePdf";
}

function esCorreuProvaPdf(request) {
  return !!request && String(request.action || "").trim() === "testPdfEmail";
}

function esNovaPeticioValida(request) {
  if (!request) return false;
  return !!(
    String(request.email || "").trim() &&
    String(request.guardianName || "").trim() &&
    String(request.player || "").trim() &&
    String(request.phone || "").trim() &&
    String(request.injuryDate || "").trim() &&
    String(request.venue || "").trim() &&
    String(request.damage || "").trim() &&
    String(request.side || "").trim()
  );
}

function obtenirRequest(e) {
  if (e && e.parameter && Object.keys(e.parameter).length) {
    return e.parameter;
  }
  return JSON.parse((e && e.postData && e.postData.contents) || "{}");
}

function guardarPdfComunicat(request) {
  Logger.log("Inici uploadPdf requestId=" + valor(request && request.requestId) + ", fileName=" + valor(request && request.fileName) + ", base64Length=" + String((request && request.dataBase64 || "").length));
  if (!request || !request.requestId) {
    throw new Error("Falta requestId.");
  }
  if (!request.dataBase64) {
    throw new Error("Falta el contingut del PDF.");
  }

  var fileName = nomFitxerSegur(request.fileName || ("comunicat-" + request.requestId + ".pdf"));
  var mimeType = request.mimeType || "application/pdf";
  if (mimeType !== "application/pdf") {
    throw new Error("El fitxer ha de ser un PDF.");
  }

  var folder = DriveApp.getFolderById(ACCIDENT_PDFS_FOLDER_ID);
  var bytes = Utilities.base64Decode(request.dataBase64);
  var blob = Utilities.newBlob(bytes, mimeType, fileName);
  var file = folder.createFile(blob);
  Logger.log("PDF creat a Drive: " + file.getId());
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (sharingError) {
    Logger.log("No s'ha pogut canviar el sharing del PDF. Es mantindran els permisos de la carpeta: " + sharingError);
  }

  var payload = {
    pdfName: fileName,
    pdfUrl: file.getUrl(),
    pdfDriveId: file.getId(),
    pdfUploadedAt: new Date().toISOString(),
    pdfUploadedBy: valor(request.uploadedBy),
    familyEmailSentAt: null,
    familyEmailSentTo: null
  };

  actualitzarFirebase(PRIVATE_REQUESTS_PATH + "/" + request.requestId, payload);
  eliminarFitxerDriveSiExisteix(request.previousPdfDriveId || extreureDriveFileId(request.previousPdfUrl));
  if (String(request.sendFamilyEmail || "true") === "true") {
    var destinatarisFamilia = enviarCorreuDocumentFamilia(request, payload);
    if (destinatarisFamilia.length) {
      actualitzarFirebase(PRIVATE_REQUESTS_PATH + "/" + request.requestId, {
        familyEmailSentAt: new Date().toISOString(),
        familyEmailSentTo: destinatarisFamilia.join(", ")
      });
    }
  } else {
    Logger.log("No s'envia correu a família per decisió de l'usuari.");
  }
  Logger.log("Firebase actualitzat amb pdfUrl=" + payload.pdfUrl);
  return { ok: true, pdfUrl: payload.pdfUrl, pdfName: payload.pdfName };
}

function enviarCorreuDocumentFamilia(request, pdf) {
  var destinataris = normalitzarCorreus([request.recipientEmail || request.email]);
  if (!destinataris.length) {
    Logger.log("No s'envia correu a família: falta adreça electrònica vàlida.");
    return [];
  }
  if (!pdf || !pdf.pdfDriveId) {
    throw new Error("No s'ha pogut adjuntar el PDF: falta l'identificador de Drive.");
  }
  var fitxerPdf = DriveApp.getFileById(pdf.pdfDriveId);
  var pdfAdjunt = fitxerPdf.getBlob().setName(pdf.pdfName || fitxerPdf.getName());

  var jugador = valor(request.player);
  var expedient = valor(request.claimNumber);
  var teExpedient = expedient !== "—";
  var expedientText = teExpedient
    ? "Número d'expedient: " + expedient + "\n\n"
    : "Quan pugueu, envieu-nos el número d'expedient responent aquest correu.\n\n";
  var expedientHTML = teExpedient
    ? `<p style="margin: 16px 0; padding: 12px; background-color: #F9F6FC; border-left: 4px solid #4B1D6D; border-radius: 6px;"><strong>Número d'expedient:</strong> ${escaparHtml(expedient)}</p>`
    : `<p style="margin: 16px 0; padding: 12px; background-color: #FFF8D6; border-left: 4px solid #FFC72C; border-radius: 6px;">Quan pugueu, envieu-nos el número d'expedient responent aquest correu.</p>`;
  var assumpte = "Comunicat d'Accident Esportiu - CB Sant Josep";
  var cosText = "CB SANT JOSEP BADALONA\n\n" +
    "Hola,\n\n" +
    "Us enviem el Comunicat d'Accident Esportiu" + (jugador !== "—" ? " de " + jugador : "") + ".\n\n" +
    expedientText +
    "Trobareu el comunicat adjunt a aquest correu.\n\n" +
    "CB Sant Josep de Badalona";

  var cosHTML = `
    <div style="font-family: 'Helvetica Neue', Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #E5E5E5; border-radius: 8px; overflow: hidden;">
      <div style="background-color: #4B1D6D; padding: 25px; text-align: center; border-bottom: 4px solid #FFC72C;">
        <h1 style="color: #FFC72C; margin: 0; font-size: 22px; text-transform: uppercase; letter-spacing: 1px;">CB Sant Josep Badalona</h1>
        <p style="color: #FFFFFF; margin: 5px 0 0 0; font-size: 13px; opacity: 0.9;">Comunicat d'Accident Esportiu</p>
      </div>
      <div style="padding: 25px; background-color: #FFFFFF;">
        <p style="margin-top: 0;">Hola,</p>
        <p>Us enviem el Comunicat d'Accident Esportiu${jugador !== "—" ? " de <strong>" + escaparHtml(jugador) + "</strong>" : ""}.</p>
        ${expedientHTML}
        <p style="margin: 20px 0; padding: 12px; background-color: #F9F6FC; border-left: 4px solid #4B1D6D; border-radius: 6px;">Trobareu el comunicat adjunt a aquest correu.</p>
        <p style="font-size: 13px; color: #666;">Si teniu cap dubte, podeu contactar amb info@cbsantjosep.cat.</p>
      </div>
      <div style="background-color: #F4F4F4; padding: 15px; text-align: center; border-top: 1px solid #EEEEEE;">
        <p style="font-size: 12px; color: #666666; margin: 0;"><strong>CB Sant Josep Badalona</strong></p>
      </div>
    </div>
  `;

  var copiaAccidents = destinatarisComunicatsAccident("pdf").filter(function(correu) {
    return correu.toLowerCase() !== String(request.recipientEmail || request.email || "").trim().toLowerCase();
  });
  destinataris.forEach(function(correu) {
    GmailApp.sendEmail(correu, assumpte, cosText, {
      cc: copiaAccidents.join(","),
      attachments: [pdfAdjunt],
      htmlBody: cosHTML,
      name: "CB Sant Josep Badalona"
    });
    Logger.log("Correu amb comunicat enviat a: " + correu);
  });
  return destinataris;
}

// Envia una prova únicament a Direcció Tècnica: no admet cap destinatari extern.
function enviarCorreuProvaPdf(request) {
  var fileId = String(request.pdfDriveId || extreureDriveFileId(request.pdfUrl) || "").trim();
  if (!fileId) throw new Error("No s'ha pogut enviar la prova: falta el PDF del comunicat.");

  var fitxerPdf = DriveApp.getFileById(fileId);
  var pdfAdjunt = fitxerPdf.getBlob().setName(request.pdfName || fitxerPdf.getName());
  var jugador = valor(request.player);
  var expedient = valor(request.claimNumber);
  var teExpedient = expedient !== "—";
  var expedientText = teExpedient
    ? "Número d'expedient: " + expedient + "\n\n"
    : "Quan pugueu, envieu-nos el número d'expedient responent aquest correu.\n\n";
  var expedientHTML = teExpedient
    ? '<p style="margin:16px 0;padding:12px;background:#F9F6FC;border-left:4px solid #4B1D6D;border-radius:6px;"><strong>Número d\'expedient:</strong> ' + escaparHtml(expedient) + '</p>'
    : '<p style="margin:16px 0;padding:12px;background:#FFF8D6;border-left:4px solid #FFC72C;border-radius:6px;">Quan pugueu, envieu-nos el número d\'expedient responent aquest correu.</p>';
  var assumpte = "PROVA · Comunicat d'Accident Esportiu - CB Sant Josep";
  var cosText = "AQUEST ÉS UN CORREU DE PROVA.\n" +
    "S'ha enviat exclusivament a Direcció Tècnica; no s'ha enviat a la família ni a cap altre destinatari.\n\n" +
    "Hola,\n\n" +
    "Us enviem el Comunicat d'Accident Esportiu" + (jugador !== "—" ? " de " + jugador : "") + ".\n\n" +
    expedientText +
    "Trobareu el comunicat adjunt a aquest correu.\n\n" +
    "CB Sant Josep de Badalona";
  var cosHTML = '<div style="font-family:Arial,sans-serif;color:#333;max-width:600px;margin:0 auto;border:1px solid #E5E5E5;border-radius:8px;overflow:hidden;">' +
    '<div style="background:#4B1D6D;padding:22px;text-align:center;border-bottom:4px solid #FFC72C;"><h1 style="color:#FFC72C;margin:0;font-size:20px;">CB SANT JOSEP BADALONA</h1><p style="color:#fff;margin:5px 0 0;font-size:13px;">Prova de comunicat d\'accident</p></div>' +
    '<div style="padding:24px;background:#fff;"><p style="margin-top:0;padding:10px;background:#FFF8D6;border-left:4px solid #FFC72C;border-radius:6px;"><strong>CORREU DE PROVA:</strong> enviat exclusivament a Direcció Tècnica.</p>' +
    '<p>Hola,</p><p>Us enviem el Comunicat d\'Accident Esportiu' + (jugador !== "—" ? ' de <strong>' + escaparHtml(jugador) + '</strong>' : '') + '.</p>' +
    expedientHTML +
    '<p style="margin:20px 0;padding:12px;background:#F9F6FC;border-left:4px solid #4B1D6D;border-radius:6px;">Trobareu el comunicat adjunt a aquest correu.</p></div></div>';

  var testRecipient = correuCoordinacioGeneral();
  if (!testRecipient) throw new Error("No hi ha cap contacte de Coordinació general configurat per enviar la prova.");
  GmailApp.sendEmail(testRecipient, assumpte, cosText, {
    attachments: [pdfAdjunt],
    htmlBody: cosHTML,
    name: "CB Sant Josep Badalona"
  });
  Logger.log("Prova de comunicat enviada exclusivament a: " + testRecipient);
  return { ok: true, sentTo: [testRecipient] };
}

function eliminarPdfComunicat(request) {
  Logger.log("Inici deletePdf requestId=" + valor(request && request.requestId) + ", pdfDriveId=" + valor(request && request.pdfDriveId));
  if (!request || !request.requestId) {
    throw new Error("Falta requestId.");
  }
  eliminarFitxerDriveSiExisteix(request.pdfDriveId || extreureDriveFileId(request.pdfUrl));
  actualitzarFirebase(PRIVATE_REQUESTS_PATH + "/" + request.requestId, {
    pdfName: null,
    pdfUrl: null,
    pdfDriveId: null,
    pdfUploadedAt: null,
    pdfUploadedBy: null,
    familyEmailSentAt: null,
    familyEmailSentTo: null,
    pdfDeletedAt: new Date().toISOString(),
    pdfDeletedBy: valor(request.deletedBy)
  });
  Logger.log("PDF eliminat i Firebase actualitzat.");
  return { ok: true, deleted: true };
}

function eliminarFitxerDriveSiExisteix(fileId) {
  if (!fileId) return;
  try {
    DriveApp.getFileById(fileId).setTrashed(true);
    Logger.log("PDF enviat a la paperera de Drive: " + fileId);
  } catch (error) {
    Logger.log("No s'ha pogut eliminar el PDF de Drive " + fileId + ": " + error);
  }
}

function extreureDriveFileId(url) {
  var text = String(url || "");
  var match = text.match(/\/d\/([^/]+)/) || text.match(/[?&]id=([^&]+)/);
  return match ? match[1] : "";
}

function nomFitxerSegur(name) {
  var safe = String(name || "comunicat.pdf")
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  if (!/\.pdf$/i.test(safe)) safe += ".pdf";
  return safe;
}

function actualitzarFirebase(path, payload) {
  var base = FIREBASE_DB_URL.replace(/\/$/, "");
  var safePath = path.split("/").map(encodeURIComponent).join("/");
  var response = UrlFetchApp.fetch(base + "/" + safePath + ".json", {
    method: "patch",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error("Firebase update failed: " + code + " " + response.getContentText());
  }
}

function adaptarComunicatANamedValues(request) {
  return {
    namedValues: {
      "Marca de temps": [formatarDataHora(request.createdAt)],
      "Adreça electrònica": [valor(request.email)],
      "Nom i cognoms pare/mare": [valor(request.guardianName)],
      "Nom i cognoms jugador/a": [valor(request.player)],
      "Telèfon de contacte": [valor(request.phone)],
      "Dia de la lesió": [formatarData(request.injuryDate)],
      "Instal·lació on s'ha fet la lesió": [valor(request.venue)],
      "Danys soferts": [valor(request.damage)],
      "Lloc de la lesió": [valor(request.side)],
      "Número d'expedient LLOYD'S": [valor(request.claimNumber)]
    }
  };
}

function enviarCorreuComunicatsAccident(e) {
  if (!e || !e.namedValues) {
    Logger.log("Aquesta funció s'ha d'executar mitjançant doPost.");
    return;
  }

  var destinataris = destinatarisComunicatsAccident("avis");

  if (!destinataris.length) {
    throw new Error("No hi ha destinataris configurats.");
  }

  var filesResumHTML = "";
  var textResumPla = "";

  for (var pregunta in e.namedValues) {
    var resposta = e.namedValues[pregunta].join(", ");
    filesResumHTML += `
      <tr>
        <td style="padding: 10px; border-bottom: 1px solid #E5E5E5; font-weight: bold; background-color: #F9F6FC; color: #4B1D6D;">${escaparHtml(pregunta)}</td>
        <td style="padding: 10px; border-bottom: 1px solid #E5E5E5; color: #333333;">${escaparHtml(resposta)}</td>
      </tr>
    `;
    textResumPla += `${pregunta}: ${resposta}\n`;
  }

  var assumpte = "Nou comunicat d'accident esportiu rebut";
  var cosText = "CB SANT JOSEP BADALONA\n\nS'ha rebut un nou comunicat d'accident esportiu:\n\n" + textResumPla;

  var cosHTML = `
    <div style="font-family: 'Helvetica Neue', Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #E5E5E5; border-radius: 8px; overflow: hidden;">
      <div style="background-color: #4B1D6D; padding: 25px; text-align: center; border-bottom: 4px solid #FFC72C;">
        <h1 style="color: #FFC72C; margin: 0; font-size: 22px; text-transform: uppercase; letter-spacing: 1px;">CB Sant Josep Badalona</h1>
        <p style="color: #FFFFFF; margin: 5px 0 0 0; font-size: 13px; opacity: 0.9;">Comunicat d'accident esportiu</p>
      </div>

      <div style="padding: 25px; background-color: #FFFFFF;">
        <h3 style="color: #4B1D6D; margin-top: 0; font-size: 18px;">Resum del comunicat rebut:</h3>
        <table style="width: 100%; border-collapse: collapse; margin-top: 15px;">
          <thead>
            <tr style="background-color: #4B1D6D; color: #FFC72C;">
              <th style="padding: 10px; text-align: left; font-size: 14px;">Camp</th>
              <th style="padding: 10px; text-align: left; font-size: 14px;">Detall</th>
            </tr>
          </thead>
          <tbody>${filesResumHTML}</tbody>
        </table>
      </div>

      <div style="background-color: #F4F4F4; padding: 15px; text-align: center; border-top: 1px solid #EEEEEE;">
        <p style="font-size: 12px; color: #666666; margin: 0;"><strong>CB Sant Josep Badalona</strong> — Notificació automàtica del club.</p>
      </div>
    </div>
  `;

  destinataris.forEach(function(correu) {
    GmailApp.sendEmail(correu, assumpte, cosText, {
      htmlBody: cosHTML,
      name: "CB Sant Josep Badalona"
    });
    Logger.log("Correu enviat a: " + correu);
  });

  Logger.log("Correus enviats a: " + destinataris.join(", "));
  return { sentTo: destinataris };
}

function normalitzarCorreus(llistaCorreus) {
  return llistaCorreus
    .join(",")
    .split(/[,\n;]/)
    .map(function(correu) {
      return String(correu || "").trim();
    })
    .filter(function(correu) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correu);
    });
}

// Els destinataris permanents es gestionen a Contactes. L'avís del formulari
// és per a Pere i Coordinació general; el PDF adjunt inclou Digglo.
function destinatarisComunicatsAccident(tipus) {
  var contacts = obtenirContactesTemporada();
  var avisos = Array.isArray(contacts.notificationRecipients) ? contacts.notificationRecipients : [];
  var externs = avisos.filter(function(contact) {
    if (!Array.isArray(contact.notifications) || contact.notifications.indexOf("accidents") === -1) return false;
    var esDigglo = String(contact.email || "").trim().toLowerCase() === "basquetcatala@digglo.eu";
    return tipus === "pdf" ? true : !esDigglo;
  }).map(function(contact) { return contact.email; });
  var coordinacioGeneral = tipus === "pdf" || tipus === "avis"
    ? (Array.isArray(contacts.coordinators) ? contacts.coordinators : []).filter(function(contact) {
        return contact && contact.role === "general";
      }).map(function(contact) { return contact.email; })
    : [];
  return normalitzarCorreus(externs.concat(coordinacioGeneral));
}

function obtenirContactesTemporada() {
  if (SEASON_CONTACTS_CACHE !== undefined) return SEASON_CONTACTS_CACHE;
  var base = FIREBASE_DB_URL.replace(/\/$/, "");
  var url = base + "/" + SEASON_CONTACTS_PATH.split("/").map(encodeURIComponent).join("/") + ".json";
  var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (response.getResponseCode() !== 200) {
    throw new Error("No s'han pogut llegir els destinataris de comunicats: Firebase " + response.getResponseCode());
  }
  SEASON_CONTACTS_CACHE = JSON.parse(response.getContentText() || "null") || {};
  return SEASON_CONTACTS_CACHE;
}

function correuCoordinacioGeneral() {
  var coordinators = Array.isArray(obtenirContactesTemporada().coordinators) ? obtenirContactesTemporada().coordinators : [];
  var contact = coordinators.filter(function(item) {
    return item && item.role === "general" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(item.email || "").trim());
  })[0];
  return contact ? String(contact.email).trim() : "";
}

function formatarDataHora(value) {
  if (!value) return "—";
  var date = new Date(value);
  if (isNaN(date.getTime())) return String(value);
  return Utilities.formatDate(date, "Europe/Madrid", "dd/MM/yyyy HH:mm");
}

function formatarData(value) {
  if (!value) return "—";
  var parts = String(value).split("-");
  if (parts.length === 3) return parts[2] + "/" + parts[1] + "/" + parts[0];
  return String(value);
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

function respostaJson(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
