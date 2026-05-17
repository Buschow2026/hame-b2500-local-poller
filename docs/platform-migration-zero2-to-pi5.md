# Platform Migration: Pi Zero 2 W to Pi 5

## Initial architecture

Initial development started on a Raspberry Pi Zero 2 W using:
- USB Ethernet
- USB BLE adapter
- USB storage / backup activity

## Problems observed

Long-term operation revealed:
- BLE instability
- USB bus contention
- Ethernet disconnects
- split-brain states
- watchdog recovery loops

Especially problematic during:
- backup jobs
- rpi-clone
- USB resets
- BLE recovery operations

## Root cause analysis

The primary issue appeared to be USB bus contention and instability
under combined BLE + Ethernet + storage load.

## Migration

The polling infrastructure was migrated to a Raspberry Pi 5.

## Result

Observed improvements:
- stable 24/7 operation
- stable multi-device BLE polling
- stable watchdog recovery
- stable MQTT export
- reduced reconnect loops
