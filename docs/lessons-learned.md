# Lessons Learned

## BLE stability is the real challenge

Parsing and MQTT are comparatively easy.

The primary challenge is maintaining stable long-term BLE communication
with multiple batteries simultaneously.

## Serial polling works better

Continuous permanent BLE connections proved unreliable.

Serial polling with reconnect/disconnect cycles was significantly more stable.

## Watchdogs are mandatory

BLE stacks can enter zombie or busy states.

Automatic recovery is required for long-term unattended operation.

## Recovery sometimes requires adapter resets

Restarting the poller process alone may not be sufficient.

Recovery may require:
- bluetooth.service restart
- btmgmt power off/on
- adapter reset

## Signal quality matters

Reliable operation required approximately:
-70 dBm or better
