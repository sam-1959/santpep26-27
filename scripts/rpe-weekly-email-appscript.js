// Apps Script Web App per enviar el resum setmanal de Seguiment RPE.
//
// Desplegament:
// 1. Enganxa aquest fitxer a https://script.google.com/.
// 2. Deploy > New deployment > Web app.
// 3. Execute as: Me.
// 4. Who has access: Anyone.
// 5. Autoritza GmailApp.
// 6. Copia la URL /exec i posa-la a RPE_EMAIL_APP_SCRIPT_URL dins wellness-dades.html.

function doPost(e) {
  try {
    var request = JSON.parse((e.postData && e.postData.contents) || "{}");
    var resultat = enviarCorreuRpeSetmanal(request);
    return respostaJson({ ok: true, sentTo: resultat.sentTo, sentCount: resultat.sentTo.length });
  } catch (error) {
    Logger.log("Error enviant correu RPE: " + error);
    return respostaJson({ ok: false, error: String(error) });
  }
}

function enviarCorreuRpeSetmanal(request) {
  var destinataris = normalitzarCorreus([request.recipient || "ricard.fuste@gmail.com"]);
  if (!destinataris.length) {
    throw new Error("No hi ha destinatari configurat.");
  }

  var team = valor(request.team);
  var weekLabel = valor(request.weekLabel);
  var summary = request.summary || {};
  var dates = request.dates || [];
  var players = request.players || [];

  var assumpte = "Seguiment RPE setmanal - " + team + " - " + weekLabel;
  var cosText = construirTextPla(team, weekLabel, summary, players);
  var cosHTML = construirHtml(team, weekLabel, summary, dates, players);

  destinataris.forEach(function(correu) {
    GmailApp.sendEmail(correu, assumpte, cosText, {
      htmlBody: cosHTML,
      name: "CB Sant Josep Badalona"
    });
    Logger.log("Correu RPE enviat a: " + correu);
  });

  return { sentTo: destinataris };
}

function construirTextPla(team, weekLabel, summary, players) {
  var lines = [
    "CB SANT JOSEP BADALONA",
    "",
    "Seguiment RPE setmanal",
    "Equip: " + team,
    "Setmana: " + weekLabel,
    "",
    "Resum:",
    "- Registres: " + valor(summary.records),
    "- RPE mitjà: " + valor(summary.rpe),
    "- Fatiga mitjana: " + valor(summary.fatigue),
    "- Son mitjana: " + valor(summary.sleep),
    "- Càrrega total: " + valor(summary.load),
    "",
    "Detall per jugador/a:"
  ];

  players.forEach(function(player) {
    lines.push(
      (player.number ? "#" + player.number + " " : "") + valor(player.player),
      "  RPE: " + valors(player.rpe).join(" | ") + " · Mitjana: " + valor(player.averages && player.averages.rpe),
      "  Fatiga: " + valors(player.fatigue).join(" | ") + " · Mitjana: " + valor(player.averages && player.averages.fatigue),
      "  Son: " + valors(player.sleep).join(" | ") + " · Mitjana: " + valor(player.averages && player.averages.sleep),
      "  Càrrega: " + valors(player.load).join(" | ") + " · Total: " + valor(player.averages && player.averages.load),
      ""
    );
  });

  return lines.join("\n");
}

function construirHtml(team, weekLabel, summary, dates, players) {
  return `
    <div style="font-family: 'Helvetica Neue', Arial, sans-serif; color: #333; max-width: 900px; margin: 0 auto; border: 1px solid #E5E5E5; border-radius: 8px; overflow: hidden;">
      <div style="background-color: #4B1D6D; padding: 24px; text-align: center; border-bottom: 4px solid #FFC72C;">
        <h1 style="color: #FFC72C; margin: 0; font-size: 22px; text-transform: uppercase; letter-spacing: 1px;">CB Sant Josep Badalona</h1>
        <p style="color: #FFFFFF; margin: 6px 0 0 0; font-size: 14px;">Seguiment RPE setmanal</p>
      </div>

      <div style="padding: 22px; background-color: #FFFFFF;">
        <h2 style="color: #4B1D6D; margin: 0 0 4px; font-size: 20px;">${escaparHtml(team)}</h2>
        <p style="margin: 0 0 18px; color: #666; font-weight: bold;">Setmana ${escaparHtml(weekLabel)}</p>

        <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
          <tr>
            ${kpi("Registres", summary.records)}
            ${kpi("RPE mitjà", summary.rpe)}
            ${kpi("Fatiga mitjana", summary.fatigue)}
            ${kpi("Son mitjana", summary.sleep)}
            ${kpi("Càrrega total", summary.load)}
          </tr>
        </table>

        ${taulaMetrica("RPE", dates, players, "rpe", "rpe")}
        ${taulaMetrica("Fatiga", dates, players, "fatigue", "fatigue")}
        ${taulaMetrica("Qualitat de la son", dates, players, "sleep", "sleep")}
        ${taulaMetrica("Càrrega", dates, players, "load", "load")}
      </div>

      <div style="background-color: #F4F4F4; padding: 14px; text-align: center; border-top: 1px solid #EEEEEE;">
        <p style="font-size: 12px; color: #666666; margin: 0;"><strong>CB Sant Josep Badalona</strong> — Notificació automàtica del club.</p>
      </div>
    </div>
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

function taulaMetrica(title, dates, players, field, averageField) {
  var headerDates = dates.map(function(date) {
    return '<th style="padding: 8px; border-bottom: 1px solid #E5E5E5; text-align: center;">' + escaparHtml(date.label || date.iso) + '</th>';
  }).join("");
  var rows = players.map(function(player) {
    var values = valors(player[field]).map(function(value) {
      return '<td style="padding: 8px; border-bottom: 1px solid #E5E5E5; text-align: center;">' + escaparHtml(value) + '</td>';
    }).join("");
    return `
      <tr>
        <td style="padding: 8px; border-bottom: 1px solid #E5E5E5; font-weight: bold; color: #4B1D6D; white-space: nowrap;">${player.number ? "#" + escaparHtml(player.number) + " " : ""}${escaparHtml(valor(player.player))}</td>
        ${values}
        <td style="padding: 8px; border-bottom: 1px solid #E5E5E5; text-align: center; font-weight: bold;">${escaparHtml(valor(player.averages && player.averages[averageField]))}</td>
      </tr>
    `;
  }).join("");

  return `
    <h3 style="color: #4B1D6D; margin: 20px 0 8px; font-size: 16px;">${escaparHtml(title)}</h3>
    <table style="width: 100%; border-collapse: collapse; margin-bottom: 12px; font-size: 13px;">
      <thead>
        <tr style="background-color: #4B1D6D; color: #FFC72C;">
          <th style="padding: 8px; text-align: left;">Jugador/a</th>
          ${headerDates}
          <th style="padding: 8px; text-align: center;">Mitjana</th>
        </tr>
      </thead>
      <tbody>${rows || '<tr><td style="padding: 10px;" colspan="' + (dates.length + 2) + '">No hi ha dades.</td></tr>'}</tbody>
    </table>
  `;
}

function valors(input) {
  return (input || []).map(function(value) {
    return value === "" || value == null ? "—" : String(value);
  });
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
