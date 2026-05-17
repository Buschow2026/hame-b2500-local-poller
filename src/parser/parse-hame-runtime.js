#!/usr/bin/env node
"use strict";

function hexToBuffer(hex) {
  if (typeof hex !== "string") {
    throw new Error("hex must be a string");
  }

  const clean = hex.trim().toLowerCase().replace(/[^0-9a-f]/g, "");
  if (clean.length === 0) {
    throw new Error("empty hex");
  }
  if (clean.length % 2 !== 0) {
    throw new Error(`hex length must be even, got ${clean.length}`);
  }

  return Buffer.from(clean, "hex");
}

function u8(buf, off) {
  if (off < 0 || off >= buf.length) return null;
  return buf.readUInt8(off);
}

function u16le(buf, off) {
  if (off < 0 || off + 1 >= buf.length) return null;
  return buf.readUInt16LE(off);
}

function sliceHex(buf, start, end) {
  if (start < 0) start = 0;
  if (end > buf.length) end = buf.length;
  if (start >= end) return "";
  return buf.subarray(start, end).toString("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function parseRuntimeFrame(buf, deviceId = null, mac = null) {
  const headerHex = sliceHex(buf, 0, 4);
  const frameType = headerHex === "73102303" ? "runtime_info_notify" : "unknown";

  const outTotalW = u16le(buf, 10);
  const socPct = u8(buf, 18);

  const result = {
    meta: {
      parser_version: "hame-runtime-v2",
      source: "ble_runtime",
      parsed_at: nowIso()
    },

    device: {
      id: deviceId,
      mac: mac
    },

    frame: {
      type: frameType,
      raw_hex: buf.toString("hex"),
      length_bytes: buf.length,
      header_hex: headerHex
    },

    health: {
      frame_ok: frameType === "runtime_info_notify",
      has_out_total_w: outTotalW !== null,
      has_soc_pct: socPct !== null
    },

    battery: {
      soc_pct: socPct
    },

    output: {
      total_w: outTotalW,
      output1_w: null,
      output2_w: null
    },

    solar: {
      input1_w: null,
      input2_w: null,
      total_w: null
    },

    status: {
      output1_active: null,
      output2_active: null,
      input1_charging: null,
      input1_pass_through: null,
      input2_charging: null,
      input2_pass_through: null
    },

    settings: {
      discharge_depth_pct: null,
      battery_output_threshold_w: null,
      charging_mode: null,
      adaptive_mode: null
    },

    raw_fields: {
      bytes_00_03_header: sliceHex(buf, 0, 4),
      bytes_04_09_unknown: sliceHex(buf, 4, 10),
      bytes_10_11_out_total_le: sliceHex(buf, 10, 12),
      bytes_12_15_unknown: sliceHex(buf, 12, 16),
      byte_16_status: u8(buf, 16),
      byte_17_unknown: u8(buf, 17),
      byte_18_soc: u8(buf, 18),
      bytes_19_plus_unknown: sliceHex(buf, 19, buf.length)
    },

    compatibility: {
      hm2mqtt_reference: {
        batteryPercentage: socPct,
        outputPower: {
          total: outTotalW,
          output1: null,
          output2: null
        },
        solarPower: {
          total: null,
          input1: null,
          input2: null
        }
      }
    },

    notes: []
  };

  if (buf.length < 19) {
    result.notes.push("frame shorter than expected minimum for current mapping");
  }

  if (frameType !== "runtime_info_notify") {
    result.notes.push(`unexpected header ${headerHex}`);
  }

  if (outTotalW === null) {
    result.notes.push("out_total_w could not be parsed");
  }

  if (socPct === null) {
    result.notes.push("soc_pct could not be parsed");
  }

  return result;
}

function parseRuntimeHex(hex, deviceId = null, mac = null) {
  return parseRuntimeFrame(hexToBuffer(hex), deviceId, mac);
}

function main() {
  try {
    const hex = process.argv[2];
    const deviceId = process.argv[3] || null;
    const mac = process.argv[4] || null;

    if (!hex) {
      console.error("Usage: node parse-hame-runtime.js <hex> [deviceId] [mac]");
      process.exit(1);
    }

    const parsed = parseRuntimeHex(hex, deviceId, mac);
    process.stdout.write(JSON.stringify(parsed, null, 2) + "\n");
  } catch (err) {
    const out = {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  hexToBuffer,
  parseRuntimeFrame,
  parseRuntimeHex
};
