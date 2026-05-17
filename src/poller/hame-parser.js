"use strict";

function hexToBuffer(hex) {
  if (typeof hex !== "string") {
    throw new Error("hex must be a string");
  }

  const clean = hex.trim().toLowerCase();

  if (!/^[0-9a-f]*$/.test(clean)) {
    throw new Error("hex contains non-hex characters");
  }

  if (clean.length % 2 !== 0) {
    throw new Error("hex length must be even");
  }

  return Buffer.from(clean, "hex");
}

function u8(buf, offset) {
  if (offset >= buf.length) return null;
  return buf[offset];
}

function i16le(buf, offset) {
  if (offset + 1 >= buf.length) return null;
  return buf.readInt16LE(offset);
}

function u16le(buf, offset) {
  if (offset + 1 >= buf.length) return null;
  return buf.readUInt16LE(offset);
}

function u16be(buf, offset) {
  if (offset + 1 >= buf.length) return null;
  return buf.readUInt16BE(offset);
}

function u32le(buf, offset) {
  if (offset + 3 >= buf.length) return null;
  return buf.readUInt32LE(offset);
}

function sliceHex(buf, start, end) {
  if (start >= buf.length) return "";
  return buf.subarray(start, Math.min(end, buf.length)).toString("hex");
}

function buildByteMap(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i += 1) {
    out.push({
      offset: i,
      dec: buf[i],
      hex: buf[i].toString(16).padStart(2, "0")
    });
  }
  return out;
}

function buildWordMapLE(buf) {
  const out = [];
  for (let i = 0; i + 1 < buf.length; i += 2) {
    out.push({
      offset: i,
      dec: buf.readUInt16LE(i),
      hex: "0x" + buf.readUInt16LE(i).toString(16)
    });
  }
  return out;
}

function buildWordMapBE(buf) {
  const out = [];
  for (let i = 0; i + 1 < buf.length; i += 2) {
    out.push({
      offset: i,
      dec: buf.readUInt16BE(i),
      hex: "0x" + buf.readUInt16BE(i).toString(16)
    });
  }
  return out;
}

function xorChecksumCandidate(buf) {
  if (buf.length < 1) return null;
  let x = 0;
  for (let i = 0; i < buf.length - 1; i += 1) {
    x ^= buf[i];
  }
  return x;
}

function classifyFrame(buf) {
  if (buf.length >= 4 && buf[0] === 0x73 && buf[2] === 0x23 && buf[3] === 0x03) {
    return "runtime_info_reply";
  }
  return "unknown";
}

function boolFromBit(byte, mask) {
  if (byte == null) return null;
  return !!(byte & mask);
}

function slotToUser(slot) {
  if (slot === "S04") return "batt1";
  if (slot === "S05") return "batt2";
  if (slot === "S06") return "batt3";
  return null;
}

function macToDev4(mac) {
  if (!mac) return null;
  const clean = String(mac).toLowerCase().replace(/:/g, "").replace(/-/g, "");
  if (clean.length < 4) return null;
  return clean.slice(-4);
}

function buildIdentity(context = {}) {
  const slot = context.slot || null;
  const mac = context.mac ? String(context.mac).toLowerCase() : null;

  return {
    slot,
    mac,
    dev4: macToDev4(mac),
    user: slotToUser(slot)
  };
}

function parseRuntimeFrame(hex, context = {}) {
  const buf = hexToBuffer(hex);

  const frameType = classifyFrame(buf);

  const checksumCandidateExpected = u8(buf, buf.length - 1);
  const checksumCandidateCalculated = xorChecksumCandidate(buf);

  const in1Flags = u8(buf, 4);
  const in2Flags = u8(buf, 5);
  const chargeModeRaw = u8(buf, 13);
  const dischargeFlags = u8(buf, 14);
  const wifiMqttFlags = u8(buf, 15);

  const socX10 = u16le(buf, 10);
  const socPct = socX10 == null ? null : socX10 / 10;

  const in1Power = u16le(buf, 6);
  const in2Power = u16le(buf, 8);
  const out1Power = u16le(buf, 24);
  const out2Power = u16le(buf, 26);

  const identity = buildIdentity(context);

  return {
    parser_name: "hame-runtime-parser",
    parser_version: "v5_hmjs_runtime_mapping_identity_ready",
    frame_type: frameType,
    byte_length: buf.length,
    raw_hex: hex.toLowerCase(),

    identity,

    header: {
      start_byte: u8(buf, 0),
      protocol_length_field: u8(buf, 1),
      identifier_byte: u8(buf, 2),
      command: u8(buf, 3),

      checksum_candidate_expected: checksumCandidateExpected,
      checksum_candidate_calculated: checksumCandidateCalculated
    },

    decoded_summary: {
      soc_x10_pct: socX10,
      soc_pct: socPct,
      dod_pct: u8(buf, 18),
      remaining_capacity_wh: u16le(buf, 22),

      pv_in1_w: in1Power,
      pv_in2_w: in2Power,
      pv_total_w:
        in1Power == null || in2Power == null ? null : in1Power + in2Power,

      out1_w: out1Power,
      out2_w: out2Power,
      batt_out_total_w:
        out1Power == null || out2Power == null ? null : out1Power + out2Power,

      temp_low_c: i16le(buf, 33),
      temp_high_c: i16le(buf, 35),

      time_hhmm:
        u8(buf, 31) == null || u8(buf, 32) == null
          ? null
          : String(u8(buf, 31)).padStart(2, "0") +
            ":" +
            String(u8(buf, 32)).padStart(2, "0")
    },

    runtime_info: {
      head: u8(buf, 0),
      protocolLengthField: u8(buf, 1),
      cntl: u8(buf, 2),
      command: u8(buf, 3),

      in1Active: {
        raw: in1Flags,
        active: boolFromBit(in1Flags, 0x01),
        transparent: boolFromBit(in1Flags, 0x02)
      },

      in2Active: {
        raw: in2Flags,
        active: boolFromBit(in2Flags, 0x01),
        transparent: boolFromBit(in2Flags, 0x02)
      },

      in1Power_w: in1Power,
      in2Power_w: in2Power,

      soc_x10_pct: socX10,
      soc_pct: socPct,

      devVersion: u8(buf, 12),

      chargeMode: {
        raw: chargeModeRaw,
        loadFirst: boolFromBit(chargeModeRaw, 0x01)
      },

      dischargeSetting: {
        raw: dischargeFlags,
        out1Enable: boolFromBit(dischargeFlags, 0x01),
        out2Enable: boolFromBit(dischargeFlags, 0x02)
      },

      wifiMqttState: {
        raw: wifiMqttFlags,
        wifiConnected: boolFromBit(wifiMqttFlags, 0x01),
        mqttConnected: boolFromBit(wifiMqttFlags, 0x02)
      },

      out1Active: u8(buf, 16),
      out2Active: u8(buf, 17),

      dod_pct: u8(buf, 18),
      dischargeThreshold: u16le(buf, 19),
      deviceScene: u8(buf, 21),
      remainingCapacity_wh: u16le(buf, 22),

      out1Power_w: out1Power,
      out2Power_w: out2Power,

      extern1Connected: u8(buf, 28),
      extern2Connected: u8(buf, 29),
      deviceRegion: u8(buf, 30),

      time: {
        hour: u8(buf, 31),
        minute: u8(buf, 32)
      },

      temperatureLow_c: i16le(buf, 33),
      temperatureHigh_c: i16le(buf, 35),
      reserved1: u16le(buf, 37),

      deviceSubVersion: u8(buf, 39),

      dailyTotalBatteryCharge_Wh: u32le(buf, 40),
      dailyTotalBatteryDischarge_Wh: u32le(buf, 44),
      dailyTotalLoadCharge_Wh: u32le(buf, 48),
      dailyTotalLoadDischarge_Wh: u32le(buf, 52)
    },

    views: {
      bytes: buildByteMap(buf),
      words_le: buildWordMapLE(buf),
      words_be: buildWordMapBE(buf)
    },

    raw_blocks: {
      header_hex: sliceHex(buf, 0, 4),
      status_hex: sliceHex(buf, 4, 18),
      control_hex: sliceHex(buf, 18, 30),
      env_hex: sliceHex(buf, 30, 40),
      daily_hex: sliceHex(buf, 40, 56),
      tail_hex: sliceHex(buf, Math.max(0, buf.length - 1), buf.length)
    }
  };
}

module.exports = {
  parseRuntimeFrame
};
