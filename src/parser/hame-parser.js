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

function xorChecksum(buf) {
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
  if (buf.length >= 4 && buf[0] === 0x73 && buf[2] === 0x23 && buf[3] === 0x04) {
    return "device_info_reply";
  }
  return "unknown";
}

function parseRuntimeFrame(hex) {
  const buf = hexToBuffer(hex);

  const frameType = classifyFrame(buf);
  const checksumExpected = u8(buf, buf.length - 1);
  const checksumCalculated = buf.length >= 1 ? xorChecksum(buf) : null;

  const in1Flags = u8(buf, 4);
  const in2Flags = u8(buf, 5);
  const dischargeFlags = u8(buf, 14);
  const wifiMqttFlags = u8(buf, 15);

  const socX10 = u16le(buf, 10);
  const socPct = socX10 == null ? null : socX10 / 10;

  return {
    parser_name: "hame-runtime-parser",
    parser_version: "v4_hmjs_runtime_mapping",
    frame_type: frameType,
    byte_length: buf.length,
    raw_hex: hex.toLowerCase(),

    header: {
      start_byte: u8(buf, 0),
      data_length_field: u8(buf, 1),
      identifier_byte: u8(buf, 2),
      command: u8(buf, 3),
      checksum_expected: checksumExpected,
      checksum_calculated: checksumCalculated,
      checksum_ok:
        checksumExpected == null || checksumCalculated == null
          ? null
          : checksumExpected === checksumCalculated
    },

    decoded_summary: {
      soc_x10_pct: socX10,
      soc_pct: socPct,
      dod_pct: u8(buf, 18),
      remaining_capacity_wh: u16le(buf, 22),
      in_total_power_w:
        (u16le(buf, 6) == null || u16le(buf, 8) == null)
          ? null
          : u16le(buf, 6) + u16le(buf, 8),
      out_total_power_w:
        (u16le(buf, 24) == null || u16le(buf, 26) == null)
          ? null
          : u16le(buf, 24) + u16le(buf, 26),
      temperature_low_c: i16le(buf, 33),
      temperature_high_c: i16le(buf, 35),
      time_hhmm:
        u8(buf, 31) == null || u8(buf, 32) == null
          ? null
          : String(u8(buf, 31)).padStart(2, "0") +
            ":" +
            String(u8(buf, 32)).padStart(2, "0")
    },

    runtime_info: {
      head: u8(buf, 0),
      data_length: u8(buf, 1),
      cntl: u8(buf, 2),
      command: u8(buf, 3),

      in1Active: {
        raw: in1Flags,
        active: in1Flags == null ? null : !!(in1Flags & 0x01),
        transparent: in1Flags == null ? null : !!(in1Flags & 0x02)
      },

      in2Active: {
        raw: in2Flags,
        active: in2Flags == null ? null : !!(in2Flags & 0x01),
        transparent: in2Flags == null ? null : !!(in2Flags & 0x02)
      },

      in1Power_w: u16le(buf, 6),
      in2Power_w: u16le(buf, 8),

      soc_x10_pct: socX10,
      soc_pct: socPct,

      devVersion: u8(buf, 12),

      chargeMode: {
        raw: u8(buf, 13),
        loadFirst: u8(buf, 13) == null ? null : !!(u8(buf, 13) & 0x01)
      },

      dischargeSetting: {
        raw: dischargeFlags,
        out1Enable: dischargeFlags == null ? null : !!(dischargeFlags & 0x01),
        out2Enable: dischargeFlags == null ? null : !!(dischargeFlags & 0x02)
      },

      wifiMqttState: {
        raw: wifiMqttFlags,
        wifiConnected: wifiMqttFlags == null ? null : !!(wifiMqttFlags & 0x01),
        mqttConnected: wifiMqttFlags == null ? null : !!(wifiMqttFlags & 0x02)
      },

      out1Active: u8(buf, 16),
      out2Active: u8(buf, 17),

      dod_pct: u8(buf, 18),
      dischargeThreshold: u16le(buf, 19),
      deviceScene: u8(buf, 21),
      remainingCapacity_wh: u16le(buf, 22),

      out1Power_w: u16le(buf, 24),
      out2Power_w: u16le(buf, 26),

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

      dailyTotalBatteryCharge: u32le(buf, 40),
      dailyTotalBatteryDischarge: u32le(buf, 44),
      dailyTotalLoadCharge: u32le(buf, 48),
      dailyTotalLoadDischarge: u32le(buf, 52)
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
      checksum_hex: sliceHex(buf, Math.max(0, buf.length - 1), buf.length)
    }
  };
}

module.exports = {
  parseRuntimeFrame
};
