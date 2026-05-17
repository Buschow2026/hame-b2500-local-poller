#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { parseRuntimeHex } = require("./parse-hame-runtime.js");

function usage() {
  console.error("Usage: node save-hame-runtime.js <hex> <deviceId> <mac>");
  process.exit(1);
}

function atomicWriteJson(targetPath, obj) {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.tmp-${path.basename(targetPath)}-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmpPath, targetPath);
}

function main() {
  const hex = process.argv[2];
  const deviceId = process.argv[3];
  const mac = process.argv[4];

  if (!hex || !deviceId || !mac) {
    usage();
  }

  const parsed = parseRuntimeHex(hex, deviceId, mac);

  const baseDir = `/opt/garagepi/data/${deviceId}`;
  const latestPath = `${baseDir}/latest.json`;
  const historyDir = `${baseDir}/history`;

  const ts = new Date().toISOString().replace(/[:]/g, "-");
  const historyPath = `${historyDir}/${ts}.json`;

  atomicWriteJson(latestPath, parsed);
  atomicWriteJson(historyPath, parsed);

  process.stdout.write(JSON.stringify({
    ok: true,
    deviceId,
    latestPath,
    historyPath
  }, null, 2) + "\n");
}

main();
