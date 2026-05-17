#!/usr/bin/env node

const noble = require("@abandonware/noble");

const DEFAULT_TARGET_MAC = "AA:BB:CC:DD:EE:01";
const DEFAULT_SCAN_TIMEOUT_MS = 15000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15000;
const DEFAULT_HOLD_MS = 5000;
const DEFAULT_POST_FOUND_SETTLE_MS = 1200;
const DEFAULT_POST_CONNECT_SETTLE_MS = 1000;

function ts() {
  return new Date().toISOString();
}

function log(...args) {
  console.log(ts(), ...args);
}

function normMac(mac) {
  return String(mac || "").toLowerCase().replace(/-/g, ":");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function waitForPoweredOn(timeoutMs = 15000) {
  if (noble.state === "poweredOn") {
    log(`[ADAPTER] already poweredOn`);
    return;
  }

  log(`[ADAPTER] waitForPoweredOn enter current=${noble.state}`);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      noble.removeListener("stateChange", onStateChange);
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

  log(`[ADAPTER] waitForPoweredOn done`);
}

async function stopScanningSafe(label) {
  log(`[SCAN] stop enter label=${label} state=${noble.state}`);
  try {
    await noble.stopScanningAsync();
    log(`[SCAN] stop done label=${label}`);
  } catch (err) {
    log(
      `[SCAN] stop error label=${label} err=${String(
        err && err.message ? err.message : err
      )}`
    );
  }
}

async function findPeripheralByMac(targetMac, scanTimeoutMs) {
  const wanted = normMac(targetMac);

  log(`[SCAN] find enter target=${wanted} timeout_ms=${scanTimeoutMs}`);

  return await withTimeout(
    new Promise((resolve, reject) => {
      let finished = false;

      const finishResolve = async (peripheral, reason) => {
        if (finished) return;
        finished = true;
        const addr = normMac(peripheral && peripheral.address);
        log(`[SCAN] resolve reason=${reason} addr=${addr}`);
        noble.removeListener("discover", onDiscover);
        await stopScanningSafe(`resolve:${reason}`);
        resolve(peripheral);
      };

      const finishReject = async (err, reason) => {
        if (finished) return;
        finished = true;
        log(
          `[SCAN] reject reason=${reason} err=${String(
            err && err.message ? err.message : err
          )}`
        );
        noble.removeListener("discover", onDiscover);
        await stopScanningSafe(`reject:${reason}`);
        reject(err);
      };

      const onDiscover = async (peripheral) => {
        try {
          const addr = normMac(peripheral.address);
          const localName =
            peripheral &&
            peripheral.advertisement &&
            peripheral.advertisement.localName
              ? peripheral.advertisement.localName
              : "-";

          log(
            `[SCAN] discover addr=${addr} rssi=${peripheral.rssi} localName=${localName}`
          );

          if (addr === wanted) {
            await finishResolve(peripheral, "target_match");
          }
        } catch (err) {
          await finishReject(err, "discover_handler");
        }
      };

      noble.on("discover", onDiscover);

      (async () => {
        try {
          log(`[SCAN] start enter`);
          await noble.startScanningAsync([], false);
          log(`[SCAN] start done`);
        } catch (err) {
          await finishReject(err, "startScanningAsync");
        }
      })();
    }),
    scanTimeoutMs,
    `scan for ${targetMac}`
  );
}

async function connectPeripheral(peripheral, connectTimeoutMs) {
  const addr = normMac(peripheral.address);

  log(
    `[CONNECT] enter addr=${addr} state_before=${peripheral.state} timeout_ms=${connectTimeoutMs}`
  );

  await withTimeout(
    peripheral.connectAsync(),
    connectTimeoutMs,
    `connect ${addr}`
  );

  log(`[CONNECT] done addr=${addr} state_after=${peripheral.state}`);
}

async function disconnectPeripheralSafe(peripheral, timeoutMs = 8000) {
  if (!peripheral) {
    log(`[DISCONNECT] skip no peripheral`);
    return;
  }

  const addr = normMac(peripheral.address);

  log(
    `[DISCONNECT] enter addr=${addr} state_before=${peripheral.state} timeout_ms=${timeoutMs}`
  );

  try {
    if (peripheral.state === "connected" || peripheral.state === "connecting") {
      await withTimeout(
        peripheral.disconnectAsync(),
        timeoutMs,
        `disconnect ${addr}`
      );
      log(`[DISCONNECT] done addr=${addr} state_after=${peripheral.state}`);
    } else {
      log(`[DISCONNECT] skip addr=${addr} state=${peripheral.state}`);
    }
  } catch (err) {
    log(
      `[DISCONNECT] error addr=${addr} err=${String(
        err && err.message ? err.message : err
      )}`
    );
  }
}

async function main() {
  const targetMac = normMac(process.argv[2] || DEFAULT_TARGET_MAC);
  const scanTimeoutMs = Number(process.argv[3] || DEFAULT_SCAN_TIMEOUT_MS);
  const connectTimeoutMs = Number(process.argv[4] || DEFAULT_CONNECT_TIMEOUT_MS);
  const holdMs = Number(process.argv[5] || DEFAULT_HOLD_MS);

  let peripheral = null;
  let disconnectEvents = 0;

  log(
    `[BOOT] connect-only starting target=${targetMac} scan_timeout_ms=${scanTimeoutMs} connect_timeout_ms=${connectTimeoutMs} hold_ms=${holdMs} noble.state=${noble.state}`
  );

  noble.on("stateChange", (state) => {
    log(`[ADAPTER] stateChange=${state}`);
  });

  noble.on("warning", (msg) => {
    log(`[WARNING] ${msg}`);
  });

  noble.on("scanStart", () => {
    log(`[SCAN] event scanStart`);
  });

  noble.on("scanStop", () => {
    log(`[SCAN] event scanStop`);
  });

  await waitForPoweredOn(15000);

  try {
    peripheral = await findPeripheralByMac(targetMac, scanTimeoutMs);

    const addr = normMac(peripheral.address);
    const localName =
      peripheral &&
      peripheral.advertisement &&
      peripheral.advertisement.localName
        ? peripheral.advertisement.localName
        : "-";

    log(
      `[TARGET] found addr=${addr} rssi=${peripheral.rssi} localName=${localName} state=${peripheral.state}`
    );

    peripheral.on("disconnect", (error) => {
      disconnectEvents += 1;
      log(
        `[PERIPHERAL] disconnect event #${disconnectEvents} addr=${addr} state=${peripheral.state} error=${String(
          error && error.message ? error.message : error || "-"
        )}`
      );
    });

    if (DEFAULT_POST_FOUND_SETTLE_MS > 0) {
      log(`[FLOW] settle after found ${DEFAULT_POST_FOUND_SETTLE_MS} ms`);
      await sleep(DEFAULT_POST_FOUND_SETTLE_MS);
    }

    await connectPeripheral(peripheral, connectTimeoutMs);

    if (DEFAULT_POST_CONNECT_SETTLE_MS > 0) {
      log(`[FLOW] settle after connect ${DEFAULT_POST_CONNECT_SETTLE_MS} ms`);
      await sleep(DEFAULT_POST_CONNECT_SETTLE_MS);
    }

    log(
      `[HOLD] enter hold_ms=${holdMs} state=${peripheral.state} disconnect_events=${disconnectEvents}`
    );
    await sleep(holdMs);
    log(
      `[HOLD] done hold_ms=${holdMs} state=${peripheral.state} disconnect_events=${disconnectEvents}`
    );

    log(
      `[RESULT] connect_only_success addr=${addr} final_state=${peripheral.state} disconnect_events=${disconnectEvents}`
    );
  } catch (err) {
    log(`[RESULT] ERROR ${String(err && err.message ? err.message : err)}`);
  } finally {
    await stopScanningSafe("main_finally");
    await disconnectPeripheralSafe(peripheral, 8000);
    log(`[DONE] connect-only finished`);
  }
}

process.on("SIGINT", async () => {
  log(`[SIGNAL] SIGINT`);
  await stopScanningSafe("sigint");
  process.exit(130);
});

process.on("SIGTERM", async () => {
  log(`[SIGNAL] SIGTERM`);
  await stopScanningSafe("sigterm");
  process.exit(143);
});

main().catch(async (err) => {
  log(`[FATAL] ${String(err && err.message ? err.message : err)}`);
  await stopScanningSafe("fatal");
  process.exit(1);
});
