#!/usr/bin/env node

const noble = require("@abandonware/noble");
const fs = require("fs");
const path = require("path");
const { execFileSync, execFile } = require("child_process");
const { parseRuntimeFrame } = require("./hame-parser");

const BASE_DIR = "/opt/garagepi";
const CONFIG_PATH = path.join(BASE_DIR, "devices.json");
const STATE_DIR = path.join(BASE_DIR, "state");
const LOG_DIR = path.join(BASE_DIR, "logs");
const SAVE_RUNTIME_JS = "/opt/garagepi/parser/save-hame-runtime.js";

function ts() {
  return new Date().toISOString();
}

function log(...args) {
  console.log(ts(), ...args);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

function normalizeMac(mac) {
  return String(mac || "").toLowerCase().replace(/-/g, ":");
}

function normalizeUuid(uuid) {
  return String(uuid || "").toLowerCase().replace(/-/g, "");
}

function hexToBuffer(hex) {
  return Buffer.from(hex, "hex");
}

function bufferToHex(buf) {
  return Buffer.from(buf).toString("hex");
}

function sanitizePeripheralAddress(addr) {
  return normalizeMac(addr || "");
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

function saveRuntimeJsonFromNotify(hex, deviceId, mac) {
  try {
    if (!hex || typeof hex !== "string") return;
    if (!hex.startsWith("73102303")) return;
    if (!deviceId || !mac) return;

    execFile(
      process.execPath,
      [SAVE_RUNTIME_JS, hex, String(deviceId), String(mac)],
      {
        timeout: 10000,
        windowsHide: true,
      },
      () => {}
    );
  } catch (_) {
    // JSON write must never break BLE polling
  }
}

async function waitForAdapterPoweredOn(timeoutMs = 15000) {
  if (noble.state === "poweredOn") {
    return;
  }

  await withTimeout(
    new Promise((resolve, reject) => {
      const onStateChange = (state) => {
        log(`[ADAPTER] stateChange => ${state}`);
        if (state === "poweredOn") {
          noble.removeListener("stateChange", onStateChange);
          resolve();
        }
      };

      noble.on("stateChange", onStateChange);

      if (noble.state === "unsupported") {
        noble.removeListener("stateChange", onStateChange);
        reject(new Error("BLE adapter state unsupported"));
      }
    }),
    timeoutMs,
    "adapter poweredOn"
  );
}

async function stopScanningSafe() {
  log(`[SCAN] stopScanningSafe enter state=${noble.state}`);
  try {
    await noble.stopScanningAsync();
    log(`[SCAN] stopScanningSafe done`);
  } catch (err) {
    log(
      `[SCAN] stopScanningSafe error=${String(
        err && err.message ? err.message : err
      )}`
    );
  }
}

function runCmd(cmd, args) {
  execFileSync(cmd, args, { stdio: "ignore" });
}

async function resetBleAdapter(cfg, reason) {
  log(`[BLE-RESET] start reason=${reason}`);

  try {
    await stopScanningSafe();
  } catch (_) {
  }

  try {
    runCmd("rfkill", ["unblock", "bluetooth"]);
  } catch (_) {
  }

  try {
    runCmd("hciconfig", ["hci0", "down"]);
  } catch (_) {
  }

  await sleep(1000);

  try {
    runCmd("rfkill", ["unblock", "bluetooth"]);
  } catch (_) {
  }

  try {
    runCmd("hciconfig", ["hci0", "up"]);
  } catch (err) {
    log(`[BLE-RESET] hciconfig up failed: ${String(err.message || err)}`);
  }

  await sleep(cfg.adapter_reset_cooldown_ms || 2000);
  log(`[BLE-RESET] end`);
}

async function findPeripheralByMac(targetMac, scanTimeoutMs) {
  const wanted = normalizeMac(targetMac);

  log(`[SCAN] findPeripheralByMac enter target=${wanted} timeout_ms=${scanTimeoutMs}`);

  return await withTimeout(
    new Promise((resolve, reject) => {
      let finished = false;

      const cleanup = async (reason) => {
        log(`[SCAN] cleanup start reason=${reason}`);
        noble.removeListener("discover", onDiscover);
        await stopScanningSafe();
        log(`[SCAN] cleanup done reason=${reason}`);
      };

      const finishResolve = async (peripheral, reason) => {
        if (finished) return;
        finished = true;
        log(
          `[SCAN] finishResolve reason=${reason} addr=${sanitizePeripheralAddress(
            peripheral && peripheral.address
          )}`
        );
        await cleanup(`resolve:${reason}`);
        resolve(peripheral);
      };

      const finishReject = async (err, reason) => {
        if (finished) return;
        finished = true;
        log(
          `[SCAN] finishReject reason=${reason} err=${String(
            err && err.message ? err.message : err
          )}`
        );
        await cleanup(`reject:${reason}`);
        reject(err);
      };

      const onDiscover = async (peripheral) => {
        try {
          const addr = sanitizePeripheralAddress(peripheral.address);
          const localName =
            peripheral &&
            peripheral.advertisement &&
            peripheral.advertisement.localName
              ? peripheral.advertisement.localName
              : "";

          log(
            `[SCAN] discover addr=${addr} rssi=${peripheral.rssi} localName=${localName || "-"}`
          );

          if (addr === wanted) {
            await finishResolve(peripheral, "target_match");
          }
        } catch (err) {
          await finishReject(err, "onDiscover_exception");
        }
      };

      noble.on("discover", onDiscover);

      (async () => {
        try {
          log(`[SCAN] before stopScanningSafe target=${wanted}`);
          await stopScanningSafe();
          log(`[SCAN] after stopScanningSafe target=${wanted}`);

          log(`[SCAN] before startScanningAsync target=${wanted}`);
          await noble.startScanningAsync([], false);
          log(`[SCAN] after startScanningAsync target=${wanted}`);
        } catch (err) {
          await finishReject(err, "start_scanning");
        }
      })();
    }),
    scanTimeoutMs,
    `scan for ${targetMac}`
  );
}

async function connectPeripheral(peripheral, timeoutMs) {
  log(
    `[CONNECT] enter addr=${sanitizePeripheralAddress(
      peripheral.address
    )} timeout_ms=${timeoutMs}`
  );
  await withTimeout(
    peripheral.connectAsync(),
    timeoutMs,
    `connect ${peripheral.address}`
  );
  log(`[CONNECT] done addr=${sanitizePeripheralAddress(peripheral.address)}`);
}

async function disconnectPeripheralSafe(peripheral, timeoutMs = 5000) {
  if (!peripheral) return;

  try {
    log(
      `[DISCONNECT] enter addr=${sanitizePeripheralAddress(
        peripheral.address
      )} state=${peripheral.state}`
    );

    if (peripheral.state === "connected" || peripheral.state === "connecting") {
      await withTimeout(
        peripheral.disconnectAsync(),
        timeoutMs,
        `disconnect ${peripheral.address}`
      );
    }

    log(
      `[DISCONNECT] done addr=${sanitizePeripheralAddress(
        peripheral.address
      )} state=${peripheral.state}`
    );
  } catch (err) {
    log(
      `[DISCONNECT] error addr=${sanitizePeripheralAddress(
        peripheral.address
      )} err=${String(err && err.message ? err.message : err)}`
    );
  }
}

async function discoverRuntimeCharacteristics(peripheral, cfg) {
  const serviceUuid = normalizeUuid(cfg.service_uuid);
  const writeCharUuid = normalizeUuid(cfg.write_char_uuid);
  const notifyCharUuid = normalizeUuid(cfg.notify_char_uuid);

  log(
    `[DISCOVER] enter addr=${sanitizePeripheralAddress(
      peripheral.address
    )} service=${serviceUuid} write=${writeCharUuid} notify=${notifyCharUuid}`
  );

  const result = await withTimeout(
    peripheral.discoverSomeServicesAndCharacteristicsAsync(
      [serviceUuid],
      [writeCharUuid, notifyCharUuid]
    ),
    cfg.discover_timeout_ms,
    `discover services/chars ${peripheral.address}`
  );

  const services = result.services || [];
  const characteristics = result.characteristics || [];

  log(
    `[DISCOVER] done addr=${sanitizePeripheralAddress(
      peripheral.address
    )} services=${services.length} chars=${characteristics.length}`
  );

  if (!services.length) {
    throw new Error(`Service ${serviceUuid} not found`);
  }

  const writeChar = characteristics.find((c) => normalizeUuid(c.uuid) === writeCharUuid);
  const notifyChar = characteristics.find((c) => normalizeUuid(c.uuid) === notifyCharUuid);

  if (!writeChar) {
    throw new Error(`Write characteristic ${writeCharUuid} not found`);
  }

  if (!notifyChar) {
    throw new Error(`Notify characteristic ${notifyCharUuid} not found`);
  }

  return { writeChar, notifyChar };
}

function makeBaseState(device) {
  return {
    id: device.id,
    name: device.name,
    mac: normalizeMac(device.mac),
    required: !!device.required,
    enabled: !!device.enabled,
  };
}

async function subscribeNotifySafe(notifyChar, deviceId, timeoutMs) {
  log(`[NOTIFY] [${deviceId}] subscribe enter timeout_ms=${timeoutMs}`);
  await withTimeout(
    notifyChar.subscribeAsync(),
    timeoutMs,
    `[${deviceId}] subscribe notify`
  );
  log(`[NOTIFY] [${deviceId}] subscribe done`);
}

async function unsubscribeNotifySafe(notifyChar, deviceId, timeoutMs) {
  try {
    log(`[NOTIFY] [${deviceId}] unsubscribe enter timeout_ms=${timeoutMs}`);
    await withTimeout(
      notifyChar.unsubscribeAsync(),
      timeoutMs,
      `[${deviceId}] unsubscribe notify`
    );
    log(`[NOTIFY] [${deviceId}] unsubscribe done`);
  } catch (err) {
    log(
      `[NOTIFY] [${deviceId}] unsubscribe error=${String(
        err && err.message ? err.message : err
      )}`
    );
  }
}

async function writeCommandSafe(writeChar, payload, deviceId, label, timeoutMs) {
  log(
    `[WRITE] [${deviceId}] enter label=${label} timeout_ms=${timeoutMs} payload=${bufferToHex(payload)}`
  );
  await withTimeout(
    writeChar.writeAsync(payload, true),
    timeoutMs,
    `[${deviceId}] ${label}`
  );
  log(`[WRITE] [${deviceId}] done label=${label}`);
}

function shouldRetryError(message) {
  const m = String(message || "").toLowerCase();
  return (
    m.includes("subscribe notify") ||
    m.includes("runtime command #1 write") ||
    m.includes("runtime command #2 write") ||
    m.includes("discover services/chars") ||
    m.includes("connect ") ||
    m.includes("scan for") ||
    m.includes("start_scanning") ||
    m.includes("timeout")
  );
}

async function singleDeviceAttempt(device, cfg, attemptNo) {
  let peripheral = null;
  let notifyChar = null;

  log(`[${device.id}] attempt ${attemptNo} start`);

  try {
    peripheral = await findPeripheralByMac(device.mac, cfg.scan_timeout_ms);
    const rssi = peripheral.rssi;

    log(`[${device.id}] found ${peripheral.address} rssi=${rssi}`);

    peripheral.on("disconnect", () => {
      log(
        `[${device.id}] peripheral disconnect event addr=${sanitizePeripheralAddress(
          peripheral.address
        )} state=${peripheral.state}`
      );
    });

    const postScanSettleMs = cfg.post_scan_settle_ms || 1200;
    if (postScanSettleMs > 0) {
      log(`[${device.id}] settle after scan ${postScanSettleMs} ms`);
      await sleep(postScanSettleMs);
    }

    await connectPeripheral(peripheral, cfg.connect_timeout_ms);
    log(`[${device.id}] connected`);

    const postConnectSettleMs = cfg.post_connect_settle_ms || 700;
    if (postConnectSettleMs > 0) {
      log(`[${device.id}] settle after connect ${postConnectSettleMs} ms`);
      await sleep(postConnectSettleMs);
    }

    const preDiscoverSettleMs = cfg.pre_discover_settle_ms || 0;
    if (preDiscoverSettleMs > 0) {
      log(`[${device.id}] settle before discover ${preDiscoverSettleMs} ms`);
      await sleep(preDiscoverSettleMs);
    }

    const chars = await discoverRuntimeCharacteristics(peripheral, cfg);
    const writeChar = chars.writeChar;
    notifyChar = chars.notifyChar;

    log(`[${device.id}] service/chars ready`);

    const preSubscribeSettleMs = cfg.pre_subscribe_settle_ms || 0;
    if (preSubscribeSettleMs > 0) {
      log(`[${device.id}] settle before subscribe ${preSubscribeSettleMs} ms`);
      await sleep(preSubscribeSettleMs);
    }

    const notifications = [];

    const onData = (data) => {
      const hex = bufferToHex(data);

      let parsed = null;
      try {
        parsed = parseRuntimeFrame(hex);
      } catch (err) {
        parsed = {
          parser_name: "hame-runtime-parser",
          parser_version: "parse_error_fallback",
          parse_error: String(err && err.message ? err.message : err),
          raw_hex: hex,
        };
      }

      notifications.push({
        ts: new Date().toISOString(),
        hex,
        parsed,
      });

      let summary = "";
      try {
        const ds = parsed && parsed.decoded_summary ? parsed.decoded_summary : null;
        if (ds) {
          summary = ` out_total=${ds.out_total_power_w} soc=${ds.soc_pct}`;
        }
      } catch (_) {
      }

      log(`[${device.id}] notify ${hex}${summary}`);
      saveRuntimeJsonFromNotify(hex, device.id, device.mac);
    };

    notifyChar.on("data", onData);

    try {
      await subscribeNotifySafe(notifyChar, device.id, cfg.subscribe_timeout_ms || 5000);
      log(`[${device.id}] notify subscribed`);

      const postSubscribeSettleMs = cfg.post_subscribe_settle_ms || 300;
      if (postSubscribeSettleMs > 0) {
        log(`[${device.id}] settle after subscribe ${postSubscribeSettleMs} ms`);
        await sleep(postSubscribeSettleMs);
      }

      const cmd = hexToBuffer(cfg.runtime_command_hex);

      await writeCommandSafe(
        writeChar,
        cmd,
        device.id,
        "runtime command #1 write",
        cfg.write_timeout_ms || 5000
      );
      log(`[${device.id}] runtime command #1 sent ${cfg.runtime_command_hex}`);

      await sleep(cfg.between_command_gap_ms);

      await writeCommandSafe(
        writeChar,
        cmd,
        device.id,
        "runtime command #2 write",
        cfg.write_timeout_ms || 5000
      );
      log(`[${device.id}] runtime command #2 sent ${cfg.runtime_command_hex}`);

      await sleep(cfg.notify_timeout_ms);
    } finally {
      try {
        notifyChar.removeListener("data", onData);
      } catch (_) {
      }
      if (notifyChar) {
        await unsubscribeNotifySafe(
          notifyChar,
          device.id,
          cfg.unsubscribe_timeout_ms || 3000
        );
      }
    }

    const lastNotification = notifications.length
      ? notifications[notifications.length - 1]
      : null;

    return {
      ok: notifications.length > 0,
      status: notifications.length > 0 ? "runtime_ok" : "no_notify",
      rssi,
      peripheral_address: sanitizePeripheralAddress(peripheral.address),
      peripheral_state: peripheral.state,
      service_uuid: normalizeUuid(cfg.service_uuid),
      write_char_uuid: normalizeUuid(cfg.write_char_uuid),
      notify_char_uuid: normalizeUuid(cfg.notify_char_uuid),
      runtime_command_hex: cfg.runtime_command_hex,
      notifications_count: notifications.length,
      notifications,
      last_notify_hex: lastNotification ? lastNotification.hex : null,
      last_notify_parsed: lastNotification ? lastNotification.parsed : null,
      attempt_no: attemptNo,
    };
  } catch (err) {
    throw err;
  } finally {
    await stopScanningSafe();
    await disconnectPeripheralSafe(peripheral, cfg.disconnect_timeout_ms || 5000);
    if (peripheral) {
      log(`[${device.id}] disconnected`);
    }
  }
}

async function pollDevice(device, cfg) {
  const startedAt = new Date();
  const startedAtIso = startedAt.toISOString();
  const base = makeBaseState(device);

  log(`========== START ${device.id} ${device.name} ==========`);

  const maxAttempts = Math.max(1, Number(cfg.max_attempts_per_device || 1));
  const errors = [];

  try {
    for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo += 1) {
      try {
        const result = await singleDeviceAttempt(device, cfg, attemptNo);

        const finishedAt = new Date();
        const finishedAtIso = finishedAt.toISOString();
        const durationMs = finishedAt.getTime() - startedAt.getTime();

        const state = {
          ...base,
          ok: result.ok,
          status: result.status,
          started_at: startedAtIso,
          finished_at: finishedAtIso,
          duration_ms: durationMs,
          rssi: result.rssi,
          peripheral_address: result.peripheral_address,
          peripheral_state: result.peripheral_state,
          service_uuid: result.service_uuid,
          write_char_uuid: result.write_char_uuid,
          notify_char_uuid: result.notify_char_uuid,
          runtime_command_hex: result.runtime_command_hex,
          notifications_count: result.notifications_count,
          notifications: result.notifications,
          last_notify_hex: result.last_notify_hex,
          last_notify_parsed: result.last_notify_parsed,
          attempt_no: result.attempt_no,
          retry_count: attemptNo - 1,
          recovery_applied: attemptNo > 1,
          prior_errors: errors,
        };

        log(
          `[${device.id}] finished status=${state.status} count=${state.notifications_count} attempt=${attemptNo}`
        );
        return state;
      } catch (err) {
        const msg = String(err && err.message ? err.message : err);
        errors.push({
          attempt_no: attemptNo,
          error: msg,
          ts: new Date().toISOString(),
        });

        log(`[${device.id}] attempt ${attemptNo} ERROR ${msg}`);

        const retryAllowed = attemptNo < maxAttempts && shouldRetryError(msg);

        if (!retryAllowed) {
          throw new Error(msg);
        }

        log(`[${device.id}] retry allowed after attempt ${attemptNo}`);
        await resetBleAdapter(cfg, `[${device.id}] retry_after_attempt_${attemptNo}`);
        await sleep(cfg.retry_cooldown_ms || 4000);
      }
    }

    throw new Error("unexpected retry loop exit");
  } catch (err) {
    const finishedAt = new Date();
    const finishedAtIso = finishedAt.toISOString();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    const state = {
      ...base,
      ok: false,
      status: "error",
      started_at: startedAtIso,
      finished_at: finishedAtIso,
      duration_ms: durationMs,
      error: String(err && err.message ? err.message : err),
      retry_count: errors.length > 0 ? errors.length - 1 : 0,
      prior_errors: errors,
    };

    log(`[${device.id}] ERROR ${state.error}`);
    return state;
  } finally {
    log(`========== END ${device.id} ${device.name} ==========\n`);
  }
}

function writeDeviceState(state) {
  const file = path.join(STATE_DIR, `${state.id}.json`);
  writeJsonAtomic(file, state);
}

function writeLatestState(cycle) {
  const file = path.join(STATE_DIR, "latest.json");
  writeJsonAtomic(file, cycle);
}

function summarizeCycle(results) {
  const enabled = results.filter((r) => r.enabled);
  const ok = enabled.filter((r) => r.ok).length;
  const fail = enabled.length - ok;
  const requiredFailed = enabled
    .filter((r) => r.required && !r.ok)
    .map((r) => r.id);

  return {
    enabled_devices: enabled.length,
    ok_devices: ok,
    failed_devices: fail,
    required_failed: requiredFailed,
    overall_status: requiredFailed.length === 0 ? "ok" : "degraded",
  };
}

async function runCycle(cfg) {
  const cycleStarted = new Date();
  const cycleStartedIso = cycleStarted.toISOString();

  const results = [];

  for (const device of cfg.devices) {
    if (!device.enabled) {
      const skipped = {
        ...makeBaseState(device),
        ok: false,
        status: "disabled",
        started_at: cycleStartedIso,
        finished_at: new Date().toISOString(),
        duration_ms: 0,
      };
      results.push(skipped);
      writeDeviceState(skipped);
      continue;
    }

    const state = await pollDevice(device, cfg);
    results.push(state);
    writeDeviceState(state);

    await sleep(cfg.between_devices_gap_ms);
  }

  const cycleFinished = new Date();
  const cycleFinishedIso = cycleFinished.toISOString();

  const summary = summarizeCycle(results);

  const cycle = {
    started_at: cycleStartedIso,
    finished_at: cycleFinishedIso,
    duration_ms: cycleFinished.getTime() - cycleStarted.getTime(),
    summary,
    devices: results,
  };

  writeLatestState(cycle);

  log(
    `[CYCLE] overall=${summary.overall_status} ok=${summary.ok_devices}/${summary.enabled_devices} required_failed=${summary.required_failed.join(",") || "-"}`
  );

  return cycle;
}

async function main() {
  ensureDir(BASE_DIR);
  ensureDir(STATE_DIR);
  ensureDir(LOG_DIR);

  const cfg = readJson(CONFIG_PATH);
  const once = process.argv.includes("--once");

  log("GaragePi runner starting");
  log(`Config loaded from ${CONFIG_PATH}`);

  await waitForAdapterPoweredOn(15000);
  log(`BLE adapter ready, noble.state=${noble.state}`);

  if (once) {
    await runCycle(cfg);
    log("GaragePi runner finished --once");
    return;
  }

  while (true) {
    try {
      await runCycle(cfg);
    } catch (err) {
      log(`[FATAL-CYCLE] ${String(err && err.message ? err.message : err)}`);
    }

    await sleep(cfg.poll_interval_ms);
  }
}

process.on("SIGINT", async () => {
  log("SIGINT received, stopping");
  await stopScanningSafe();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  log("SIGTERM received, stopping");
  await stopScanningSafe();
  process.exit(0);
});

main().catch(async (err) => {
  log(`[FATAL] ${String(err && err.message ? err.message : err)}`);
  await stopScanningSafe();
  process.exit(1);
});