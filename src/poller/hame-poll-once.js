#!/usr/bin/env node

const noble = require("@abandonware/noble");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const RUNTIME_COMMAND_HEX = "7305230356";

const PROTOCOL_FILE = "/opt/garagepi/state/hame_protocol.jsonl";
const RECEIPT_FILE = "/opt/garagepi/state/hame_worker_receipt.json";

const DEFAULT_POWERON_TIMEOUT_MS = 15000;
const DEFAULT_SCAN_TIMEOUT_MS = 15000;
const DEFAULT_CONNECT_TIMEOUT_MS = 45000;
const DEFAULT_DISCOVER_TIMEOUT_MS = 45000;
const DEFAULT_SUBSCRIBE_TIMEOUT_MS = 12000;
const DEFAULT_WRITE_TIMEOUT_MS = 12000;
const DEFAULT_NOTIFY_WAIT_MS = 5000;
const DEFAULT_UNSUBSCRIBE_TIMEOUT_MS = 5000;
const DEFAULT_DISCONNECT_TIMEOUT_MS = 8000;

const POST_SCAN_SETTLE_MS = 200;
const POST_CONNECT_SETTLE_MS = 400;

const TEASE_INTERVAL_MS = 250;
const MAX_TEASES = 3;

const BLE_DOWN_PAUSE_MS = 1500;
const BLE_UP_PAUSE_MS = 2500;
const HCI_READY_TIMEOUT_MS = 10000;
const EXISTING_CONNECTING_WAIT_MS = 3000;
const MAX_ATTEMPTS = 2;

const PREFERRED_HCI_DEV = process.env.GARAGEPI_HCI_DEV || "";

const DEVICE_MAP = {
  "AA:BB:CC:DD:EE:01": "S04",
  "AA:BB:CC:DD:EE:02": "S05",
  "AA:BB:CC:DD:EE:03": "S06",
};

function ts() {
  return new Date().toISOString();
}

function log(...args) {
  console.log(ts(), ...args);
}

function normMac(mac) {
  return String(mac || "").toLowerCase().replace(/-/g, ":");
}

function bufferToHex(buf) {
  return Buffer.from(buf).toString("hex");
}

function hexToBuffer(hex) {
  return Buffer.from(hex, "hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeJsonAtomic(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

function appendJsonLine(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(obj) + "\n", "utf8");
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout: ${label} after ${ms} ms`));
    }, ms);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function runCmd(cmd, args) {
  log("[CMD]", cmd, args.join(" "));
  execFileSync(cmd, args, { stdio: "inherit" });
}

function runCmdIgnore(cmd, args, label) {
  try {
    log("[CMD]", cmd, args.join(" "));
    execFileSync(cmd, args, { stdio: "inherit" });
  } catch (err) {
    log("[CMD-IGNORE]", label, String(err && err.message ? err.message : err));
  }
}

function getHciInfo() {
  try {
    return execFileSync("hciconfig", ["-a"], { encoding: "utf8" });
  } catch (err) {
    return "";
  }
}

function parseHciBlocks(text) {
  if (!text) return [];

  const lines = text.split("\n");
  const blocks = [];
  let current = null;

  for (const line of lines) {
    const headerMatch = line.match(/^(hci\d+):\s+(.*)$/);
    if (headerMatch) {
      if (current) blocks.push(current);
      current = {
        dev: headerMatch[1],
        header: line,
        lines: [line],
      };
      continue;
    }

    if (current) {
      current.lines.push(line);
    }
  }

  if (current) blocks.push(current);

  return blocks.map((block) => {
    const textBlock = block.lines.join("\n");
    const busMatch = textBlock.match(/Bus:\s*([A-Za-z0-9_-]+)/i);
    const manufacturerMatch = textBlock.match(/Manufacturer:\s*(.+)$/im);
    const macMatch = textBlock.match(/BD Address:\s*([0-9A-F:]+)/i);
    const hasUpRunning = textBlock.includes("UP RUNNING");

    return {
      dev: block.dev,
      text: textBlock,
      bus: busMatch ? String(busMatch[1]).toUpperCase() : "",
      manufacturer: manufacturerMatch ? manufacturerMatch[1].trim() : "",
      mac: macMatch ? macMatch[1].toLowerCase() : "",
      hasUpRunning,
    };
  });
}

function getHciBlock(text, hciDev) {
  const blocks = parseHciBlocks(text);
  const found = blocks.find((b) => b.dev === hciDev);
  return found ? found.text : "";
}

function isHciReady(text, hciDev) {
  const blocks = parseHciBlocks(text);
  const found = blocks.find((b) => b.dev === hciDev);
  if (!found) return false;

  const validMac = found.mac && found.mac !== "00:00:00:00:00:00";
  return found.hasUpRunning && validMac;
}

function detectBestHci() {
  const info = getHciInfo();
  const blocks = parseHciBlocks(info);

  if (!blocks.length) {
    throw new Error("no hci adapters found");
  }

  if (PREFERRED_HCI_DEV) {
    const preferred = blocks.find((b) => b.dev === PREFERRED_HCI_DEV);
    if (!preferred) {
      throw new Error(`preferred adapter ${PREFERRED_HCI_DEV} not found`);
    }
    log(
      "[HCI-DETECT]",
      `selected=${preferred.dev}`,
      `reason=env`,
      `bus=${preferred.bus || "-"}`,
      `manufacturer=${preferred.manufacturer || "-"}`
    );
    return preferred.dev;
  }

  const usbRealtek = blocks.find(
    (b) =>
      b.bus === "USB" &&
      /realtek/i.test(b.manufacturer || "")
  );
  if (usbRealtek) {
    log(
      "[HCI-DETECT]",
      `selected=${usbRealtek.dev}`,
      `reason=usb_realtek`,
      `bus=${usbRealtek.bus || "-"}`,
      `manufacturer=${usbRealtek.manufacturer || "-"}`
    );
    return usbRealtek.dev;
  }

  const anyUsb = blocks.find((b) => b.bus === "USB");
  if (anyUsb) {
    log(
      "[HCI-DETECT]",
      `selected=${anyUsb.dev}`,
      `reason=usb_fallback`,
      `bus=${anyUsb.bus || "-"}`,
      `manufacturer=${anyUsb.manufacturer || "-"}`
    );
    return anyUsb.dev;
  }

  const first = blocks[0];
  log(
    "[HCI-DETECT]",
    `selected=${first.dev}`,
    `reason=first_fallback`,
    `bus=${first.bus || "-"}`,
    `manufacturer=${first.manufacturer || "-"}`
  );
  return first.dev;
}

async function waitForHciReady(hciDev, timeoutMs = HCI_READY_TIMEOUT_MS) {
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const info = getHciInfo();
    const block = getHciBlock(info, hciDev);
    const firstLine = (block.split("\n")[0] || `<${hciDev}-missing>`).trim();

    log("[HCI] probe", firstLine);

    if (isHciReady(info, hciDev)) {
      log("[HCI] ready", hciDev);
      return;
    }

    await sleep(250);
  }

  throw new Error(`${hciDev} not ready within ${timeoutMs} ms`);
}

async function hardResetNobleState() {
  log("[NOBLE] hard reset start");

  try {
    noble.removeAllListeners("discover");
    log("[NOBLE] removed discover listeners");
  } catch (err) {
    log("[NOBLE] remove discover listeners ignore", String(err && err.message ? err.message : err));
  }

  try {
    log("[NOBLE] stopScanningAsync skipped in hard reset");
  } catch (err) {
    log("[NOBLE] stopScanningAsync skip ignore", String(err && err.message ? err.message : err));
  }

  try {
    if (noble._discoveredPeripheralUUIDs) {
      for (const k of Object.keys(noble._discoveredPeripheralUUIDs)) {
        delete noble._discoveredPeripheralUUIDs[k];
      }
      log("[NOBLE] cleared _discoveredPeripheralUUIDs");
    }
  } catch (err) {
    log("[NOBLE] clear _discoveredPeripheralUUIDs ignore", String(err && err.message ? err.message : err));
  }

  try {
    if (noble._peripherals) {
      for (const k of Object.keys(noble._peripherals)) {
        delete noble._peripherals[k];
      }
      log("[NOBLE] cleared _peripherals");
    }
  } catch (err) {
    log("[NOBLE] clear _peripherals ignore", String(err && err.message ? err.message : err));
  }

  log("[NOBLE] hard reset done");
}

async function recycleBleStack(hciDev) {
  log("[BLE] recycle start", `adapter=${hciDev}`);

  await hardResetNobleState();

  runCmdIgnore("systemctl", ["stop", "bluetooth"], "stop bluetooth");
  runCmdIgnore("rfkill", ["unblock", "bluetooth"], "rfkill unblock #1");
  runCmdIgnore("hciconfig", [hciDev, "down"], `hciconfig ${hciDev} down`);

  await sleep(BLE_DOWN_PAUSE_MS);

  runCmdIgnore("rfkill", ["unblock", "bluetooth"], "rfkill unblock #2");
  runCmdIgnore("hciconfig", [hciDev, "reset"], `hciconfig ${hciDev} reset`);

  await sleep(1000);

  runCmd("hciconfig", [hciDev, "up"]);

  await sleep(BLE_UP_PAUSE_MS);
  await waitForHciReady(hciDev, HCI_READY_TIMEOUT_MS);
  await hardResetNobleState();

  log("[BLE] recycle done", `adapter=${hciDev}`);
}

async function waitForPoweredOn(timeoutMs = DEFAULT_POWERON_TIMEOUT_MS) {
  if (noble.state === "poweredOn") {
    log("[ADAPTER] already poweredOn");
    return;
  }

  log("[ADAPTER] waitForPoweredOn enter", noble.state);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      noble.removeListener("stateChange", onStateChange);
      reject(new Error(`adapter not poweredOn within ${timeoutMs} ms`));
    }, timeoutMs);

    const onStateChange = (state) => {
      log("[ADAPTER] stateChange", state);
      if (state === "poweredOn") {
        clearTimeout(timer);
        noble.removeListener("stateChange", onStateChange);
        resolve();
      }
    };

    noble.on("stateChange", onStateChange);
  });

  log("[ADAPTER] waitForPoweredOn done");
}

async function stopScan() {
  log("[SCAN] stop enter");
  try {
    await noble.stopScanningAsync();
    log("[SCAN] stop done");
  } catch (err) {
    log("[SCAN] stop ignore", String(err && err.message ? err.message : err));
  }
}

async function findDevice(mac, scanTimeoutMs = DEFAULT_SCAN_TIMEOUT_MS) {
  const wanted = normMac(mac);

  log("[SCAN] find enter", wanted, `timeout=${scanTimeoutMs}`);

  return new Promise((resolve, reject) => {
    let finished = false;

    const finishResolve = async (peripheral, reason) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      noble.removeListener("discover", onDiscover);
      await stopScan();
      log("[SCAN] resolve", reason, normMac(peripheral.address));
      resolve(peripheral);
    };

    const finishReject = async (err, reason) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      noble.removeListener("discover", onDiscover);
      await stopScan();
      log("[SCAN] reject", reason, String(err && err.message ? err.message : err));
      reject(err);
    };

    const timer = setTimeout(async () => {
      await finishReject(new Error(`scan timeout for ${wanted}`), "timeout");
    }, scanTimeoutMs);

    const onDiscover = async (peripheral) => {
      try {
        const addr = normMac(peripheral.address);
        const localName =
          peripheral &&
          peripheral.advertisement &&
          peripheral.advertisement.localName
            ? peripheral.advertisement.localName
            : "-";

        log("[SCAN]", addr, `rssi=${peripheral.rssi}`, `localName=${localName}`);

        if (addr === wanted) {
          await finishResolve(peripheral, "target_match");
        }
      } catch (err) {
        await finishReject(err, "discover_handler");
      }
    };

    noble.on("discover", onDiscover);

    noble
      .startScanningAsync([], false)
      .then(() => {
        log("[SCAN] start done");
      })
      .catch(async (err) => {
        await finishReject(err, "startScanningAsync");
      });
  });
}

function makeReceiptBase(mac, deviceName, attemptNo, phase, hciDev) {
  return {
    timestamp: ts(),
    mac,
    device: deviceName,
    attempt: attemptNo,
    done: false,
    success: false,
    phase,
    mode: "pull",
    request_payload: RUNTIME_COMMAND_HEX,
    response_payload: null,
    error: null,
    hci_dev: hciDev,
  };
}

async function handleConnectingPrecheck(peripheral, targetAddr) {
  const state = peripheral ? peripheral.state : "none";
  log("[CONNECT] precheck", `state=${state}`);

  if (!peripheral) {
    throw new Error(`no peripheral for ${targetAddr}`);
  }

  if (state === "connecting") {
    log("[CONNECT] wait existing connecting");
    await withTimeout(
      new Promise((resolve) => {
        const started = Date.now();
        const poll = async () => {
          if (peripheral.state !== "connecting") {
            resolve();
            return;
          }
          if (Date.now() - started >= EXISTING_CONNECTING_WAIT_MS) {
            resolve();
            return;
          }
          await sleep(100);
          poll();
        };
        poll();
      }),
      EXISTING_CONNECTING_WAIT_MS,
      `wait existing connecting ${targetAddr}`
    );

    if (peripheral.state === "connecting") {
      throw new Error(`poisoned peripheral state=connecting ${targetAddr}`);
    }
  }

  if (peripheral.state === "connected") {
    log("[CONNECT] already connected");
    return;
  }

  if (peripheral.state !== "disconnected") {
    throw new Error(`unexpected peripheral state=${peripheral.state} ${targetAddr}`);
  }
}

async function teaseUntilNotify(writeChar, getGotData, targetAddr) {
  const payload = hexToBuffer(RUNTIME_COMMAND_HEX);

  for (let i = 1; i <= MAX_TEASES; i += 1) {
    log(`[TEASE] ${i}/${MAX_TEASES} write`);
    await withTimeout(
      writeChar.writeAsync(payload, true),
      DEFAULT_WRITE_TIMEOUT_MS,
      `tease write ${i} ${targetAddr}`
    );
    log(`[TEASE] ${i}/${MAX_TEASES} write done`);

    const started = Date.now();
    while (Date.now() - started < TEASE_INTERVAL_MS) {
      if (getGotData()) {
        log("[SUCCESS]", `tease=${i}`);
        return i;
      }
      await sleep(25);
    }

    if (getGotData()) {
      log("[SUCCESS]", `tease=${i}`);
      return i;
    }

    log(`[TEASE] ${i}/${MAX_TEASES} no reaction after ${TEASE_INTERVAL_MS}ms`);
  }

  throw new Error("no data after tease loop");
}

async function runAttempt(mac, deviceName, attemptNo, hciDev) {
  let peripheral = null;
  let notifyChar = null;
  let onData = null;

  let responsePayload = null;
  let disconnectEvents = 0;
  let targetAddr = mac;

  writeJsonAtomic(
    RECEIPT_FILE,
    makeReceiptBase(mac, deviceName, attemptNo, "worker_recycle_ble", hciDev)
  );

  await recycleBleStack(hciDev);

  writeJsonAtomic(
    RECEIPT_FILE,
    makeReceiptBase(mac, deviceName, attemptNo, "wait_powered_on", hciDev)
  );

  await waitForPoweredOn();

  writeJsonAtomic(
    RECEIPT_FILE,
    makeReceiptBase(mac, deviceName, attemptNo, "scan", hciDev)
  );

  peripheral = await findDevice(mac, DEFAULT_SCAN_TIMEOUT_MS);
  targetAddr = normMac(peripheral.address);

  const localName =
    peripheral &&
    peripheral.advertisement &&
    peripheral.advertisement.localName
      ? peripheral.advertisement.localName
      : "-";

  log(
    "[TARGET] found",
    targetAddr,
    `rssi=${peripheral.rssi}`,
    `localName=${localName}`,
    `state=${peripheral.state}`
  );

  log("[SETTLE]", `post_scan ${POST_SCAN_SETTLE_MS}ms`);
  await sleep(POST_SCAN_SETTLE_MS);

  peripheral.on("disconnect", (error) => {
    disconnectEvents += 1;
    log(
      "[PERIPHERAL] disconnect",
      `count=${disconnectEvents}`,
      `addr=${targetAddr}`,
      `state=${peripheral.state}`,
      `error=${String(error && error.message ? error.message : error || "-")}`
    );
  });

  writeJsonAtomic(
    RECEIPT_FILE,
    makeReceiptBase(mac, deviceName, attemptNo, "connect", hciDev)
  );

  await handleConnectingPrecheck(peripheral, targetAddr);

  log("[CONNECT]");
  await withTimeout(
    peripheral.connectAsync(),
    DEFAULT_CONNECT_TIMEOUT_MS,
    `connect ${targetAddr}`
  );
  log("[CONNECT] done", `state=${peripheral.state}`);

  log("[SETTLE]", `post_connect ${POST_CONNECT_SETTLE_MS}ms`);
  await sleep(POST_CONNECT_SETTLE_MS);

  writeJsonAtomic(
    RECEIPT_FILE,
    makeReceiptBase(mac, deviceName, attemptNo, "discover", hciDev)
  );

  log("[DISCOVER]");
  const result = await withTimeout(
    peripheral.discoverAllServicesAndCharacteristicsAsync(),
    DEFAULT_DISCOVER_TIMEOUT_MS,
    `discoverAllServicesAndCharacteristics ${targetAddr}`
  );

  const services = (result && result.services) || [];
  const characteristics = (result && result.characteristics) || [];

  log("[DISCOVER] done", `services=${services.length}`, `chars=${characteristics.length}`);

  for (const svc of services) {
    log("[DISCOVER] service", String(svc.uuid || "").toLowerCase());
  }

  for (const ch of characteristics) {
    const props = Array.isArray(ch.properties) ? ch.properties.join(",") : "";
    log("[DISCOVER] char", String(ch.uuid || "").toLowerCase(), `properties=${props}`);
  }

  const writeChar = characteristics.find(
    (c) => String(c.uuid || "").toLowerCase().includes("ff01")
  );
  notifyChar = characteristics.find(
    (c) => String(c.uuid || "").toLowerCase().includes("ff02")
  );

  if (!writeChar || !notifyChar) {
    throw new Error("ff01/ff02 not found");
  }

  let gotData = false;

  onData = (data) => {
    responsePayload = bufferToHex(data);
    gotData = true;
    log("[NOTIFY]", responsePayload);
  };

  notifyChar.on("data", onData);

  try {
    writeJsonAtomic(
      RECEIPT_FILE,
      makeReceiptBase(mac, deviceName, attemptNo, "subscribe", hciDev)
    );

    log("[SUBSCRIBE]");
    await withTimeout(
      notifyChar.subscribeAsync(),
      DEFAULT_SUBSCRIBE_TIMEOUT_MS,
      `subscribe ${targetAddr}`
    );
    log("[SUBSCRIBE] done");

    writeJsonAtomic(
      RECEIPT_FILE,
      makeReceiptBase(mac, deviceName, attemptNo, "tease_loop", hciDev)
    );

    await teaseUntilNotify(writeChar, () => gotData, targetAddr);

    return {
      success: true,
      responsePayload,
      peripheral,
      notifyChar,
      onData,
      disconnectEvents,
      targetAddr,
      hciDev,
    };
  } catch (err) {
    throw {
      original: err,
      responsePayload,
      peripheral,
      notifyChar,
      onData,
      disconnectEvents,
      targetAddr,
      hciDev,
    };
  }
}

async function cleanupAttempt(ctx) {
  const peripheral = ctx && ctx.peripheral ? ctx.peripheral : null;
  const notifyChar = ctx && ctx.notifyChar ? ctx.notifyChar : null;
  const onData = ctx && ctx.onData ? ctx.onData : null;
  const targetAddr = ctx && ctx.targetAddr ? ctx.targetAddr : "unknown";

  try {
    if (notifyChar && onData) {
      notifyChar.removeListener("data", onData);
    }
  } catch (err) {
    log("[LISTENER] ignore", String(err && err.message ? err.message : err));
  }

  try {
    if (notifyChar && peripheral && peripheral.state === "connected") {
      log("[UNSUBSCRIBE]");
      await withTimeout(
        notifyChar.unsubscribeAsync(),
        DEFAULT_UNSUBSCRIBE_TIMEOUT_MS,
        `unsubscribe ${targetAddr}`
      );
      log("[UNSUBSCRIBE] done");
    } else {
      log(
        "[UNSUBSCRIBE] skip",
        `peripheral_state=${peripheral ? peripheral.state : "none"}`
      );
    }
  } catch (err) {
    log("[UNSUBSCRIBE] ignore", String(err && err.message ? err.message : err));
  }

  try {
    await stopScan();
  } catch (err) {
    log("[SCAN] final ignore", String(err && err.message ? err.message : err));
  }

  try {
    if (peripheral) {
      log("[DISCONNECT] enter", `state=${peripheral.state}`);
      if (peripheral.state === "connected" || peripheral.state === "connecting") {
        await withTimeout(
          peripheral.disconnectAsync(),
          DEFAULT_DISCONNECT_TIMEOUT_MS,
          `disconnect ${targetAddr}`
        );
      }
      log("[DISCONNECT] done", `state=${peripheral.state}`);
    }
  } catch (err) {
    log("[DISCONNECT] ignore", String(err && err.message ? err.message : err));
  }

  await hardResetNobleState();
}

async function main() {
  const startedAtMs = Date.now();
  const mac = normMac(process.argv[2]);
  const deviceName = DEVICE_MAP[mac] || "UNKNOWN";

  if (!mac) {
    console.error("NO MAC");
    process.exit(2);
  }

  let hciDev;
  try {
    hciDev = detectBestHci();
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    console.error(ts(), "[FATAL]", msg);
    writeJsonAtomic(RECEIPT_FILE, {
      timestamp: ts(),
      mac,
      device: deviceName,
      attempt: 0,
      done: true,
      success: false,
      phase: "detect_hci",
      mode: "pull",
      request_payload: RUNTIME_COMMAND_HEX,
      response_payload: null,
      error: msg,
      duration_ms: 0,
      disconnect_events: 0,
      peripheral_state: "none",
      hci_dev: null,
    });
    process.exit(1);
  }

  noble.on("warning", (msg) => {
    log("[WARNING]", msg);
  });

  noble.on("scanStart", () => {
    log("[SCAN] event scanStart");
  });

  noble.on("scanStop", () => {
    log("[SCAN] event scanStop");
  });

  let success = false;
  let errorText = null;
  let responsePayload = null;
  let attemptsUsed = 0;
  let lastDisconnectEvents = 0;
  let lastPeripheralState = "none";

  writeJsonAtomic(
    RECEIPT_FILE,
    makeReceiptBase(mac, deviceName, 0, "boot", hciDev)
  );

  log("[BOOT] poll-once", mac, `adapter=${hciDev}`);

  for (let attemptNo = 1; attemptNo <= MAX_ATTEMPTS; attemptNo += 1) {
    attemptsUsed = attemptNo;
    log("[ATTEMPT] start", `${attemptNo}/${MAX_ATTEMPTS}`);

    let ctx = null;

    try {
      ctx = await runAttempt(mac, deviceName, attemptNo, hciDev);

      success = true;
      responsePayload = ctx.responsePayload;
      lastDisconnectEvents = ctx.disconnectEvents;
      lastPeripheralState =
        ctx && ctx.peripheral ? ctx.peripheral.state : "none";

      await cleanupAttempt(ctx);
      break;
    } catch (wrappedErr) {
      const err = wrappedErr && wrappedErr.original ? wrappedErr.original : wrappedErr;

      errorText = String(err && err.message ? err.message : err);
      responsePayload =
        wrappedErr && Object.prototype.hasOwnProperty.call(wrappedErr, "responsePayload")
          ? wrappedErr.responsePayload
          : responsePayload;

      lastDisconnectEvents =
        wrappedErr && typeof wrappedErr.disconnectEvents === "number"
          ? wrappedErr.disconnectEvents
          : lastDisconnectEvents;

      lastPeripheralState =
        wrappedErr && wrappedErr.peripheral
          ? wrappedErr.peripheral.state
          : lastPeripheralState;

      log("[ERROR]", errorText, `attempt=${attemptNo}`);

      await cleanupAttempt(wrappedErr);

      if (attemptNo < MAX_ATTEMPTS) {
        log("[SECOND-CHANCE] retry from worker line 1");
        continue;
      }
    }
  }

  if (!success) {
    process.exitCode = 1;
  }

  const protocolRecord = {
    timestamp: ts(),
    mac,
    device: deviceName,
    mode: "pull",
    request_payload: RUNTIME_COMMAND_HEX,
    response_payload: responsePayload,
    success,
    duration_ms: Date.now() - startedAtMs,
    error: errorText,
    attempts_used: attemptsUsed,
    hci_dev: hciDev,
  };

  try {
    appendJsonLine(PROTOCOL_FILE, protocolRecord);
    log("[PROTOCOL]", JSON.stringify(protocolRecord));
  } catch (err) {
    log("[PROTOCOL-ERROR]", String(err && err.message ? err.message : err));
  }

  writeJsonAtomic(RECEIPT_FILE, {
    timestamp: ts(),
    mac,
    device: deviceName,
    attempt: attemptsUsed,
    done: true,
    success,
    phase: "done",
    mode: "pull",
    request_payload: RUNTIME_COMMAND_HEX,
    response_payload: responsePayload,
    error: errorText,
    duration_ms: Date.now() - startedAtMs,
    disconnect_events: lastDisconnectEvents,
    peripheral_state: lastPeripheralState,
    hci_dev: hciDev,
  });

  log("[EXIT]");
}

main()
  .then(() => {
    setTimeout(() => {
      process.exit(process.exitCode || 0);
    }, 50);
  })
  .catch((err) => {
    console.error(ts(), "[FATAL]", String(err && err.message ? err.message : err));
    process.exit(1);
  });
