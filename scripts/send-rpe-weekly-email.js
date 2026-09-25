#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const FIREBASE_DB_URL = "https://coord-fa09e-default-rtdb.europe-west1.firebasedatabase.app";
const RESPONSES_PATH = "wellnessResponses/season-26-27";
const ROSTERS_PATH = "rpeRosters/season-26-27";
const CONTACTS_PATH = "seasonContacts/season-26-27";
const RPE_EMAIL_APP_SCRIPT_URL = process.env.RPE_EMAIL_APP_SCRIPT_URL || "https://script.google.com/macros/s/AKfycbxDAD6TMxQh_fb5hRuv8o2NA1bdZaknBoEsICDz1fGX75DqdOu_PKrorXZ4Bu3TuSzBuA/exec";
const STATUS_PATH = process.env.RPE_EMAIL_STATUS_PATH || "data/rpe-email-status.json";
const DRY_RUN = String(process.env.RPE_EMAIL_DRY_RUN || "").toLowerCase() === "true";
const FORCE_SEND = String(process.env.RPE_EMAIL_FORCE || "").toLowerCase() === "true";
const WEEK_OFFSET_DAYS = Number(process.env.RPE_WEEK_OFFSET_DAYS || 7);
const RECIPIENT_OVERRIDE = String(process.env.RPE_EMAIL_RECIPIENT_OVERRIDE || "").trim();
const RECIPIENT_NAMES_OVERRIDE = String(process.env.RPE_EMAIL_RECIPIENT_NAMES_OVERRIDE || "").trim();
const DEFAULT_TEAM_ORDER = ["CBM", "CAM", "CF", "JBM", "JAM", "JBF", "JAF", "SBM", "SAM", "SAF"];

const DEFAULT_TEAM_NAMES_BY_KEY = {
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

const teamNamesByKey = { ...DEFAULT_TEAM_NAMES_BY_KEY };
const teamRosters = {};

function firebaseUrl(path){
  const base = FIREBASE_DB_URL.replace(/\/$/, "");
  const safePath = path.split("/").map(encodeURIComponent).join("/");
  return `${base}/${safePath}.json`;
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

function nowIso(){
  return new Date().toISOString();
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

function weekRangeLabel(key){
  const start = dateFromISO(key);
  if(!start) return "—";
  return `${formatDate(isoFromDate(start))} – ${formatDate(isoFromDate(addDays(start, 6)))}`;
}

function normalizeName(value){
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/\s+/g, " ");
}

function numeric(value){
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function average(records, field){
  const values = records.map(item => numeric(item[field])).filter(value => value > 0);
  if(!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatNumber(value, decimals = 1){
  return value === null || value === undefined || Number.isNaN(value)
    ? "—"
    : value.toLocaleString("ca-ES", { maximumFractionDigits: decimals, minimumFractionDigits: decimals });
}

function rosterNumber(team, player){
  const roster = teamRosters[team] || [];
  const normalizedPlayer = normalizeName(player);
  const match = roster.find(([, name]) => normalizeName(name) === normalizedPlayer);
  return match ? match[0] : "";
}

function numberSortValue(value){
  const numericValue = Number(String(value || "").replace(/\D/g, ""));
  return Number.isFinite(numericValue) ? numericValue : 9999;
}

function isValidEmail(value){
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function uniqueEmails(emails){
  return [...new Set(emails.map(email => String(email || "").trim()).filter(isValidEmail))];
}

function coordinatorRoleForTeam(teamKey){
  return String(teamKey || "").toUpperCase().endsWith("F") ? "femeni" : "masculi";
}

function contactLabel(contact){
  return contact && contact.name ? contact.name : contact && contact.email ? contact.email : "";
}

async function readFirebase(path){
  const response = await fetch(firebaseUrl(path), { cache: "no-store" });
  if(!response.ok) throw new Error(`No s'ha pogut llegir ${path}: ${response.status}`);
  return await response.json();
}

async function loadRosters(){
  const data = await readFirebase(ROSTERS_PATH);
  Object.entries(data || {}).forEach(([key, team]) => {
    const normalizedKey = String(key || "").trim().toUpperCase();
    if(!normalizedKey || !team) return;
    const name = String(team.name || teamNamesByKey[normalizedKey] || normalizedKey).trim();
    const players = Array.isArray(team.players)
      ? team.players.map(player => [String(player.number || ""), String(player.name || "").trim()]).filter(([, playerName]) => playerName)
      : [];
    teamNamesByKey[normalizedKey] = name;
    if(players.length) teamRosters[name] = players;
  });
}

function selectedTeamKeys(){
  const raw = String(process.env.RPE_TEAM_KEYS || "ALL").trim();
  if(raw && raw.toUpperCase() !== "ALL"){
    return raw.split(/[;,\s]+/).map(key => key.trim().toUpperCase()).filter(Boolean);
  }
  const keys = Object.keys(teamNamesByKey);
  return [
    ...DEFAULT_TEAM_ORDER.filter(key => keys.includes(key)),
    ...keys.filter(key => !DEFAULT_TEAM_ORDER.includes(key)).sort((a, b) => a.localeCompare(b, "ca"))
  ];
}

function loadRecipients(teamKey, contacts){
  if(RECIPIENT_OVERRIDE){
    const emails = uniqueEmails([RECIPIENT_OVERRIDE]);
    if(!emails.length) throw new Error(`El destinatari de prova no és vàlid: ${RECIPIENT_OVERRIDE}`);
    return {
      emails,
      names: [RECIPIENT_NAMES_OVERRIDE || emails[0]]
    };
  }
  const role = coordinatorRoleForTeam(teamKey);
  const coordinators = Array.isArray(contacts.coordinators) ? contacts.coordinators : [];
  const coordinator = coordinators.find(contact => String(contact.role || "") === role);
  const prepaCoordinator = coordinators.find(contact => String(contact.role || "") === "coordinador_prepa");
  const headCoach = contacts.headCoaches && contacts.headCoaches[teamKey];
  const prepas = coordinators.filter(contact =>
    String(contact.role || "") === "prepa" &&
    Array.isArray(contact.teams) &&
    contact.teams.map(team => String(team || "").trim().toUpperCase()).includes(teamKey)
  );
  const missing = [];
  if(!isValidEmail(coordinator && coordinator.email)) missing.push(`coordinador ${role}`);
  if(!isValidEmail(headCoach && headCoach.email)) missing.push(`primer entrenador ${teamKey}`);
  if(!isValidEmail(prepaCoordinator && prepaCoordinator.email)) missing.push("coordinador prepa");
  if(!prepas.some(contact => isValidEmail(contact.email))) missing.push(`prepa ${teamKey}`);
  if(missing.length) throw new Error(`Falten destinataris del correu RPE ${teamKey}: ${missing.join(", ")}.`);
  return {
    emails: uniqueEmails([coordinator.email, headCoach.email, prepaCoordinator.email, ...prepas.map(contact => contact.email)]),
    names: [...new Set([coordinator, headCoach, prepaCoordinator, ...prepas].map(contactLabel).filter(Boolean))]
  };
}

function normalizeRecord(record, id){
  const teamKey = String(record.teamKey || "").trim().toUpperCase() || "JBF";
  const fallbackTeam = teamNamesByKey[teamKey] || "Júnior B F";
  const durationTotalMinutes = numeric(record.durationTotalMinutes) || numeric(record.durationHours) * 60 + numeric(record.durationMinutes);
  const rpe = numeric(record.rpe);
  return {
    id,
    ...record,
    teamKey,
    team: record.team || fallbackTeam,
    playerNumber: record.playerNumber || rosterNumber(record.team || fallbackTeam, record.player),
    durationTotalMinutes,
    rpe,
    muscleFatigue: numeric(record.muscleFatigue),
    sleepQuality: numeric(record.sleepQuality),
    load: numeric(record.load) || rpe * durationTotalMinutes
  };
}

function valuesFor(group, dates, field){
  return dates.map(date => {
    const dayRecords = group.records.filter(record => record.trainingDate === date);
    if(!dayRecords.length) return "";
    const value = dayRecords.reduce((sum, record) => sum + numeric(field(record)), 0) / dayRecords.length;
    return Math.round(value * 10) / 10;
  });
}

function alertLabels(group){
  const labels = [];
  if(group.rpe !== null && group.rpe >= 8) labels.push("RPE");
  if(group.fatigue !== null && group.fatigue >= 4) labels.push("Fatiga");
  if(group.sleep !== null && group.sleep <= 2) labels.push("Son");
  return labels;
}

function buildPayload({ teamKey, team, selectedWeek, dates, records, recipients }){
  const groups = new Map();
  records.forEach(record => {
    const key = record.player || "Sense nom";
    if(!groups.has(key)) groups.set(key, { player: key, team: record.team, records: [] });
    groups.get(key).records.push(record);
  });

  const players = [...groups.values()]
    .map(group => ({
      ...group,
      load: group.records.reduce((sum, record) => sum + numeric(record.load), 0),
      rpe: average(group.records, "rpe"),
      fatigue: average(group.records, "muscleFatigue"),
      sleep: average(group.records, "sleepQuality")
    }))
    .sort((a, b) => {
      const aNumber = rosterNumber(team, a.player) || a.records.find(record => record.playerNumber)?.playerNumber;
      const bNumber = rosterNumber(team, b.player) || b.records.find(record => record.playerNumber)?.playerNumber;
      return numberSortValue(aNumber) - numberSortValue(bNumber) || a.player.localeCompare(b.player, "ca");
    });

  const totalLoad = records.reduce((sum, record) => sum + numeric(record.load), 0);
  const rpeHigh = players.filter(group => alertLabels(group).includes("RPE")).map(group => group.player);
  const fatigueHigh = players.filter(group => alertLabels(group).includes("Fatiga")).map(group => group.player);
  const sleepLow = players.filter(group => alertLabels(group).includes("Son")).map(group => group.player);
  return {
    recipient: recipients.emails.join(","),
    recipientNames: recipients.names.join(", "),
    testMode: true,
    automated: true,
    teamKey,
    team,
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
    dates: dates.map(date => ({ iso: date, label: formatDate(date).slice(0, 5) })),
    players: players.map(group => {
      const number = rosterNumber(team, group.player) || group.records.find(record => record.playerNumber)?.playerNumber || "";
      return {
        number,
        player: group.player,
        team: group.team,
        alerts: alertLabels(group),
        rpe: valuesFor(group, dates, record => record.rpe),
        fatigue: valuesFor(group, dates, record => record.muscleFatigue),
        sleep: valuesFor(group, dates, record => record.sleepQuality),
        load: valuesFor(group, dates, record => record.load).map(value => value === "" ? "" : Math.round(value)),
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

async function sendPayload(payload){
  if(DRY_RUN){
    console.log(`[DRY_RUN] S'enviaria RPE ${payload.teamKey} ${payload.team} (${payload.weekLabel}) a ${payload.recipientNames || payload.recipient}. Registres: ${payload.summary.records}`);
    return "dry-run";
  }
  const response = await fetch(RPE_EMAIL_APP_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  if(!response.ok) throw new Error(`App Script ha retornat ${response.status}: ${text}`);
  return text;
}

async function processTeam({ teamKey, selectedWeek, dates, allRecords, contacts, status }){
  const today = isoFromDate(dateInMadrid());
  const teamStatus = status[teamKey] || {};
  if(teamStatus.lastSentWeek === selectedWeek && !FORCE_SEND){
    console.log(`Correu RPE ${teamKey} ja enviat per la setmana ${selectedWeek}.`);
    return { teamKey, status: "already_sent" };
  }

  const team = teamNamesByKey[teamKey] || teamKey;
  const records = allRecords.filter(record => record.teamKey === teamKey && dates.includes(record.trainingDate));
  status[teamKey] = {
    ...teamStatus,
    lastAttemptDate: today,
    lastAttemptAt: nowIso(),
    lastAttemptWeek: selectedWeek,
    lastStatus: "attempted",
    lastError: ""
  };
  writeStatus(status);

  if(!records.length){
    status[teamKey] = {
      ...status[teamKey],
      lastStatus: "skipped_no_data",
      lastError: "",
      lastSkippedAt: nowIso(),
      lastSkippedWeek: selectedWeek,
      lastSkippedReason: "No hi ha dades setmanals per enviar."
    };
    writeStatus(status);
    console.log(`No s'envia el correu RPE ${teamKey}: no hi ha dades de la setmana ${selectedWeek}.`);
    return { teamKey, status: "skipped_no_data" };
  }

  try {
    const recipients = loadRecipients(teamKey, contacts);
    const payload = buildPayload({ teamKey, team, selectedWeek, dates, records, recipients });
    const text = await sendPayload(payload);
    status[teamKey] = DRY_RUN
      ? {
        ...status[teamKey],
        lastDryRunAt: nowIso(),
        lastDryRunWeek: selectedWeek,
        lastDryRunRecipients: recipients.emails,
        lastDryRunRecipientNames: recipients.names,
        lastTeam: team,
        lastWeek: selectedWeek,
        lastWeekLabel: payload.weekLabel,
        lastRecords: records.length,
        lastStatus: "dry_run",
        lastError: ""
      }
      : {
        ...status[teamKey],
        lastSentDate: today,
        lastSentAt: nowIso(),
        lastSentWeek: selectedWeek,
        lastRecipient: recipients.emails.join(","),
        lastRecipients: recipients.emails,
        lastRecipientNames: recipients.names,
        lastTeam: team,
        lastWeek: selectedWeek,
        lastWeekLabel: payload.weekLabel,
        lastRecords: records.length,
        lastStatus: "sent",
        lastError: ""
      };
    writeStatus(status);
    console.log(`Correu RPE ${DRY_RUN ? "validat" : "demanat"} per ${team} (${payload.weekLabel}) a ${recipients.names.join(", ")}. Registres: ${records.length}`);
    if(text) console.log(text);
    return { teamKey, status: DRY_RUN ? "dry_run" : "sent", records: records.length };
  } catch(error) {
    status[teamKey] = {
      ...status[teamKey],
      lastStatus: "error",
      lastError: String(error && error.message ? error.message : error),
      lastErrorAt: nowIso()
    };
    writeStatus(status);
    console.error(error);
    return { teamKey, status: "error", error };
  }
}

async function main(){
  const status = readStatus();
  await loadRosters();
  const contacts = await readFirebase(CONTACTS_PATH) || {};
  const responses = await readFirebase(RESPONSES_PATH) || {};
  const selectedWeek = isoFromDate(mondayOf(addDays(dateInMadrid(), -WEEK_OFFSET_DAYS)));
  const dates = Array.from({ length: 7 }, (_, index) => isoFromDate(addDays(dateFromISO(selectedWeek), index)));
  const allRecords = Object.entries(responses).map(([id, record]) => normalizeRecord(record || {}, id));
  const results = [];

  for(const teamKey of selectedTeamKeys()){
    results.push(await processTeam({ teamKey, selectedWeek, dates, allRecords, contacts, status }));
  }

  const errors = results.filter(result => result.status === "error");
  const sent = results.filter(result => result.status === "sent" || result.status === "dry_run");
  const skipped = results.filter(result => result.status === "skipped_no_data" || result.status === "already_sent");
  console.log(`Resum ERP: enviats=${sent.length}, saltats=${skipped.length}, errors=${errors.length}.`);
  if(errors.length) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
