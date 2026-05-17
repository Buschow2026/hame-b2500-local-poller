# Architecture

## Purpose

This project provides a local GaragePi-based BLE polling stack for HAME / Marstek B2500 battery systems.

The goal is to:

- collect runtime data locally over BLE
- decode runtime frames
- publish operational values to MQTT
- integrate into Home Assistant
- avoid cloud dependency for runtime telemetry

## Credits / Prior Work

Special thanks to the hm2mqtt / hmjs ecosystem and related reverse engineering efforts.

Earlier community work significantly accelerated:

- BLE frame understanding
- protocol orientation
- runtime field mapping
- operational experimentation

This repository evolved into an independent local polling/runtime stack focused on:

- serial BLE polling
- GaragePi operation
- watchdog recovery
- MQTT export
- Home Assistant integration
- operational hardening

## Main Components

### Poller

Location:

src/poller

Responsible for:

- BLE scan
- device connect
- notification handling
- runtime collection
- recovery handling

### Parser

Location:

src/parser

Responsible for:

- decoding runtime frames
- translating binary payloads into structured values

### Runner

Location:

src/runner

Contains:

- connect tests
- discovery tests
- rotate helpers
- operational runners

### Runtime Export

Responsible for:

- MQTT publishing
- raw/decoded/runtime payload separation
- operational export

### UI

Location:

src/ui

Provides local GaragePi operational visibility.

### systemd

Location:

systemd

Contains services/timers/path units for production operation.

## Data Flow

HAME B2500
-> BLE
-> Poller
-> Parser
-> Runtime State
-> MQTT Export
-> Home Assistant

## Hardware Learnings

BLE stability depends heavily on:

- Raspberry Pi platform quality
- USB bus stability
- antenna orientation
- RSSI quality
- adapter placement
- distance to battery

Observed practical target:

- stable operation usually requires roughly better than -70 dBm RSSI

## Safety Rules

Never commit:

- real MQTT passwords
- real BLE MAC addresses
- real device IDs
- logs
- state/runtime dumps
- node_modules
- backup files
