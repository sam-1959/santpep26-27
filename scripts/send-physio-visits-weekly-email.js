#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const FIREBASE_DB_URL = "https://coord-fa09e-default-rtdb.europe-west1.firebasedatabase.app";
const VISITS_PATH = "physioVisits/season-26-27";
const STATUS_PATH = process.env.PHYSIO_VISITS_EMAIL_STATUS_PATH || "data/physio-visits-email-status.json";
const APP_SCRIPT_URL = process.env.PHYSIO_VISITS_EMAIL_APP_SCRIPT_URL || "https://script.google.com/macros/s/AKfycbxpF6Jym7L_lPwBTX1W8ozSEx3h9ytdQrSUOC3tywVvPLkJdgQnpUhVJrokDcucNo3G/exec";
const DRY_RUN = String(process.env.PHYSIO_VISITS_EMAIL_DRY_RUN || "").toLowerCase() === "true";
const FORCE_SEND = String(process.env.PHYSIO_VISITS_EMAIL_FORCE || "").toLowerCase() === "true";
const WEEK_OFFSET_DAYS = Number(process.env.PHYSIO_VISITS_WEEK_OFFSET_DAYS || 7);
const RECIPIENT_OVERRIDE = String(process.env.PHYSIO_VISITS_EMAIL_RECIPIENT_OVERRIDE || "").trim();
const RECIPIENT_NAMES_OVERRIDE = String(process.env.PHYSIO_VISITS_EMAIL_RECIPIENT_NAMES_OVERRIDE || "").trim();
const DEFAULT_RECIPIENTS = String(process.env.PHYSIO_VISITS_EMAIL_RECIPIENTS || "").trim();
const DEFAULT_RECIPIENT_NAMES = String(process.env.PHYSIO_VISITS_EMAIL_RECIPIENT_NAMES || "").trim();

function firebaseUrl(pathName){
  const base = FIREBASE_DB_URL.replace(/\/$/, "");
  return `${base}/${pathName.split("/").map(encodeURIComponent).join("/")}.json`;
}

function nowIso(){
  return new Date().toISOString();
}

function dateInMadrid(){
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return new Date(Number(value.year), Number(value.month) - 1, Number(value.day));
}

function isoFromDate(date){
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateFromISO(value){
  const [year, month, day] = String(value || "").split("-").map(Number);
  return year && month && day ? new Date(year, month - 1, day) : null;
}

function mondayOf(date){
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = copy.getDay() || 7;
  copy.setDate(copy.getDate() - day + 1);
  return copy;
}

function addDays(date, days){
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  copy.setDate(copy.getDate() + days);
  return copy;
}

function formatDate(value){
  const [year, month, day] = String(value || "").split("-");
  return year && month && day ? `${day}/${month}/${year}` : value || "—";
}

function formatDateTime(value){
  if(!value) return "—";
  const date = new Date(value);
  if(Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("ca-ES", {
    timeZone: "Europe/Madrid",
    dateStyle: "short",
    timeStyle: "short"
  });
}

function weekRangeLabel(key){
  const start = dateFromISO(key);
  if(!start) return "—";
  return `${formatDate(isoFromDate(start))} – ${formatDate(isoFromDate(addDays(start, 6)))}`;
}

function normalize(value){
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function readStatus(){
  try {
    return JSON.parse(fs.readFileSync(STATUS_PATH, "utf8"));
  } catch(error) {
    return {};
  }
}

function writeStatus(status){
  fs.mkdirSync(path.dirname(STATUS_PATH), { recursive: true });
  fs.writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2) + "\n", "utf8");
}

function isValidEmail(value){
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function uniqueEmails(value){
  return [...new Set(String(value || "")
    .split(/[,\n;]/)
    .map(email => email.trim())
    .filter(isValidEmail))];
}

function recipientNames(emails){
  const overrideNames = RECIPIENT_NAMES_OVERRIDE || DEFAULT_RECIPIENT_NAMES;
  if(overrideNames) return overrideNames.split(/[,\n;]/).map(name => name.trim()).filter(Boolean);
  return emails;
}

function recipients(){
  const emails = uniqueEmails(RECIPIENT_OVERRIDE || DEFAULT_RECIPIENTS);
  if(!emails.length){
    throw new Error("No hi ha destinataris configurats. Defineix PHYSIO_VISITS_EMAIL_RECIPIENTS o PHYSIO_VISITS_EMAIL_RECIPIENT_OVERRIDE.");
  }
  return { emails, names: recipientNames(emails) };
}

function courtStatusLabel(value){
  const labels = {
    pending: "Pendent",
    red: "No pista",
    orange: "Pista condicionada",
    green: "Pista normal"
  };
  return labels[value] || labels.pending;
}

function visitTypeValue(value, assignedPhysio){
  const normalized = String(value || "").trim().toLowerCase();
  if(normalized === "readaptacio" || normalized === "readaptació") return "readaptacio";
  if(normalized === "fisio" || normalized === "fisioterapia" || normalized === "fisioteràpia") return "fisio";
  return String(assignedPhysio || "").trim() === "Miquel Sánchez" ? "readaptacio" : "fisio";
}

function visitTypeLabel(value, assignedPhysio){
  return visitTypeValue(value, assignedPhysio) === "readaptacio" ? "Readaptació" : "Fisioteràpia";
}

function teamCategory(value){
  const code = normalize(value).toUpperCase();
  if(code.startsWith("I")) return "INFANTIL";
  if(code.startsWith("M")) return "MINI";
  if(code.startsWith("C")) return "CADET";
  if(code.startsWith("J")) return "JÚNIOR";
  if(code.startsWith("S")) return "SÉNIOR";
  return value || "—";
}

function normalizeVisit(row, id){
  return {
    id,
    createdAt: row.createdAt || "",
    updatedAt: row.updatedAt || "",
    date: row.date || "",
    name: row.name || [row.firstName, row.lastName].filter(Boolean).join(" "),
    gender: row.gender || "",
    team: row.team || "",
    teamCategory: teamCategory(row.team || ""),
    assignedPhysio: row.assignedPhysio || row.physio || "",
    visitType: visitTypeValue(row.visitType, row.assignedPhysio || row.physio || ""),
    structure: row.structure || "",
    location: row.location || "",
    mechanism: row.mechanism || "",
    assessment: row.assessment || "",
    treatment: row.treatment || "",
    guidelines: row.guidelines || "",
    courtStatus: row.courtStatus || "pending",
    prepaRead: Boolean(row.prepaRead),
    prepaReadAt: row.prepaReadAt || "",
    prepaReadByName: row.prepaReadByName || row.prepaReadBy?.name || row.prepaFeedback?.byName || "",
    prepaFeedbackText: row.prepaFeedback?.text || "",
    prepaFeedbackAt: row.prepaFeedback?.updatedAt || ""
  };
}

async function readFirebase(pathName){
  const response = await fetch(firebaseUrl(pathName), { cache: "no-store" });
  if(!response.ok) throw new Error(`No s'ha pogut llegir ${pathName}: ${response.status}`);
  return await response.json();
}

function groupByPlayer(records){
  const groups = new Map();
  records.forEach(record => {
    const key = normalize(record.name) || record.id;
    if(!groups.has(key)) groups.set(key, { player: record.name || "Sense nom", records: [] });
    groups.get(key).records.push(record);
  });
  return [...groups.values()].map(group => {
    const sorted = group.records.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt)));
    const latest = sorted[0] || {};
    return {
      player: group.player,
      visits: sorted.length,
      latest,
      records: sorted
    };
  }).sort((a, b) => a.player.localeCompare(b.player, "ca"));
}

function buildPayload({ selectedWeek, dates, records, recipientsData }){
  const players = groupByPlayer(records).map(group => ({
    player: group.player,
    visits: group.visits,
    latestDate: formatDate(group.latest.date),
    team: group.latest.team || "—",
    teamCategory: group.latest.teamCategory || "—",
    assignedPhysio: group.latest.assignedPhysio || "—",
    visitType: visitTypeLabel(group.latest.visitType, group.latest.assignedPhysio),
    courtStatus: courtStatusLabel(group.latest.courtStatus),
    structure: group.latest.structure || "—",
    location: group.latest.location || "—",
    guidelines: group.latest.guidelines || "Sense pauta",
    prepaRead: group.latest.prepaRead ? "Sí" : "No",
    prepaReadAt: group.latest.prepaReadAt ? formatDateTime(group.latest.prepaReadAt) : "—",
    prepaFeedback: group.latest.prepaFeedbackText || "—",
    prepaFeedbackAt: group.latest.prepaFeedbackAt ? formatDateTime(group.latest.prepaFeedbackAt) : "—"
  }));

  const byType = records.reduce((acc, record) => {
    const label = visitTypeLabel(record.visitType, record.assignedPhysio);
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});

  const byCourt = records.reduce((acc, record) => {
    const label = courtStatusLabel(record.courtStatus);
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});

  return {
    type: "physio_visits_weekly",
    recipient: recipientsData.emails.join(","),
    recipientNames: recipientsData.names.join(", "),
    week: selectedWeek,
    weekLabel: weekRangeLabel(selectedWeek),
    summary: {
      records: records.length,
      players: players.length,
      from: formatDate(dates[0]),
      to: formatDate(dates[dates.length - 1]),
      byType,
      byCourt
    },
    visits: records.map(record => ({
      date: formatDate(record.date),
      player: record.name || "—",
      team: record.team || "—",
      teamCategory: record.teamCategory || "—",
      assignedPhysio: record.assignedPhysio || "—",
      visitType: visitTypeLabel(record.visitType, record.assignedPhysio),
      courtStatus: courtStatusLabel(record.courtStatus),
      structure: record.structure || "—",
      location: record.location || "—",
      guidelines: record.guidelines || "Sense pauta",
      prepaRead: record.prepaRead ? "Sí" : "No",
      prepaFeedback: record.prepaFeedbackText || "—"
    })),
    players
  };
}

async function sendPayload(payload){
  if(DRY_RUN){
    console.log(`[DRY_RUN] S'enviaria resum de Visites Fisio (${payload.weekLabel}) a ${payload.recipientNames || payload.recipient}. Visites: ${payload.summary.records}`);
    return "dry-run";
  }
  if(!APP_SCRIPT_URL){
    throw new Error("Falta PHYSIO_VISITS_EMAIL_APP_SCRIPT_URL.");
  }
  const response = await fetch(APP_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  if(!response.ok) throw new Error(`App Script ha retornat ${response.status}: ${text}`);
  const parsed = (() => {
    try { return JSON.parse(text); } catch(error) { return null; }
  })();
  if(parsed && parsed.ok === false) throw new Error(`App Script ha retornat error: ${parsed.error || text}`);
  return text;
}

async function main(){
  const status = readStatus();
  const selectedWeek = isoFromDate(mondayOf(addDays(dateInMadrid(), -WEEK_OFFSET_DAYS)));
  const dates = Array.from({ length: 7 }, (_, index) => isoFromDate(addDays(dateFromISO(selectedWeek), index)));
  const statusKey = selectedWeek;
  const currentStatus = status[statusKey] || {};

  if(currentStatus.lastSentWeek === selectedWeek && !FORCE_SEND){
    console.log(`Resum de Visites Fisio ja enviat per la setmana ${selectedWeek}.`);
    return;
  }

  status[statusKey] = {
    ...currentStatus,
    lastAttemptAt: nowIso(),
    lastAttemptWeek: selectedWeek,
    lastStatus: "attempted",
    lastError: ""
  };
  writeStatus(status);

  const data = await readFirebase(VISITS_PATH);
  const records = Object.entries(data || {})
    .map(([id, row]) => normalizeVisit(row || {}, id))
    .filter(record => dates.includes(record.date))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || a.name.localeCompare(b.name, "ca"));

  if(!records.length){
    status[statusKey] = {
      ...status[statusKey],
      lastStatus: "skipped_no_data",
      lastSkippedAt: nowIso(),
      lastSkippedReason: "No hi ha visites de fisio la setmana seleccionada.",
      lastRecords: 0
    };
    writeStatus(status);
    console.log(`No s'envia el resum de Visites Fisio: no hi ha dades per ${weekRangeLabel(selectedWeek)}.`);
    return;
  }

  const recipientsData = recipients();
  const payload = buildPayload({ selectedWeek, dates, records, recipientsData });
  const responseText = await sendPayload(payload);

  status[statusKey] = DRY_RUN
    ? {
      ...status[statusKey],
      lastStatus: "dry_run",
      lastDryRunAt: nowIso(),
      lastDryRunWeek: selectedWeek,
      lastDryRunRecipients: recipientsData.emails,
      lastDryRunRecipientNames: recipientsData.names,
      lastWeekLabel: payload.weekLabel,
      lastRecords: records.length,
      lastPlayers: payload.summary.players,
      lastError: ""
    }
    : {
      ...status[statusKey],
      lastStatus: "sent",
      lastSentAt: nowIso(),
      lastSentWeek: selectedWeek,
      lastRecipients: recipientsData.emails,
      lastRecipientNames: recipientsData.names,
      lastWeekLabel: payload.weekLabel,
      lastRecords: records.length,
      lastPlayers: payload.summary.players,
      lastError: ""
    };
  writeStatus(status);

  console.log(`Resum de Visites Fisio ${DRY_RUN ? "validat" : "demanat"} (${payload.weekLabel}) a ${recipientsData.names.join(", ")}. Visites: ${records.length}, jugadores/players: ${payload.summary.players}.`);
  if(responseText) console.log(responseText);
}

main().catch(error => {
  const status = readStatus();
  const selectedWeek = isoFromDate(mondayOf(addDays(dateInMadrid(), -WEEK_OFFSET_DAYS)));
  status[selectedWeek] = {
    ...(status[selectedWeek] || {}),
    lastStatus: "error",
    lastError: String(error && error.message ? error.message : error),
    lastErrorAt: nowIso()
  };
  writeStatus(status);
  console.error(error);
  process.exit(1);
});
