#!/usr/bin/env bash
set -euo pipefail

MQTT_HOST="MQTT_BROKER_IP"
MQTT_PORT="1883"
MQTT_USER="mqtt"
MQTT_PASS="CHANGE_ME"

EXPORTER="/opt/garagepi/operational/hame-runtime-export.js"
QUEUE="/opt/garagepi/state/hame_protocol.jsonl"
LOCK_DIR="/opt/garagepi/state/locks/hame-runtime-export-wrapper.lock"

MAX_LOOPS=2000
SLEEP_BETWEEN_LOOPS="0.05"

ts() {
  date -Iseconds
}

log() {
  echo "$(ts) [WRAPPER] $*"
}

cleanup() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "wrapper lock exists -> exit"
  exit 0
fi

trap cleanup EXIT

if [ ! -f "$QUEUE" ]; then
  log "queue file missing -> exit"
  exit 0
fi

if [ ! -s "$QUEUE" ]; then
  log "queue empty -> exit"
  exit 0
fi

log "check mqtt broker readiness"

if ! mosquitto_pub \
  -h "$MQTT_HOST" \
  -p "$MQTT_PORT" \
  -u "$MQTT_USER" \
  -P "$MQTT_PASS" \
  -t "healthcheck/garagepi/runtime_export" \
  -m "$(ts)" \
  -q 0 >/dev/null 2>&1
then
  log "mqtt not ready or not authorised -> exit without consuming queue"
  exit 0
fi

log "mqtt ready -> start draining queue"

loop_count=0

while true; do
  loop_count=$((loop_count + 1))

  if [ "$loop_count" -gt "$MAX_LOOPS" ]; then
    log "max loops reached ($MAX_LOOPS) -> exit"
    exit 0
  fi

  if [ ! -f "$QUEUE" ] || [ ! -s "$QUEUE" ]; then
    log "queue drained -> exit"
    exit 0
  fi

  before_lines="$(wc -l < "$QUEUE" 2>/dev/null || echo 0)"

  if [ "$before_lines" -le 0 ]; then
    log "queue drained -> exit"
    exit 0
  fi

  log "run exporter loop=$loop_count queue_lines_before=$before_lines"

  if ! node "$EXPORTER"; then
    log "exporter returned error -> stop loop"
    exit 1
  fi

  after_lines="$(wc -l < "$QUEUE" 2>/dev/null || echo 0)"

  if [ "$after_lines" -ge "$before_lines" ]; then
    log "queue did not shrink (before=$before_lines after=$after_lines) -> stop loop"
    exit 0
  fi

  sleep "$SLEEP_BETWEEN_LOOPS"
done
