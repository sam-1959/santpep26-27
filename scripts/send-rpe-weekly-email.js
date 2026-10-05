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
const MAX_TEAMS_PER_RECIPIENT_EMAIL = Math.max(1, Number(process.env.RPE_MAX_TEAMS_PER_EMAIL || 2));
const DEFAULT_TEAM_ORDER = ["CBM", "CAM", "CF", "JBM", "JAM", "JBF", "JAF", "SBM", "SAM", "SAF"];
const RPE_EXCLUDED_TEAM_KEYS = new Set(["IBM", "IAM", "IF"]);

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

function sleepHoursValue(value){
  const text = String(value || "").toLowerCase().replace(",", ".");
  const nums = (text.match(/\d+(?:\.\d+)?/g) || []).map(Number).filter(Number.isFinite);
  if(!nums.length) return 0;
  if(nums.length >= 2 && /\bde\b|\ba\b|-/.test(text)) return (nums[0] + nums[1]) / 2;
  return nums[0];
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
    return raw.split(/[;,\s]+/)
      .map(key => key.trim().toUpperCase())
      .filter(key => key && !RPE_EXCLUDED_TEAM_KEYS.has(key));
  }
  const keys = Object.keys(teamNamesByKey).filter(key => !RPE_EXCLUDED_TEAM_KEYS.has(key));
  return [
    ...DEFAULT_TEAM_ORDER.filter(key => keys.includes(key)),
    ...keys.filter(key => !DEFAULT_TEAM_ORDER.includes(key)).sort((a, b) => a.localeCompare(b, "ca"))
  ];
}

function loadRecipients(teamKey, contacts){
  const role = coordinatorRoleForTeam(teamKey);
  const coordinators = Array.isArray(contacts.coordinators) ? contacts.coordinators : [];
  const coordinator = coordinators.find(contact => String(contact.role || "") === role);
  const prepaCoordinator = coordinators.find(contact => String(contact.role || "") === "coordinador_prepa");
  const technicalDirector = coordinators.find(contact => String(contact.role || "") === "dt");
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
  if(!isValidEmail(technicalDirector && technicalDirector.email)) missing.push("director tècnic");
  if(!prepas.some(contact => isValidEmail(contact.email))) missing.push(`prepa ${teamKey}`);
  if(missing.length) throw new Error(`Falten destinataris del correu RPE ${teamKey}: ${missing.join(", ")}.`);
  const contactsList = [coordinator, headCoach, prepaCoordinator, technicalDirector, ...prepas];
  return {
    contacts: contactsList.filter(contact => isValidEmail(contact && contact.email)),
    emails: uniqueEmails(contactsList.map(contact => contact && contact.email)),
    names: [...new Set(contactsList.map(contactLabel).filter(Boolean))]
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
    sleepHours: sleepHoursValue(record.sleepHours),
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
  if(group.rpe !== null && group.rpe >= 7) labels.push("RPE");
  if(group.fatigue !== null && group.fatigue >= 4) labels.push("Fatiga");
  if(group.sleep !== null && group.sleep <= 6) labels.push("Son");
  return labels;
}

function weekKey(value){
  const date = dateFromISO(value);
  return date ? isoFromDate(mondayOf(date)) : "";
}

function weeklyLoadAverage(records){
  if(!records.length) return null;
  return records.reduce((sum, record) => sum + numeric(record.load), 0) / records.length;
}

function loadTrend(group, teamKey, allRecords){
  const selectedWeekAverage = weeklyLoadAverage(group.records);
  if(selectedWeekAverage === null) return null;
  const playerRecords = allRecords.filter(record =>
    record.teamKey === teamKey && normalizeName(record.player) === normalizeName(group.player)
  );
  const weeks = [...new Set(playerRecords.map(record => weekKey(record.trainingDate)).filter(Boolean))];
  const averages = weeks
    .map(key => weeklyLoadAverage(playerRecords.filter(record => weekKey(record.trainingDate) === key)))
    .filter(value => value !== null);
  if(!averages.length) return null;
  const seasonAverage = averages.reduce((sum, value) => sum + value, 0) / averages.length;
  if(!seasonAverage) return null;
  return { value: (selectedWeekAverage - seasonAverage) / seasonAverage * 100, seasonAverage };
}

function buildPayload({ teamKey, team, selectedWeek, dates, records, allRecords, recipients }){
  const groups = new Map();
  records.forEach(record => {
    const key = record.player || "Sense nom";
    if(!groups.has(key)) groups.set(key, { player: key, team: record.team, records: [] });
    groups.get(key).records.push(record);
  });

  const players = [...groups.values()]
    .map(group => {
      const load = group.records.reduce((sum, record) => sum + numeric(record.load), 0);
      return {
        ...group,
        load,
        weeklyLoad: load,
        loadAverage: weeklyLoadAverage(group.records),
        rpe: average(group.records, "rpe"),
        fatigue: average(group.records, "muscleFatigue"),
        sleep: average(group.records, "sleepHours"),
        trend: loadTrend(group, teamKey, allRecords)
      };
    })
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
      sleep: formatNumber(average(records, "sleepHours")),
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
        sleep: valuesFor(group, dates, record => record.sleepHours),
        load: valuesFor(group, dates, record => record.load).map(value => value === "" ? "" : Math.round(value)),
        weeklyLoad: Math.round(group.weeklyLoad),
        trend: group.trend,
        averages: {
          rpe: formatNumber(group.rpe),
          fatigue: formatNumber(group.fatigue),
          sleep: formatNumber(group.sleep),
          load: formatNumber(group.loadAverage)
        }
      };
    })
  };
}

async function sendPayload(payload){
  if(DRY_RUN){
    const teams = Array.isArray(payload.teams) && payload.teams.length
      ? payload.teams.map(team => `${team.teamKey} ${team.team}`).join(", ")
      : `${payload.teamKey} ${payload.team}`;
    const records = Array.isArray(payload.teams) && payload.teams.length
      ? payload.teams.reduce((sum, team) => sum + Number(team.summary && team.summary.records || 0), 0)
      : Number(payload.summary && payload.summary.records || 0);
    console.log(`[DRY_RUN] S'enviaria RPE ${teams} (${payload.weekLabel}) a ${payload.recipientNames || payload.recipient}. Registres: ${records}`);
    return "dry-run";
  }
  const response = await fetch(RPE_EMAIL_APP_SCRIPT_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  if(!response.ok) throw new Error(`App Script ha retornat ${response.status}: ${text}`);
  let result;
  try {
    result = JSON.parse(text);
  } catch(error) {
    throw new Error(`L'Apps Script ha retornat una resposta no vàlida: ${text.slice(0, 180)}`);
  }
  if(!result || result.ok !== true) throw new Error(result && result.error || "L'Apps Script no ha pogut enviar el correu.");
  return text;
}

function recipientKey(email){
  return String(email || "").trim().toLowerCase().replace(/[.#$\[\]/]/g, "_");
}

function addRecipientPayload(recipientMap, contact, teamPayload){
  const email = RECIPIENT_OVERRIDE || String(contact && contact.email || "").trim();
  if(!isValidEmail(email)) return;
  const key = recipientKey(email);
  if(!recipientMap.has(key)){
    recipientMap.set(key, {
      key,
      email,
      name: RECIPIENT_NAMES_OVERRIDE || contactLabel(contact) || email,
      teams: []
    });
  }
  const recipient = recipientMap.get(key);
  if(!recipient.teams.some(team => team.teamKey === teamPayload.teamKey)){
    recipient.teams.push(teamPayload);
  }
}

async function processTeam({ teamKey, selectedWeek, dates, allRecords, contacts, status, recipientMap }){
  const today = isoFromDate(dateInMadrid());
  const teamStatus = status[teamKey] || {};

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
    const payload = buildPayload({ teamKey, team, selectedWeek, dates, records, allRecords, recipients });
    recipients.contacts.forEach(contact => addRecipientPayload(recipientMap, contact, payload));
    status[teamKey] = {
      ...status[teamKey],
      lastPreparedAt: nowIso(),
      lastPreparedWeek: selectedWeek,
      lastRecipients: recipients.emails,
      lastRecipientNames: recipients.names,
      lastTeam: team,
      lastWeek: selectedWeek,
      lastWeekLabel: payload.weekLabel,
      lastRecords: records.length,
      lastStatus: "prepared",
      lastError: ""
    };
    writeStatus(status);
    console.log(`ERP preparat per ${team} (${payload.weekLabel}) a ${recipients.names.join(", ")}. Registres: ${records.length}`);
    return { teamKey, status: "prepared", records: records.length };
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

async function sendGroupedRecipient({ recipient, selectedWeek, status }){
  const today = isoFromDate(dateInMadrid());
  const weekLabel = recipient.teams[0] && recipient.teams[0].weekLabel || weekRangeLabel(selectedWeek);
  const recipientsStatus = status.__recipients || {};
  const legacyKey = recipient.key.endsWith("_1") ? recipient.key.slice(0, -2) : "";
  const previous = recipientsStatus[recipient.key] || recipientsStatus[legacyKey] || {};
  if(previous.lastSentWeek === selectedWeek && !FORCE_SEND){
    console.log(`Correu ERP ja enviat a ${recipient.name} per la setmana ${selectedWeek}.`);
    return { recipient: recipient.email, status: "already_sent" };
  }
  status.__recipients = {
    ...recipientsStatus,
    [recipient.key]: {
      ...previous,
      lastAttemptDate: today,
      lastAttemptAt: nowIso(),
      lastAttemptWeek: selectedWeek,
      lastStatus: "attempted",
      lastError: ""
    }
  };
  writeStatus(status);

  const payload = {
    type: "rpe_weekly_grouped",
    recipient: RECIPIENT_OVERRIDE || recipient.email,
    recipientNames: RECIPIENT_NAMES_OVERRIDE || recipient.name,
    testMode: true,
    automated: true,
    week: selectedWeek,
    weekLabel,
    teams: recipient.teams
  };

  try {
    const text = await sendPayload(payload);
    const teamKeys = recipient.teams.map(team => team.teamKey);
    status.__recipients[recipient.key] = DRY_RUN
      ? {
        ...status.__recipients[recipient.key],
        lastDryRunAt: nowIso(),
        lastDryRunWeek: selectedWeek,
        lastDryRunTeams: teamKeys,
        lastDryRunRecipient: payload.recipient,
        lastDryRunRecipientName: payload.recipientNames,
        lastWeekLabel: weekLabel,
        lastStatus: "dry_run",
        lastError: ""
      }
      : {
        ...status.__recipients[recipient.key],
        lastSentDate: today,
        lastSentAt: nowIso(),
        lastSentWeek: selectedWeek,
        lastSentTeams: teamKeys,
        lastRecipient: payload.recipient,
        lastRecipientName: payload.recipientNames,
        lastWeekLabel: weekLabel,
        lastStatus: "sent",
        lastError: ""
      };
    recipient.teams.forEach(team => {
      const teamStatus = status[team.teamKey] || {};
      status[team.teamKey] = DRY_RUN
        ? {
          ...teamStatus,
          lastDryRunAt: nowIso(),
          lastDryRunWeek: selectedWeek,
          lastDryRunRecipientNames: [
            ...new Set([...(teamStatus.lastDryRunRecipientNames || []), payload.recipientNames])
          ],
          lastStatus: "dry_run",
          lastError: ""
        }
        : {
          ...teamStatus,
          lastSentDate: today,
          lastSentAt: nowIso(),
          lastSentWeek: selectedWeek,
          lastSentRecipientNames: [
            ...new Set([...(teamStatus.lastSentRecipientNames || []), payload.recipientNames])
          ],
          lastStatus: "sent",
          lastError: ""
        };
    });
    writeStatus(status);
    console.log(`Correu ERP ${DRY_RUN ? "validat" : "demanat"} a ${payload.recipientNames}. Equips: ${teamKeys.join(", ")}.`);
    if(text) console.log(text);
    return { recipient: recipient.email, status: DRY_RUN ? "dry_run" : "sent", teams: teamKeys };
  } catch(error) {
    status.__recipients[recipient.key] = {
      ...status.__recipients[recipient.key],
      lastStatus: "error",
      lastError: String(error && error.message ? error.message : error),
      lastErrorAt: nowIso()
    };
    writeStatus(status);
    console.error(error);
    return { recipient: recipient.email, status: "error", error };
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
  const recipientMap = new Map();

  for(const teamKey of selectedTeamKeys()){
    results.push(await processTeam({ teamKey, selectedWeek, dates, allRecords, contacts, status, recipientMap }));
  }

  const sendResults = [];
  for(const recipient of recipientMap.values()){
    for(let index = 0; index < recipient.teams.length; index += MAX_TEAMS_PER_RECIPIENT_EMAIL){
      const teams = recipient.teams.slice(index, index + MAX_TEAMS_PER_RECIPIENT_EMAIL);
      sendResults.push(await sendGroupedRecipient({
        recipient: { ...recipient, key: `${recipient.key}_${Math.floor(index / MAX_TEAMS_PER_RECIPIENT_EMAIL) + 1}`, teams },
        selectedWeek,
        status
      }));
    }
  }

  const errors = [...results, ...sendResults].filter(result => result.status === "error");
  const sent = sendResults.filter(result => result.status === "sent" || result.status === "dry_run");
  const skipped = results.filter(result => result.status === "skipped_no_data" || result.status === "already_sent");
  console.log(`Resum ERP: enviats=${sent.length}, saltats=${skipped.length}, errors=${errors.length}.`);
  if(errors.length) process.exit(1);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
