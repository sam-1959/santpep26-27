// Apps Script Web App per enviar el resum setmanal de Visites Fisio.
//
// Desplegament:
// 1. Enganxa aquest fitxer a https://script.google.com/ o afegeix aquesta
//    branca `type === "physio_visits_weekly"` al projecte existent.
// 2. Deploy > New deployment > Web app.
// 3. Execute as: Me.
// 4. Who has access: Anyone.
// 5. Autoritza GmailApp.
// 6. Copia la URL /exec a PHYSIO_VISITS_EMAIL_APP_SCRIPT_URL.

function doPost(e) {
  try {
    var request = JSON.parse((e.postData && e.postData.contents) || "{}");
    if (request.type !== "physio_visits_weekly") {
      throw new Error("Tipus de petició no suportat: " + request.type);
    }
    var resultat = enviarCorreuVisitesFisioSetmanal(request);
    return respostaJson({ ok: true, sentTo: resultat.sentTo, sentCount: resultat.sentTo.length });
  } catch (error) {
    Logger.log("Error enviant resum setmanal de visites fisio: " + error);
    return respostaJson({ ok: false, error: String(error) });
  }
}

function enviarCorreuVisitesFisioSetmanal(request) {
  var destinataris = normalitzarCorreus([request.recipient || ""]);
  if (!destinataris.length) {
    throw new Error("No hi ha destinataris configurats.");
  }

  var weekLabel = valor(request.weekLabel);
  var summary = request.summary || {};
  var players = request.players || [];
  var visits = request.visits || [];

  var assumpte = "Resum setmanal de visites de fisioteràpia - " + weekLabel;
  var cosText = construirTextPla(weekLabel, summary, players);
  var cosHTML = construirHtml(weekLabel, summary, players, visits);

  destinataris.forEach(function(correu) {
    GmailApp.sendEmail(correu, assumpte, cosText, {
      htmlBody: cosHTML,
      name: "CB Sant Josep Badalona"
    });
    Logger.log("Resum setmanal de visites fisio enviat a: " + correu);
  });

  return { sentTo: destinataris };
}

function construirTextPla(weekLabel, summary, players) {
  var lines = [
    "CB SANT JOSEP BADALONA",
    "",
    "Resum setmanal de visites de fisioteràpia",
    "Setmana: " + weekLabel,
    "",
    "Resum:",
    "- Visites: " + valor(summary.records),
    "- Jugador/es amb visita: " + valor(summary.players),
    "- Període: " + valor(summary.from) + " - " + valor(summary.to),
    "",
    "Detall per jugador/a:"
  ];

  players.forEach(function(player) {
    lines.push(
      valor(player.player),
      "  Visites: " + valor(player.visits),
      "  Última visita: " + valor(player.latestDate),
      "  Equip: " + valor(player.team),
      "  Visita: " + valor(player.assignedPhysio) + " · " + valor(player.visitType),
      "  Pista: " + valor(player.courtStatus),
      "  Estructura / localització: " + valor(player.structure) + " / " + valor(player.location),
      "  Pautes: " + valor(player.guidelines),
      "  Llegit prepa: " + valor(player.prepaRead) + (player.prepaReadAt && player.prepaReadAt !== "—" ? " · " + player.prepaReadAt : ""),
      "  Feedback: " + valor(player.prepaFeedback),
      ""
    );
  });

  return lines.join("\n");
}

function construirHtml(weekLabel, summary, players, visits) {
  return `
    <div style="font-family: 'Helvetica Neue', Arial, sans-serif; color: #333; max-width: 980px; margin: 0 auto; border: 1px solid #E5E5E5; border-radius: 8px; overflow: hidden;">
      <div style="background-color: #4B1D6D; padding: 24px; text-align: center; border-bottom: 4px solid #FFC72C;">
        <h1 style="color: #FFC72C; margin: 0; font-size: 22px; text-transform: uppercase; letter-spacing: 1px;">CB Sant Josep Badalona</h1>
        <p style="color: #FFFFFF; margin: 6px 0 0 0; font-size: 14px;">Resum setmanal de visites de fisioteràpia</p>
      </div>

      <div style="padding: 22px; background-color: #FFFFFF;">
        <h2 style="color: #4B1D6D; margin: 0 0 4px; font-size: 20px;">Setmana ${escaparHtml(weekLabel)}</h2>
        <p style="margin: 0 0 18px; color: #666; font-weight: bold;">${escaparHtml(valor(summary.from))} - ${escaparHtml(valor(summary.to))}</p>

        <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
          <tr>
            ${kpi("Visites", summary.records)}
            ${kpi("Jugador/es", summary.players)}
            ${kpi("Fisioteràpia", countBy(summary.byType, "Fisioteràpia"))}
            ${kpi("Readaptació", countBy(summary.byType, "Readaptació"))}
          </tr>
        </table>

        ${resumPista(summary.byCourt)}
        ${taulaVisites(visits)}
      </div>

      <div style="background-color: #F4F4F4; padding: 14px; text-align: center; border-top: 1px solid #EEEEEE;">
        <p style="font-size: 12px; color: #666666; margin: 0;"><strong>CB Sant Josep Badalona</strong> — Notificació automàtica del club.</p>
      </div>
    </div>
  `;
}

function resumPista(byCourt) {
  byCourt = byCourt || {};
  var items = ["Pendent", "No pista", "Pista condicionada", "Pista normal"].map(function(label) {
    return '<span style="display:inline-block; margin:3px 6px 3px 0; padding:5px 9px; border-radius:999px; background:#F9F6FC; color:#4B1D6D; font-size:12px; font-weight:bold;">' +
      escaparHtml(label) + ': ' + escaparHtml(countBy(byCourt, label)) + '</span>';
  }).join("");
  return '<div style="margin: 0 0 18px;">' + items + '</div>';
}

function taulaVisites(visits) {
  var rows = (visits || []).map(function(visit) {
    return `
      <tr>
        <td style="padding: 8px; border-bottom: 1px solid #E5E5E5;">${escaparHtml(valor(visit.date))}</td>
        <td style="padding: 8px; border-bottom: 1px solid #E5E5E5; font-weight: bold; color: #4B1D6D;">${escaparHtml(valor(visit.player))}</td>
        <td style="padding: 8px; border-bottom: 1px solid #E5E5E5;">${escaparHtml(valor(visit.teamCategory))}</td>
        <td style="padding: 8px; border-bottom: 1px solid #E5E5E5;">${escaparHtml(valor(visit.assignedPhysio))}</td>
        <td style="padding: 8px; border-bottom: 1px solid #E5E5E5;">${escaparHtml(valor(visit.visitType))}</td>
        <td style="padding: 8px; border-bottom: 1px solid #E5E5E5;">${escaparHtml(valor(visit.structure))}</td>
        <td style="padding: 8px; border-bottom: 1px solid #E5E5E5;">${escaparHtml(valor(visit.location))}</td>
        <td style="padding: 8px; border-bottom: 1px solid #E5E5E5;">${escaparHtml(valor(visit.courtStatus))}</td>
        <td style="padding: 8px; border-bottom: 1px solid #E5E5E5;">${escaparHtml(valor(visit.guidelines))}</td>
      </tr>
    `;
  }).join("");
  return `
    <h3 style="color: #4B1D6D; margin: 20px 0 8px; font-size: 16px;">Visites de la setmana</h3>
    <table style="width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 13px;">
      <thead>
        <tr style="background-color: #4B1D6D; color: #FFC72C;">
          <th style="padding: 8px; text-align: left;">Data</th>
          <th style="padding: 8px; text-align: left;">Jugador/a</th>
          <th style="padding: 8px; text-align: left;">Equip</th>
          <th style="padding: 8px; text-align: left;">Visita</th>
          <th style="padding: 8px; text-align: left;">Tipus</th>
          <th style="padding: 8px; text-align: left;">Estructura</th>
          <th style="padding: 8px; text-align: left;">Localització</th>
          <th style="padding: 8px; text-align: left;">Pista</th>
          <th style="padding: 8px; text-align: left;">Pautes</th>
        </tr>
      </thead>
      <tbody>${rows || '<tr><td style="padding: 10px;" colspan="9">No hi ha dades.</td></tr>'}</tbody>
    </table>
  `;
}

function kpi(label, value) {
  return `
    <td style="padding: 10px; border: 1px solid #E5E5E5; background: #F9F6FC;">
      <div style="font-size: 11px; color: #6B5B75; text-transform: uppercase; font-weight: bold;">${escaparHtml(label)}</div>
      <div style="font-size: 20px; color: #4B1D6D; font-weight: bold; margin-top: 4px;">${escaparHtml(valor(value))}</div>
    </td>
  `;
}

function countBy(source, key) {
  return source && source[key] ? source[key] : 0;
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
