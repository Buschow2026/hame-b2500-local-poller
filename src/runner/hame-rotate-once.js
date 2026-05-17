#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const DEVICES = [
  "AA:BB:CC:DD:EE:01", // S04
  "AA:BB:CC:DD:EE:02", // S05
  "AA:BB:CC:DD:EE:03", // S06
];

const STATE_FILE = "/opt/garagepi/state/rotate_state.json";
const WORKER = "/opt/garagepi/runner/hame-poll-once.js";

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { index: 0 };
  }
}

function saveState(state) {
  ensureDir(path.dirname(STATE_FILE));
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function nextIndex(i) {
  return (i + 1) % DEVICES.length;
}

function main() {
  const state = loadState();
  const idx = Number.isInteger(state.index) ? state.index : 0;

  const mac = DEVICES[idx];

  console.log("RUN:", mac);

  const result = spawnSync(process.execPath, [WORKER, mac], {
    stdio: "inherit",
  });

  state.last_mac = mac;
  state.last_ts = new Date().toISOString();
  state.last_exit_code = result.status;
  state.last_status = result.status === 0 ? "success" : "error";
  state.index = nextIndex(idx);

  saveState(state);

  process.exit(result.status === null ? 1 : result.status);
}

main();
