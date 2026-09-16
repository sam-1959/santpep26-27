const RECIPIENTS = ["ricard.fuste@gmail.com"];

function doPost(e) {
  try {
    const request = JSON.parse(e.postData && e.postData.contents || "{}");
    const subject = "Nova petició de fisio · " + (request.player || "Jugador/a");
    const body = buildBody(request);
    MailApp.sendEmail({
      to: RECIPIENTS.join(","),
      subject,
      body,
      htmlBody: buildHtml(request)
    });
    return jsonResponse({ ok: true });
  } catch (error) {
    console.error(error);
    return jsonResponse({ ok: false, error: String(error) });
  }
}

function buildBody(request) {
  return [
    "Nova petició de fisioteràpia",
    "",
    "Data sol·licitud: " + formatDateTime(request.createdAt),
    "Jugador/a: " + value(request.player),
    "Equip: " + value(request.team) + (request.gender ? " " + request.gender : ""),
    "Data lesió: " + value(request.injuryDate),
    "Pare/mare: " + value(request.guardianName),
    "Email: " + value(request.email),
    "Telèfon: " + value(request.phone),
    "",
    "Descripció:",
    value(request.description),
    "",
    "Peticions:",
    "https://sam-1959.github.io/santpep26-27/fisio-peticions.html"
  ].join("\n");
}

function buildHtml(request) {
  const rows = [
    ["Data sol·licitud", formatDateTime(request.createdAt)],
    ["Jugador/a", request.player],
    ["Equip", value(request.team) + (request.gender ? " " + request.gender : "")],
    ["Data lesió", request.injuryDate],
    ["Pare/mare", request.guardianName],
    ["Email", request.email],
    ["Telèfon", request.phone],
    ["Descripció", request.description]
  ];
  return `
    <div style="font-family:Arial,sans-serif;color:#2a2233;line-height:1.4">
      <h2 style="color:#5a2f7d;margin:0 0 12px">Nova petició de fisioteràpia</h2>
      <table style="border-collapse:collapse;width:100%;max-width:720px">
        ${rows.map(([label, val]) => `
          <tr>
            <th style="text-align:left;padding:8px;border-bottom:1px solid #e6e0ee;color:#5a2f7d;white-space:nowrap">${escapeHtml(label)}</th>
            <td style="padding:8px;border-bottom:1px solid #e6e0ee">${escapeHtml(value(val))}</td>
          </tr>
        `).join("")}
      </table>
      <p style="margin-top:16px">
        <a href="https://sam-1959.github.io/santpep26-27/fisio-peticions.html"
           style="display:inline-block;background:#713f97;color:#fff;text-decoration:none;border-radius:999px;padding:10px 14px;font-weight:bold">
          Obrir peticions
        </a>
      </p>
    </div>
  `;
}

function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (isNaN(date.getTime())) return String(value);
  return Utilities.formatDate(date, "Europe/Madrid", "dd/MM/yyyy HH:mm");
}

function value(input) {
  return input == null || input === "" ? "—" : String(input);
}

function escapeHtml(input) {
  return value(input).replace(/[&<>"']/g, function(char) {
    return {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;"
    }[char];
  });
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
