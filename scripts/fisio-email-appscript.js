// Apps Script Web App per enviar avisos quan `fisio.html` rep una nova petició.
//
// Desplegament:
// 1. Enganxa aquest fitxer a https://script.google.com/.
// 2. Deploy > New deployment > Web app.
// 3. Execute as: Me.
// 4. Who has access: Anyone.
// 5. Autoritza GmailApp.
// 6. Copia la URL /exec i posa-la a APP_SCRIPT_NOTIFY_URL dins fisio.html.

function doPost(e) {
  try {
    var request = JSON.parse((e.postData && e.postData.contents) || "{}");
    var resultat = enviarCorreuAAdrecesFixes(adaptarPeticioANamedValues(request));
    return respostaJson({ ok: true, sentTo: resultat.sentTo, sentCount: resultat.sentTo.length });
  } catch (error) {
    Logger.log("Error enviant correu de fisio: " + error);
    return respostaJson({ ok: false, error: String(error) });
  }
}

function adaptarPeticioANamedValues(request) {
  return {
    namedValues: {
      "Marca de temps": [formatarDataHora(request.createdAt)],
      "Adreça electrònica": [valor(request.email)],
      "Nom i cognoms pare/mare": [valor(request.guardianName)],
      "Nom i cognoms jugador/a": [valor(request.player)],
      "Telèfon de contacte": [valor(request.phone)],
      "Data de la lesió": [formatarData(request.injuryDate)],
      "Equip": [valor(request.team) + (request.gender ? " " + request.gender : "")],
      "Petita descripció del per què es demana atendre al servei de fisioteràpia": [valor(request.description)]
    }
  };
}

function enviarCorreuAAdrecesFixes(e) {
  if (!e || !e.namedValues) {
    Logger.log("Aquesta funció s'ha d'executar mitjançant un Trigger d'enviament de formulari o doPost.");
    return;
  }

  // Destinataris de prova. Amplia aquesta llista quan validem el funcionament.
  var llistaCorreus = [
    "ricard.fuste@gmail.com"
  ];
  var destinataris = normalitzarCorreus(llistaCorreus);

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

  var urlFisio = "https://sam-1959.github.io/santpep26-27/fisio-peticions.html";
  var assumpte = "Nova petició de servei de fisioteràpia rebuda!";

  var cosText = "CB SANT JOSEP BADALONA\n\nS'ha rebut una nova petició de servei de fisioteràpia al formulari:\n\n" + textResumPla + "\n" + urlFisio;

  var cosHTML = `
    <div style="font-family: 'Helvetica Neue', Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #E5E5E5; border-radius: 8px; overflow: hidden;">
      <div style="background-color: #4B1D6D; padding: 25px; text-align: center; border-bottom: 4px solid #FFC72C;">
        <h1 style="color: #FFC72C; margin: 0; font-size: 22px; text-transform: uppercase; letter-spacing: 1px;">CB Sant Josep Badalona</h1>
        <p style="color: #FFFFFF; margin: 5px 0 0 0; font-size: 13px; opacity: 0.9;">Petició de servei de fisioteràpia</p>
      </div>

      <div style="padding: 25px; background-color: #FFFFFF;">
        <h3 style="color: #4B1D6D; margin-top: 0; font-size: 18px;">Resum de la petició enviada:</h3>

        <table style="width: 100%; border-collapse: collapse; margin-top: 15px; margin-bottom: 20px;">
          <thead>
            <tr style="background-color: #4B1D6D; color: #FFC72C;">
              <th style="padding: 10px; text-align: left; font-size: 14px;">Camp / Pregunta</th>
              <th style="padding: 10px; text-align: left; font-size: 14px;">Detall</th>
            </tr>
          </thead>
          <tbody>
            ${filesResumHTML}
          </tbody>
        </table>

        <div style="text-align: center; margin: 30px 0 10px 0; padding: 20px; background-color: #F9F6FC; border-radius: 6px; border: 1px dashed #4B1D6D;">
          <p style="margin: 0 0 15px 0; font-weight: bold; color: #4B1D6D; font-size: 15px;">Servei de Fisioteràpia:</p>
          <a href="${urlFisio}"
             target="_blank"
             style="background-color: #4B1D6D; color: #FFC72C; padding: 12px 24px; text-decoration: none; font-weight: bold; border-radius: 5px; display: inline-block; font-size: 14px; border: 2px solid #FFC72C;">
            Accedir a l'historial de peticions
          </a>
        </div>
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

  Logger.log("Correus enviats amb disseny Sant Pep a: " + destinataris.join(", "));
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
