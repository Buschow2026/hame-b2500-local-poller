#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { parseRuntimeFrame } = require("./hame-parser.js");

const INBOX_FILE = "/opt/garagepi/state/hame_protocol.jsonl";
const ARCHIVE_DIR = "/opt/garagepi/state/archive";
const ARCHIVE_FILE = path.join(ARCHIVE_DIR, "hame_protocol_done.jsonl");
const ERROR_FILE = path.join(ARCHIVE_DIR, "hame_protocol_error.jsonl");
const LOCK_FILE = "/opt/garagepi/state/locks/hame-runtime-export.lock";

const MAX_ARCHIVE_LINES = 2000;
const MAX_ERROR_LINES = 1000;

const MQTT_HOST = "192.168.1.100";
const MQTT_PORT = "1883";
const MQTT_QOS = "0";
const MQTT_RETAIN = false;

const MQTT_CREDENTIALS = {
  batt1: { username: "hame111", password: "a" },
  batt2: { username: "hame112", password: "a" },
  batt3: { username: "hame113", password: "a" }
};

function ts() {
  return new Date().toISOString();
}

function log(...args) {
  console.log(ts(), ...args);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function normMac(mac) {
  return String(mac || "").toLowerCase().replace(/-/g, ":");
}

function slotToUser(slot) {
  if (slot === "S04") return "batt1";
  if (slot === "S05") return "batt2";
  if (slot === "S06") return "batt3";
  return "batt_unknown";
}

function macToDev4(mac) {
  const clean = normMac(mac).replace(/:/g, "");
  if (clean.length < 4) return "unknown";
  return clean.slice(-4);
}

function buildContextFromRecord(record) {
  const slot = record.device || "UNKNOWN";
  const mac = normMac(record.mac || "");
  return {
    slot,
    mac,
    dev4: macToDev4(mac),
    user: slotToUser(slot)
  };
}

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.trim()) return [];
  return raw.split("\n").filter(Boolean);
}

function writeLinesAtomic(file, lines) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  const content = lines.length > 0 ? lines.join("\n") + "\n" : "";
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, file);
}

function appendLine(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + "\n", "utf8");
}

function trimFileToLastNLines(file, maxLines) {
  const lines = readLines(file);
  if (lines.length <= maxLines) return;
  const trimmed = lines.slice(-maxLines);
  writeLinesAtomic(file, trimmed);
}

function getMqttCredentials(user) {
  const creds = MQTT_CREDENTIALS[user] || null;
  if (!creds || !creds.username || !creds.password) {
    throw new Error(`missing mqtt credentials for user=${user}`);
  }
  return creds;
}

function publishMqtt(topic, payloadObj, user) {
  const payload = JSON.stringify(payloadObj);
  const creds = getMqttCredentials(user);

  const args = [
    "-h", MQTT_HOST,
    "-p", String(MQTT_PORT),
    "-q", String(MQTT_QOS),
    "-t", topic,
    "-m", payload,
    "-u", creds.username,
    "-P", creds.password
  ];

  if (MQTT_RETAIN) {
    args.push("-r");
  }

  log("[MQTT] publish", topic, `user=${creds.username}`);
  execFileSync("mosquitto_pub", args, { stdio: "inherit" });
}

function getResponsePayload(record) {
  if (record && typeof record.response_payload === "string" && record.response_payload.trim()) {
    return record.response_payload.trim();
  }

  if (record && typeof record.payload === "string" && record.payload.trim()) {
    return record.payload.trim();
  }

  return null;
}

function getRequestPayload(record) {
  if (record && typeof record.request_payload === "string" && record.request_payload.trim()) {
    return record.request_payload.trim();
  }

  return null;
}

function buildOperationalPayload(record, parsed, ctx, responsePayload) {
  const r = parsed && parsed.runtime_info ? parsed.runtime_info : {};
  const s = parsed && parsed.decoded_summary ? parsed.decoded_summary : {};

  return {
    ts: ts(),

    user: ctx.user,
    slot: ctx.slot,
    dev4: ctx.dev4,
    mac: ctx.mac,

    source_timestamp: record.timestamp || null,
    request_payload: getRequestPayload(record),
    response_payload: responsePayload,

    soc_x10_pct: r.soc_x10_pct ?? null,
    soc_pct: r.soc_pct ?? s.soc_pct ?? null,
    dod_pct: r.dod_pct ?? null,
    remaining_capacity_wh: r.remainingCapacity_wh ?? s.remaining_capacity_wh ?? null,

    pv_in1_w: r.in1Power_w ?? null,
    pv_in2_w: r.in2Power_w ?? null,
    pv_total_w:
      s.pv_total_w ?? null,

    out1_w: r.out1Power_w ?? null,
    out2_w: r.out2Power_w ?? null,
    batt_out_total_w: s.batt_out_total_w ?? null,

    temp_low_c: r.temperatureLow_c ?? s.temp_low_c ?? null,
    temp_high_c: r.temperatureHigh_c ?? s.temp_high_c ?? null,

    wifi_connected: r.wifiMqttState ? r.wifiMqttState.wifiConnected : null,
    mqtt_connected: r.wifiMqttState ? r.wifiMqttState.mqttConnected : null,

    daily_batt_charge_wh: r.dailyTotalBatteryCharge_Wh ?? null,
    daily_batt_discharge_wh: r.dailyTotalBatteryDischarge_Wh ?? null,
    daily_load_charge_wh: r.dailyTotalLoadCharge_Wh ?? null,
    daily_load_discharge_wh: r.dailyTotalLoadDischarge_Wh ?? null,

    charge_load_first: r.chargeMode ? r.chargeMode.loadFirst : null,
    discharge_out1_enable: r.dischargeSetting ? r.dischargeSetting.out1Enable : null,
    discharge_out2_enable: r.dischargeSetting ? r.dischargeSetting.out2Enable : null,

    out1_active: r.out1Active ?? null,
    out2_active: r.out2Active ?? null,

    time_hour: r.time ? r.time.hour : null,
    time_minute: r.time ? r.time.minute : null,

    dev_version: r.devVersion ?? null,
    dev_sub_version: r.deviceSubVersion ?? null,
    device_scene: r.deviceScene ?? null,
    device_region: r.deviceRegion ?? null,

    protocol_length_field: parsed && parsed.header ? parsed.header.protocol_length_field : null,
    identifier_byte: parsed && parsed.header ? parsed.header.identifier_byte : null,
    command: parsed && parsed.header ? parsed.header.command : null,

    checksum_candidate_expected:
      parsed && parsed.header ? parsed.header.checksum_candidate_expected : null,
    checksum_candidate_calculated:
      parsed && parsed.header ? parsed.header.checksum_candidate_calculated : null
  };
}

function lockOrExit() {
  ensureDir(path.dirname(LOCK_FILE));
  try {
    const fd = fs.openSync(LOCK_FILE, "wx");
    fs.writeFileSync(fd, String(process.pid), "utf8");
    return fd;
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error(ts(), "[LOCK] failed", msg);
    process.exit(1);
  }
}

function unlock(fd) {
  try {
    if (fd != null) fs.closeSync(fd);
  } catch (_) {}
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch (_) {}
}

function main() {
  ensureDir(ARCHIVE_DIR);

  const lockFd = lockOrExit();

  try {
    const lines = readLines(INBOX_FILE);

    if (lines.length === 0) {
      log("[QUEUE] empty");
      return;
    }

    const firstLine = lines[0];
    const restLines = lines.slice(1);

    let record;
    try {
      record = JSON.parse(firstLine);
    } catch (err) {
      appendLine(ERROR_FILE, {
        ts: ts(),
        error: "json_parse_failed",
        detail: String(err && err.message ? err.message : err),
        raw_line: firstLine
      });
      trimFileToLastNLines(ERROR_FILE, MAX_ERROR_LINES);
      writeLinesAtomic(INBOX_FILE, restLines);
      log("[QUEUE] dropped invalid json line to error archive");
      return;
    }

    const responsePayload = getResponsePayload(record);

    if (!record || record.success !== true || !responsePayload) {
      appendLine(ERROR_FILE, {
        ts: ts(),
        error: "invalid_record_for_export",
        record
      });
      trimFileToLastNLines(ERROR_FILE, MAX_ERROR_LINES);
      writeLinesAtomic(INBOX_FILE, restLines);
      log("[QUEUE] dropped invalid record to error archive");
      return;
    }

    const ctx = buildContextFromRecord(record);
    const parsed = parseRuntimeFrame(responsePayload, {
      slot: ctx.slot,
      mac: ctx.mac
    });

    const operational = buildOperationalPayload(record, parsed, ctx, responsePayload);

    publishMqtt(`garagepi/hame/${ctx.user}/runtime_raw`, {
      ts: ts(),
      user: ctx.user,
      slot: ctx.slot,
      dev4: ctx.dev4,
      mac: ctx.mac,
      request_payload: getRequestPayload(record),
      response_payload: responsePayload
    }, ctx.user);

    publishMqtt(`garagepi/hame/${ctx.user}/runtime_decoded`, {
      ts: ts(),
      user: ctx.user,
      slot: ctx.slot,
      dev4: ctx.dev4,
      mac: ctx.mac,
      parsed
    }, ctx.user);

    publishMqtt(`garagepi/hame/${ctx.user}/runtime`, operational, ctx.user);

    appendLine(ARCHIVE_FILE, {
      archived_at: ts(),
      record,
      parsed_summary: parsed.decoded_summary || null,
      identity: parsed.identity || ctx
    });

    trimFileToLastNLines(ARCHIVE_FILE, MAX_ARCHIVE_LINES);

    writeLinesAtomic(INBOX_FILE, restLines);

    log("[DONE] exported and archived", ctx.user, ctx.slot, ctx.dev4);
  } finally {
    unlock(lockFd);
  }
}

main();
