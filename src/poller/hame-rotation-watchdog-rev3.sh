#!/usr/bin/env bash
set -u

REV="REV3.2"
LOG="/opt/garagepi/logs/hame-rotation-watchdog-rev3.log"
LOCK="/run/hame-rotation-watchdog-rev3.lock"
SERVICE="hame-rotate-batch.service"

BROKER_HOST="192.168.1.100"
BROKER_PORT="1883"
MQTT_USER="mqtt"
MQTT_PASS="Felin1410"

MAX_AGE_SECONDS=300
HARD_AGE_SECONDS=900

WATCH_FILES=(
  "/opt/garagepi/state/hame_worker_receipt.json"
  "/opt/garagepi/state/rotate_state.json"
  "/opt/garagepi/logs/hame-runtime-export.log"
)

log() {
  echo "$(date '+%Y-%m-%dT%H:%M:%S%z') [$REV] $*" >> "$LOG"
}

age_of_file() {
  local f="$1"
  if [ ! -f "$f" ]; then
    echo 999999
    return
  fi
  echo $(($(date +%s) - $(stat -c %Y "$f" 2>/dev/null || echo 0)))
}

max_age() {
  local max=0
  local f age
  for f in "${WATCH_FILES[@]}"; do
    age="$(age_of_file "$f")"
    if [ "$age" -gt "$max" ]; then
      max="$age"
    fi
  done
  echo "$max"
}

mqtt_ready() {
  timeout 5 mosquitto_pub -h "$BROKER_HOST" -p "$BROKER_PORT" -u "$MQTT_USER" -P "$MQTT_PASS" -t "garagepi/watchdog/rev3/ping" -m "ping" >/dev/null 2>&1
}

service_active() {
  systemctl is-active --quiet "$SERVICE"
}

soft_restart() {
  log "ACTION soft_restart"
  timeout 20 systemctl restart "$SERVICE" || true
}

ble_recycle() {
  log "ACTION ble_recycle begin"
  timeout 20 systemctl stop "$SERVICE" || true
  pkill -f hame-poll-once.js || true
  pkill -f hame-rotate-batch.js || true
  sleep 3
  timeout 20 systemctl restart bluetooth || true
  rfkill unblock bluetooth || true

  for dev in $(hciconfig 2>/dev/null | awk -F: '/^hci[0-9]+:/ {print $1}'); do
    log "BLE recycle device=$dev"
    hciconfig "$dev" down || true
    sleep 1
    hciconfig "$dev" up || true
    sleep 1
    hciconfig "$dev" reset || true
  done

  sleep 3
  timeout 20 systemctl start "$SERVICE" || true
  log "ACTION ble_recycle end"
}

main() {
  exec 9>"$LOCK"
  flock -n 9 || exit 0

  log "CHECK begin"

  local age
  age="$(max_age)"
  log "STATE max_age_s=$age"

  if mqtt_ready; then
    log "STATE mqtt_ready=yes"
  else
    log "STATE mqtt_ready=no"
  fi

  if ! service_active; then
    log "STATE service_active=no"
    soft_restart
    exit 0
  fi

  log "STATE service_active=yes"

  if [ "$age" -le "$MAX_AGE_SECONDS" ]; then
    log "HEARTBEAT healthy max_age_s=$age"
    log "OK healthy"
    exit 0
  fi

  log "WARN stale -> soft_restart"
  soft_restart
  sleep 60

  age="$(max_age)"
  log "POST soft_restart max_age_s=$age"

  if [ "$age" -le "$MAX_AGE_SECONDS" ]; then
    log "RECOVERED soft_restart"
    exit 0
  fi

  if [ "$age" -ge "$HARD_AGE_SECONDS" ]; then
    log "WARN hard stale -> ble_recycle"
    ble_recycle
    sleep 90

    age="$(max_age)"
    log "POST ble_recycle max_age_s=$age"

    if [ "$age" -le "$MAX_AGE_SECONDS" ]; then
      log "RECOVERED ble_recycle"
      exit 0
    fi

    log "FAIL unrecovered"
    exit 2
  fi

  exit 1
}

main "$@"#!/usr/bin/env bash
set -u

REV="REV3.2"
LOG="/opt/garagepi/logs/hame-rotation-watchdog-rev3.log"
LOCK="/run/hame-rotation-watchdog-rev3.lock"
SERVICE="hame-rotate-batch.service"

BROKER_HOST="192.168.1.100"
BROKER_PORT="1883"
MQTT_USER="mqtt"
MQTT_PASS="Felin1410"

MAX_AGE_SECONDS=300
HARD_AGE_SECONDS=900

WATCH_FILES=(
  "/opt/garagepi/state/hame_worker_receipt.json"
  "/opt/garagepi/state/rotate_state.json"
  "/opt/garagepi/logs/hame-runtime-export.log"
)

log() {
  echo "$(date '+%Y-%m-%dT%H:%M:%S%z') [$REV] $*" >> "$LOG"
}

age_of_file() {
  local f="$1"
  if [ ! -f "$f" ]; then
    echo 999999
    return
  fi
  echo $(($(date +%s) - $(stat -c %Y "$f" 2>/dev/null || echo 0)))
}

max_age() {
  local max=0
  local f age
  for f in "${WATCH_FILES[@]}"; do
    age="$(age_of_file "$f")"
    if [ "$age" -gt "$max" ]; then
      max="$age"
    fi
  done
  echo "$max"
}

mqtt_ready() {
  timeout 5 mosquitto_pub -h "$BROKER_HOST" -p "$BROKER_PORT" -u "$MQTT_USER" -P "$MQTT_PASS" -t "garagepi/watchdog/rev3/ping" -m "ping" >/dev/null 2>&1
}

service_active() {
  systemctl is-active --quiet "$SERVICE"
}

soft_restart() {
  log "ACTION soft_restart"
  timeout 20 systemctl restart "$SERVICE" || true
}

ble_recycle() {
  log "ACTION ble_recycle begin"
  timeout 20 systemctl stop "$SERVICE" || true
  pkill -f hame-poll-once.js || true
  pkill -f hame-rotate-batch.js || true
  sleep 3
  timeout 20 systemctl restart bluetooth || true
  rfkill unblock bluetooth || true

  for dev in $(hciconfig 2>/dev/null | awk -F: '/^hci[0-9]+:/ {print $1}'); do
    log "BLE recycle device=$dev"
    hciconfig "$dev" down || true
    sleep 1
    hciconfig "$dev" up || true
    sleep 1
    hciconfig "$dev" reset || true
  done

  sleep 3
  timeout 20 systemctl start "$SERVICE" || true
  log "ACTION ble_recycle end"
}

main() {
  exec 9>"$LOCK"
  flock -n 9 || exit 0

  log "CHECK begin"

  local age
  age="$(max_age)"
  log "STATE max_age_s=$age"

  if mqtt_ready; then
    log "STATE mqtt_ready=yes"
  else
    log "STATE mqtt_ready=no"
  fi

  if ! service_active; then
    log "STATE service_active=no"
    soft_restart
    exit 0
  fi

  log "STATE service_active=yes"

  if [ "$age" -le "$MAX_AGE_SECONDS" ]; then
    log "HEARTBEAT healthy max_age_s=$age"
    log "OK healthy"
    exit 0
  fi

  log "WARN stale -> soft_restart"
  soft_restart
  sleep 60

  age="$(max_age)"
  log "POST soft_restart max_age_s=$age"

  if [ "$age" -le "$MAX_AGE_SECONDS" ]; then
    log "RECOVERED soft_restart"
    exit 0
  fi

  if [ "$age" -ge "$HARD_AGE_SECONDS" ]; then
    log "WARN hard stale -> ble_recycle"
    ble_recycle
    sleep 90

    age="$(max_age)"
    log "POST ble_recycle max_age_s=$age"

    if [ "$age" -le "$MAX_AGE_SECONDS" ]; then
      log "RECOVERED ble_recycle"
      exit 0
    fi

    log "FAIL unrecovered"
    exit 2
  fi

  exit 1
}

main "$@"
