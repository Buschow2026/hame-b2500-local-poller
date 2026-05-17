#!/usr/bin/env node

const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const PORT = 8080;
const FREEZE_DIR = "/opt/garagepi/freezes";
const FREEZE_SCRIPT = "/opt/garagepi/freeze_now.sh";

function html(body) {
  return `
  <html>
  <head>
    <title>GaragePi Freeze UI</title>
    <style>
      body { font-family: monospace; background:#111; color:#0f0; padding:20px; }
      button { padding:10px; margin:5px; background:#222; color:#0f0; border:1px solid #0f0; }
      .box { margin-top:20px; padding:10px; border:1px solid #0f0; }
    </style>
  </head>
  <body>
    <h2>GaragePi Freeze UI</h2>
    ${body}
  </body>
  </html>
  `;
}

function listFreezes() {
  try {
    const dirs = fs.readdirSync(FREEZE_DIR)
      .filter(f => f.startsWith("freeze_"))
      .sort()
      .reverse();

    return dirs.map(d => `<div>${d}</div>`).join("");
  } catch {
    return "<div>no freezes</div>";
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/") {
    const body = `
      <button onclick="location.href='/freeze'">CREATE FREEZE</button>
      <button onclick="location.href='/refresh'">REFRESH</button>

      <div class="box">
        <b>Freezes:</b><br>
        ${listFreezes()}
      </div>
    `;
    res.end(html(body));
  }

  else if (req.url === "/freeze") {
    exec(`bash ${FREEZE_SCRIPT}`, (err, stdout, stderr) => {
      const output = (stdout || "") + (stderr || "");
      res.end(html(`
        <div>FREEZE DONE</div>
        <pre>${output}</pre>
        <a href="/">back</a>
      `));
    });
  }

  else if (req.url === "/refresh") {
    res.writeHead(302, { Location: "/" });
    res.end();
  }

  else {
    res.writeHead(404);
    res.end("not found");
  }
});

server.listen(PORT, () => {
  console.log(`Freeze UI running on port ${PORT}`);
});