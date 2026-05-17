#!/usr/bin/env node

const noble = require("@abandonware/noble");

const TARGETS = new Set([
  "AA:BB:CC:DD:EE:01",
  "AA:BB:CC:DD:EE:02",
  "AA:BB:CC:DD:EE:03",
]);

function ts() {
  return new Date().toISOString();
}

function log(...args) {
  console.log(ts(), ...args);
}

function normMac(mac) {
  return String(mac || "").toLowerCase().replace(/-/g, ":");
}

async function waitForPoweredOn(timeoutMs = 15000) {
  if (noble.state === "poweredOn") {
    return;
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Adapter did not reach poweredOn within ${timeoutMs} ms, current=${noble.state}`
        )
      );
    }, timeoutMs);

    const onStateChange = (state) => {
      log(`[ADAPTER] stateChange=${state}`);
      if (state === "poweredOn") {
        clearTimeout(timer);
        noble.removeListener("stateChange", onStateChange);
        resolve();
      }
    };

    noble.on("stateChange", onStateChange);
  });
}

async function main() {
  const scanSeconds = Number(process.argv[2] || 20);

  log(`[BOOT] discovery-only starting, noble.state=${noble.state}`);

  noble.on("stateChange", (state) => {
    log(`[ADAPTER] stateChange=${state}`);
  });

  noble.on("warning", (msg) => {
    log(`[WARNING] ${msg}`);
  });

  noble.on("scanStart", () => {
    log("[SCAN] scanStart");
  });

  noble.on("scanStop", () => {
    log("[SCAN] scanStop");
  });

  noble.on("discover", (peripheral) => {
    const addr = normMac(peripheral.address);
    const localName =
      peripheral &&
      peripheral.advertisement &&
      peripheral.advertisement.localName
        ? peripheral.advertisement.localName
        : "-";

    const isTarget = TARGETS.has(addr) ? "TARGET" : "other";

    log(
      `[DISCOVER] ${isTarget} addr=${addr} rssi=${peripheral.rssi} localName=${localName}`
    );
  });

  await waitForPoweredOn(15000);

  log("[SCAN] before startScanningAsync");
  await noble.startScanningAsync([], false);
  log(`[SCAN] after startScanningAsync; scanning for ${scanSeconds}s`);

  await new Promise((resolve) => setTimeout(resolve, scanSeconds * 1000));

  log("[SCAN] before stopScanningAsync");
  await noble.stopScanningAsync();
  log("[SCAN] after stopScanningAsync");

  log("[DONE] discovery-only finished");
}

main().catch((err) => {
  log(`[FATAL] ${String(err && err.message ? err.message : err)}`);
  process.exit(1);
});
