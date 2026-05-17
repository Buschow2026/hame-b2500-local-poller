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
const RECEIPT_FILE = "/opt/garagepi/state/hame_worker_receipt.json";
const WORKER = "/opt/garagepi/operational/hame-poll-once.js";

const DEFAULT_RUNS = 3;
const INTER_RUN_DELAY_MS = 70000;

// Rechte-/Startstrategie:
// true  = Worker immer über "sudo -n node ..." starten
// false = Worker direkt starten
//
// EMPFEHLUNG für unbeaufsichtigten Betrieb:
// true + passende sudoers/NOPASSWD-Regeln
const RUN_WORKER_VIA_SUDO = true;

function ts() {
  return new Date().toISOString();
}

function log(...args) {
  console.log(ts(), ...args);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function loadReceipt() {
  return JSON.parse(fs.readFileSync(RECEIPT_FILE, "utf8"));
}

function nextIndex(i) {
  return (i + 1) % DEVICES.length;
}

function buildWorkerCommand(mac) {
  if (RUN_WORKER_VIA_SUDO) {
    return {
      cmd: "sudo",
      args: ["-n", process.execPath, WORKER, mac],
      printable: `sudo -n ${process.execPath} ${WORKER} ${mac}`,
    };
  }

  return {
    cmd: process.execPath,
    args: [WORKER, mac],
    printable: `${process.execPath} ${WORKER} ${mac}`,
  };
}

function normalizeExitCode(result) {
  if (typeof result.status === "number") {
    return result.status;
  }

  if (result.error) {
    return 999;
  }

  return 998;
}

async function main() {
  const runsRequested = Number(process.argv[2] || DEFAULT_RUNS);
  const runs =
    Number.isFinite(runsRequested) && runsRequested > 0
      ? Math.floor(runsRequested)
      : DEFAULT_RUNS;

  const state = loadState();

  log(
    "[BATCH] start",
    `runs=${runs}`,
    `start_index=${state.index || 0}`,
    `delay_ms=${INTER_RUN_DELAY_MS}`,
    `via_sudo=${RUN_WORKER_VIA_SUDO}`
  );

  for (let i = 0; i < runs; i += 1) {
    const idx = Number.isInteger(state.index) ? state.index : 0;
    const mac = DEVICES[idx];

    const workerCmd = buildWorkerCommand(mac);

    log(
      "[BATCH] run",
      `seq=${i + 1}/${runs}`,
      `mac=${mac}`,
      `index=${idx}`,
      `cmd=${workerCmd.printable}`
    );

    const result = spawnSync(workerCmd.cmd, workerCmd.args, {
      stdio: "inherit",
    });

    let receipt = null;
    let receiptOk = false;
    let receiptError = null;

    try {
      receipt = loadReceipt();
      receiptOk = !!receipt.done && receipt.mac === mac;
    } catch (err) {
      receiptError = String(err && err.message ? err.message : err);
    }

    const exitCode = normalizeExitCode(result);
    const workerSuccess =
      receipt && typeof receipt.success === "boolean" ? receipt.success : false;

    state.last_mac = mac;
    state.last_ts = new Date().toISOString();
    state.last_exit_code = exitCode;
    state.last_status = receiptOk && workerSuccess === true ? "success" : "error";
    state.last_receipt_ok = receiptOk;
    state.last_receipt_error = receiptError;
    state.last_worker_success = workerSuccess;
    state.last_cmd = workerCmd.printable;
    state.index = nextIndex(idx);

    if (result.error) {
      state.last_spawn_error = String(
        result.error && result.error.message ? result.error.message : result.error
      );
    } else {
      state.last_spawn_error = null;
    }

    saveState(state);

    log(
      "[BATCH] result",
      `seq=${i + 1}/${runs}`,
      `mac=${mac}`,
      `exit_code=${exitCode}`,
      `receipt_ok=${receiptOk}`,
      `worker_success=${workerSuccess}`
    );

    if (result.error) {
      log(
        "[BATCH] spawn_error",
        String(result.error && result.error.message ? result.error.message : result.error)
      );
    }

    if (i < runs - 1) {
      log(
        "[BATCH] sleep",
        `delay_ms=${INTER_RUN_DELAY_MS}`,
        `next_mac=${DEVICES[state.index]}`
      );
      await sleep(INTER_RUN_DELAY_MS);
    }
  }

  log("[BATCH] finished");
}

main().catch((err) => {
  console.error(
    ts(),
    "[FATAL]",
    String(err && err.message ? err.message : err)
  );
  process.exit(1);
});
