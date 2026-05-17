#!/usr/bin/env python3
import os
import json
import time
import html
import subprocess
from pathlib import Path
from datetime import datetime, timezone

from flask import Flask, redirect, render_template_string, request, url_for

app = Flask(__name__)

APP_TITLE = "GaragePi Operations / Backup / Poll / Export"

STATUS_DIR = "/opt/garagepi/status"
LOG_DIR = "/opt/garagepi/logs"
STATE_DIR = "/opt/garagepi/state"

CLONE_STATE_FILE = f"{STATUS_DIR}/clone_state"
DASI_STATE_FILE = f"{STATUS_DIR}/dasi_state"
DASI_LATEST_FILE = f"{STATUS_DIR}/dasi_latest"
DASI_COUNT_FILE = f"{STATUS_DIR}/dasi_snapshot_count"
DASI_ERROR_FILE = f"{STATUS_DIR}/dasi_last_error"

ALERT_LATCH_FILE = f"{STATUS_DIR}/health_alert_latched"
FAIL_COUNT_FILE = f"{STATUS_DIR}/health_fail_count"
LAST_REASON_FILE = f"{STATUS_DIR}/health_last_reason"
RECOVERY_STATE_FILE = f"{STATUS_DIR}/health_recovery_state"

POLL_LOG_FILE = "/opt/garagepi/logs/hame-rotate-batch.log"
EXPORT_LOG_FILE = "/opt/garagepi/logs/hame-runtime-export.log"
WATCHDOG_LOG_FILE = "/opt/garagepi/logs/hame-rotation-watchdog-rev3.log"

WORKER_RECEIPT_FILE = "/opt/garagepi/state/hame_worker_receipt.json"
ROTATE_STATE_FILE = "/opt/garagepi/state/rotate_state.json"

POLL_SERVICE = "hame-rotate-batch.service"
EXPORT_SERVICE = "hame-runtime-export.service"
EXPORT_PATH = "hame-runtime-export.path"
EXPORT_TIMER = "hame-runtime-export.timer"

WATCHDOG_SERVICE = "hame-rotation-watchdog-rev3.service"
WATCHDOG_TIMER = "hame-rotation-watchdog-rev3.timer"

CLONE_SERVICE = "garagepi-clone.service"
DASI_SERVICE = "garagepi-dasi.service"
HEALTHCHECK_SERVICE = "garagepi-healthcheck.service"
HEALTHCHECK_TIMER = "garagepi-healthcheck.timer"

USB_TARGET = "/dev/sda"

LIVE_FILES = [
    WORKER_RECEIPT_FILE,
    ROTATE_STATE_FILE,
    EXPORT_LOG_FILE,
]

MAX_LIVE_AGE_S = 300
WARN_LIVE_AGE_S = 600


def now_text():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def read_text(path, default="-"):
    try:
        p = Path(path)
        if not p.exists():
            return default
        data = p.read_text(errors="replace").strip()
        return data if data else default
    except Exception:
        return default


def file_age_s(path):
    try:
        p = Path(path)
        if not p.exists():
            return None
        return int(time.time() - p.stat().st_mtime)
    except Exception:
        return None


def file_mtime_text(path):
    try:
        p = Path(path)
        if not p.exists():
            return "-"
        return datetime.fromtimestamp(p.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        return "-"


def max_live_age_s():
    ages = []
    for f in LIVE_FILES:
        age = file_age_s(f)
        if age is None:
            ages.append(999999)
        else:
            ages.append(age)
    return max(ages) if ages else 999999


def tail_lines(path, limit=80):
    try:
        p = Path(path)
        if not p.exists():
            return []
        with p.open("rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            block = 4096
            data = b""
            while size > 0 and data.count(b"\n") <= limit:
                read_size = min(block, size)
                size -= read_size
                f.seek(size)
                data = f.read(read_size) + data
            text = data.decode(errors="replace")
        return text.splitlines()[-limit:]
    except Exception as e:
        return [f"ERROR reading {path}: {e}"]


def run_cmd(args, timeout=8):
    try:
        r = subprocess.run(
            args,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
        return r.returncode, r.stdout.strip(), r.stderr.strip()
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"
    except Exception as e:
        return 99, "", str(e)


def systemctl_show(unit):
    props = [
        "Id",
        "LoadState",
        "ActiveState",
        "SubState",
        "Result",
        "UnitFileState",
        "FragmentPath",
        "ActiveEnterTimestamp",
        "InactiveEnterTimestamp",
        "ExecMainStatus",
        "ExecMainCode",
    ]

    rc, out, err = run_cmd(["systemctl", "show", unit, "--property=" + ",".join(props)], timeout=5)

    data = {
        "Id": unit,
        "LoadState": "unknown",
        "ActiveState": "unknown",
        "SubState": "unknown",
        "Result": "unknown",
        "UnitFileState": "unknown",
        "FragmentPath": "",
        "ActiveEnterTimestamp": "",
        "InactiveEnterTimestamp": "",
        "ExecMainStatus": "",
        "ExecMainCode": "",
        "rc": rc,
        "err": err,
    }

    if out:
        for line in out.splitlines():
            if "=" in line:
                k, v = line.split("=", 1)
                data[k] = v

    return data


def systemctl_is_active(unit):
    rc, out, err = run_cmd(["systemctl", "is-active", unit], timeout=5)
    return rc == 0, out.strip() if out else "unknown"


def systemctl_is_enabled(unit):
    rc, out, err = run_cmd(["systemctl", "is-enabled", unit], timeout=5)
    return rc == 0, out.strip() if out else "unknown"


def classify_service(unit, mode):
    s = systemctl_show(unit)
    active = s.get("ActiveState", "unknown")
    sub = s.get("SubState", "unknown")
    result = s.get("Result", "unknown")
    enabled = s.get("UnitFileState", "unknown")

    text = f"ActiveState={active} | SubState={sub} | Result={result}"
    css = "warn"
    led = "yellow"

    if mode == "daemon":
        if active == "active" and sub in ("running", "exited"):
            text = f"OK/RUNNING | {text} | Enabled={enabled}"
            css = "ok"
            led = "green"
        else:
            text = f"FAIL | {text} | Enabled={enabled}"
            css = "bad"
            led = "red"

    elif mode == "oneshot":
        if active == "inactive" and sub == "dead" and result in ("success", "exit-code"):
            if result == "success":
                text = f"OK/IDLE | {text}"
                css = "ok"
                led = "green"
            else:
                text = f"FAIL/IDLE | {text}"
                css = "bad"
                led = "red"
        elif active == "active" or active == "activating":
            text = f"RUNNING | {text}"
            css = "ok"
            led = "green"
        else:
            text = f"WARN | {text}"
            css = "warn"
            led = "yellow"

    elif mode == "timer":
        if (
            active in ("active", "inactive")
            and result == "success"
            and enabled in ("enabled", "static")
        ):
            text = f"OK/TIMER | {text} | Enabled={enabled}"
            css = "ok"
            led = "green"
        else:
            text = f"FAIL | {text} | Enabled={enabled}"
            css = "bad"
            led = "red"

    return {
        "unit": unit,
        "text": text,
        "css": css,
        "led": led,
        "raw": s,
    }


def last_rev3_line():
    lines = tail_lines(WATCHDOG_LOG_FILE, 120)
    for line in reversed(lines):
        if "[REV3" in line:
            return line
    return "-"


def get_rev3_health():
    line = last_rev3_line()
    age = file_age_s(WATCHDOG_LOG_FILE)

    text = line
    css = "warn"
    led = "yellow"

    if line == "-":
        text = "REV3.1: kein Watchdog-Log gefunden"
        css = "bad"
        led = "red"
    elif "OK healthy" in line:
        text = line
        css = "ok"
        led = "green"
    elif "RECOVERED" in line:
        text = line
        css = "ok"
        led = "green"
    elif "FAIL" in line or "unrecovered" in line:
        text = line
        css = "bad"
        led = "red"
    elif "WARN" in line:
        text = line
        css = "warn"
        led = "yellow"
    else:
        text = line
        css = "warn"
        led = "yellow"

    if age is None:
        text = f"{text} | LogAge=missing"
        css = "bad"
        led = "red"
    else:
        text = f"{text} | LogAge={age}s"
        if age > WARN_LIVE_AGE_S and css == "ok":
            css = "warn"
            led = "yellow"

    return {"text": text, "css": css, "led": led}


def get_live_data_status():
    age = max_live_age_s()

    if age <= MAX_LIVE_AGE_S:
        return {
            "text": f"OK | LiveAgeMax={age}s | Receipt={file_mtime_text(WORKER_RECEIPT_FILE)} | Rotate={file_mtime_text(ROTATE_STATE_FILE)} | Export={file_mtime_text(EXPORT_LOG_FILE)}",
            "css": "ok",
            "led": "green",
        }

    if age <= WARN_LIVE_AGE_S:
        return {
            "text": f"WARN | LiveAgeMax={age}s",
            "css": "warn",
            "led": "yellow",
        }

    return {
        "text": f"FAIL | LiveAgeMax={age}s",
        "css": "bad",
        "led": "red",
    }


def read_json(path):
    try:
        p = Path(path)
        if not p.exists():
            return None
        return json.loads(p.read_text(errors="replace"))
    except Exception:
        return None


def compact_json_summary(path):
    data = read_json(path)
    if data is None:
        return "-"

    if isinstance(data, dict):
        keys = []
        for k in ("timestamp", "device", "mac", "success", "error", "index", "next_index", "last_mac", "last_device"):
            if k in data:
                keys.append(f"{k}={data[k]}")
        if keys:
            return " | ".join(keys)

    return json.dumps(data, ensure_ascii=False)[:300]


def action_start(unit):
    return run_cmd(["sudo", "systemctl", "start", unit], timeout=20)


def action_restart(unit):
    return run_cmd(["sudo", "systemctl", "restart", unit], timeout=30)


def action_stop(unit):
    return run_cmd(["sudo", "systemctl", "stop", unit], timeout=20)


def action_enable_now(unit):
    return run_cmd(["sudo", "systemctl", "enable", "--now", unit], timeout=20)


def action_disable_now(unit):
    return run_cmd(["sudo", "systemctl", "disable", "--now", unit], timeout=20)


@app.route("/action", methods=["POST"])
def action():
    name = request.form.get("name", "")

    allowed = {
        "restart_ui": lambda: action_restart("garagepi-ui.service"),
        "restart_poller": lambda: action_restart(POLL_SERVICE),
        "stop_poller": lambda: action_stop(POLL_SERVICE),
        "start_poller": lambda: action_start(POLL_SERVICE),
        "run_export": lambda: action_start(EXPORT_SERVICE),
        "run_watchdog": lambda: action_start(WATCHDOG_SERVICE),
        "enable_watchdog": lambda: action_enable_now(WATCHDOG_TIMER),
        "disable_old_start_timer": lambda: action_disable_now("hame-rotate-batch-start.timer"),
        "disable_old_stop_timer": lambda: action_disable_now("hame-rotate-batch-stop.timer"),
        "run_healthcheck": lambda: action_start(HEALTHCHECK_SERVICE),
        "run_clone": lambda: action_start(CLONE_SERVICE),
        "run_dasi": lambda: action_start(DASI_SERVICE),
    }

    if name in allowed:
        rc, out, err = allowed[name]()
        msg = f"{name}: rc={rc}"
        if out:
            msg += f" | OUT={out}"
        if err:
            msg += f" | ERR={err}"
        Path(f"{STATUS_DIR}/ui_last_action").parent.mkdir(parents=True, exist_ok=True)
        Path(f"{STATUS_DIR}/ui_last_action").write_text(f"{datetime.now().isoformat()} {msg}\n")
    else:
        Path(f"{STATUS_DIR}/ui_last_action").parent.mkdir(parents=True, exist_ok=True)
        Path(f"{STATUS_DIR}/ui_last_action").write_text(f"{datetime.now().isoformat()} unknown action={name}\n")

    return redirect(url_for("index"))


@app.route("/api/status")
def api_status():
    return {
        "time": now_text(),
        "poller": classify_service(POLL_SERVICE, "daemon"),
        "exporter": classify_service(EXPORT_SERVICE, "oneshot"),
        "export_path": classify_service(EXPORT_PATH, "timer"),
        "watchdog_service": classify_service(WATCHDOG_SERVICE, "oneshot"),
        "watchdog_timer": classify_service(WATCHDOG_TIMER, "timer"),
        "rev3_health": get_rev3_health(),
        "live_data": get_live_data_status(),
        "worker_receipt": compact_json_summary(WORKER_RECEIPT_FILE),
        "rotate_state": compact_json_summary(ROTATE_STATE_FILE),
    }


@app.route("/")
def index():
    poller = classify_service(POLL_SERVICE, "daemon")
    exporter = classify_service(EXPORT_SERVICE, "oneshot")
    export_path = classify_service(EXPORT_PATH, "timer")
    watchdog_service = classify_service(WATCHDOG_SERVICE, "oneshot")
    watchdog_timer = classify_service(WATCHDOG_TIMER, "timer")
    rev3_health = get_rev3_health()
    live_data = get_live_data_status()

    clone_state = read_text(CLONE_STATE_FILE)
    dasi_state = read_text(DASI_STATE_FILE)
    dasi_latest = read_text(DASI_LATEST_FILE)
    dasi_count = read_text(DASI_COUNT_FILE)
    dasi_error = read_text(DASI_ERROR_FILE)
    alert_latched = read_text(ALERT_LATCH_FILE, "NEIN")
    fail_count = read_text(FAIL_COUNT_FILE, "0")
    last_reason = read_text(LAST_REASON_FILE)
    recovery_state = read_text(RECOVERY_STATE_FILE)
    last_action = read_text(f"{STATUS_DIR}/ui_last_action")

    worker_receipt = compact_json_summary(WORKER_RECEIPT_FILE)
    rotate_state = compact_json_summary(ROTATE_STATE_FILE)

    rotate_log = "\n".join(tail_lines(POLL_LOG_FILE, 35))
    export_log = "\n".join(tail_lines(EXPORT_LOG_FILE, 35))
    watchdog_log = "\n".join(tail_lines(WATCHDOG_LOG_FILE, 35))

    return render_template_string(
        TEMPLATE,
        title=APP_TITLE,
        time=now_text(),
        usb_target=USB_TARGET,
        clone_state=clone_state,
        dasi_state=dasi_state,
        dasi_latest=dasi_latest,
        dasi_count=dasi_count,
        dasi_error=dasi_error,
        alert_latched=alert_latched,
        fail_count=fail_count,
        last_reason=last_reason,
        recovery_state=recovery_state,
        last_action=last_action,
        poller=poller,
        exporter=exporter,
        export_path=export_path,
        watchdog_service=watchdog_service,
        watchdog_timer=watchdog_timer,
        rev3_health=rev3_health,
        live_data=live_data,
        worker_receipt=worker_receipt,
        rotate_state=rotate_state,
        rotate_log=rotate_log,
        export_log=export_log,
        watchdog_log=watchdog_log,
    )


TEMPLATE = r"""
<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{ title }}</title>
<style>
:root {
    --bg: #202020;
    --panel: #252525;
    --text: #f5f5f5;
    --muted: #cccccc;
    --ok: #22c55e;
    --warn: #eab308;
    --bad: #ef4444;
    --line: #3a3a3a;
    --button: #333333;
    --button-hover: #444444;
}

* {
    box-sizing: border-box;
}

body {
    margin: 0;
    padding: 22px;
    background: var(--bg);
    color: var(--text);
    font-family: Arial, Helvetica, sans-serif;
    font-size: 20px;
}

h1 {
    text-align: center;
    font-size: 30px;
    margin: 30px 0 24px 0;
}

h2 {
    font-size: 22px;
    margin: 28px 0 12px 0;
    color: var(--text);
}

.grid {
    display: grid;
    grid-template-columns: 340px 1fr;
    gap: 10px 36px;
    max-width: 1300px;
}

.label {
    color: var(--muted);
    font-weight: 700;
}

.value {
    color: var(--text);
}

.statusline {
    display: flex;
    align-items: center;
    gap: 14px;
    font-size: 24px;
    margin: 14px 0;
    line-height: 1.35;
}

.statusline.ok {
    color: var(--ok);
}

.statusline.warn {
    color: var(--warn);
}

.statusline.bad {
    color: var(--bad);
}

.led {
    display: inline-block;
    width: 25px;
    height: 25px;
    min-width: 25px;
    border-radius: 50%;
}

.led.green {
    background: var(--ok);
}

.led.yellow {
    background: var(--warn);
}

.led.red {
    background: var(--bad);
}

.panel {
    max-width: 1300px;
    margin-top: 22px;
    padding: 16px;
    border: 1px solid var(--line);
    background: var(--panel);
    border-radius: 10px;
}

.actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 12px;
}

button {
    background: var(--button);
    color: var(--text);
    border: 1px solid #555;
    border-radius: 8px;
    padding: 10px 14px;
    font-size: 16px;
    cursor: pointer;
}

button:hover {
    background: var(--button-hover);
}

pre {
    background: #111;
    color: #eee;
    padding: 14px;
    border-radius: 8px;
    overflow-x: auto;
    white-space: pre-wrap;
    font-size: 14px;
    line-height: 1.35;
    border: 1px solid #333;
}

.small {
    font-size: 15px;
    color: var(--muted);
}

hr {
    border: 0;
    border-top: 1px solid var(--line);
    margin: 22px 0;
}

@media (max-width: 850px) {
    body {
        font-size: 17px;
        padding: 14px;
    }

    h1 {
        font-size: 24px;
    }

    .grid {
        grid-template-columns: 1fr;
        gap: 4px;
    }

    .statusline {
        font-size: 18px;
    }
}
</style>
</head>
<body>

<h1>{{ title }}</h1>

<div class="grid">
    <div class="label">Zeit</div>
    <div class="value">{{ time }}</div>

    <div class="label">USB Ziel</div>
    <div class="value">{{ usb_target }}</div>

    <div class="label">Letzter erfolgreicher Clone</div>
    <div class="value">{{ clone_state }}</div>

    <div class="label">Letzte DaSi</div>
    <div class="value">{{ dasi_state }}</div>

    <div class="label">Letzter DaSi-Fehler</div>
    <div class="value">{{ dasi_error }}</div>

    <div class="label">DaSi latest</div>
    <div class="value">{{ dasi_latest }}</div>

    <div class="label">DaSi Snapshot-Anzahl</div>
    <div class="value">{{ dasi_count }}</div>

    <div class="label">Alert gelatcht</div>
    <div class="value">{{ alert_latched }}</div>

    <div class="label">Health Fail Count</div>
    <div class="value">{{ fail_count }}</div>

    <div class="label">Letzter Health-Grund</div>
    <div class="value">{{ last_reason }}</div>

    <div class="label">Recovery State</div>
    <div class="value">{{ recovery_state }}</div>

    <div class="label">Letzte UI Aktion</div>
    <div class="value">{{ last_action }}</div>
</div>

<div class="panel">
    <h2>Live / Rotation / Export / Watchdog</h2>

    <div class="statusline {{ live_data.css }}">
        <span class="led {{ live_data.led }}"></span>
        Live-Daten: <b>{{ live_data.text }}</b>
    </div>

    <div class="statusline {{ rev3_health.css }}">
        <span class="led {{ rev3_health.led }}"></span>
        Health-Status: <b>{{ rev3_health.text }}</b>
    </div>

    <div class="statusline {{ poller.css }}">
        <span class="led {{ poller.led }}"></span>
        Rotate-Batch: <b>{{ poller.text }}</b>
    </div>

    <div class="statusline {{ exporter.css }}">
        <span class="led {{ exporter.led }}"></span>
        Runtime-Exporter: <b>{{ exporter.text }}</b>
    </div>

    <div class="statusline {{ export_path.css }}">
        <span class="led {{ export_path.led }}"></span>
        Export-Path: <b>{{ export_path.text }}</b>
    </div>

    <div class="statusline {{ watchdog_timer.css }}">
        <span class="led {{ watchdog_timer.led }}"></span>
        REV3 Watchdog Timer: <b>{{ watchdog_timer.text }}</b>
    </div>

    <div class="statusline {{ watchdog_service.css }}">
        <span class="led {{ watchdog_service.led }}"></span>
        REV3 Watchdog Service: <b>{{ watchdog_service.text }}</b>
    </div>

    <div class="small">
        Worker Receipt: {{ worker_receipt }}<br>
        Rotate State: {{ rotate_state }}
    </div>
</div>

<div class="panel">
    <h2>Aktionen</h2>

    <form class="actions" method="post" action="/action">
        <button name="name" value="restart_poller">Rotate-Batch neu starten</button>
        <button name="name" value="run_export">Runtime-Export jetzt</button>
        <button name="name" value="run_watchdog">REV3 Watchdog jetzt</button>
        <button name="name" value="enable_watchdog">REV3 Timer aktivieren</button>
        <button name="name" value="disable_old_start_timer">alten Start-Timer aus</button>
        <button name="name" value="disable_old_stop_timer">alten Stop-Timer aus</button>
        <button name="name" value="run_healthcheck">alten Healthcheck starten</button>
        <button name="name" value="run_clone">Clone starten</button>
        <button name="name" value="run_dasi">DaSi starten</button>
        <button name="name" value="restart_ui">UI neu starten</button>
    </form>
</div>

<div class="panel">
    <h2>REV3 Watchdog Log</h2>
    <pre>{{ watchdog_log }}</pre>
</div>

<div class="panel">
    <h2>Rotate-Batch Log</h2>
    <pre>{{ rotate_log }}</pre>
</div>

<div class="panel">
    <h2>Runtime-Export Log</h2>
    <pre>{{ export_log }}</pre>
</div>

</body>
</html>
"""


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
