# HAME B2500 Local Poller

Local BLE/MQTT polling and operational lessons learned for HAME / Marstek B2500 battery systems.

## Contents

- BLE stability findings
- Hardware test results
- Migration notes from Pi Zero 2 to Raspberry Pi 5
- Operational lessons learned

## Repository Structure

/docs       Documentation and findings
/src        Source code
/scripts    Helper scripts
/systemd    systemd service files
/config     Configuration examples
/tools      Diagnostics and tooling

## Status

Documentation baseline initialized.

## Acknowledgements

Special thanks to the hm2mqtt / hmjs ecosystem and related community reverse engineering efforts.

Earlier work from the community significantly accelerated:

- BLE protocol orientation
- runtime frame understanding
- operational experimentation
- MQTT mapping ideas
- reverse engineering groundwork

This project evolved into an independent GaragePi-focused runtime stack with:

- serial BLE polling
- watchdog/recovery handling
- MQTT export
- Home Assistant integration
- operational hardening

The original groundwork from the community was extremely valuable and appreciated.

## Acknowledgements

Special thanks to the hm2mqtt / hmjs ecosystem and related community reverse engineering efforts.

Earlier work from the community significantly accelerated:

- BLE protocol orientation
- runtime frame understanding
- operational experimentation
- MQTT mapping ideas
- reverse engineering groundwork

This project evolved into an independent GaragePi-focused runtime stack with:

- serial BLE polling
- watchdog/recovery handling
- MQTT export
- Home Assistant integration
- operational hardening

The original groundwork from the community was extremely valuable and appreciated.

Additional tooling, documentation structuring, sanitization review, repository organization, and publishing preparation were assisted with OpenAI ChatGPT.

