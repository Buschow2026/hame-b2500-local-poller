# Hardware Lessons Learned

## Raspberry Pi Zero 2 W

NOT recommended for stable long-term multi-device BLE polling.

Observed problems:
- USB bus instability
- BLE dropouts
- Ethernet disconnects
- split-brain situations
- watchdog/recovery loops

Especially problematic during simultaneous:
- USB Ethernet
- USB BLE
- USB storage activity

Conclusion:
Possible for experimentation,
but not recommended for stable 24/7 operation.

---

## Raspberry Pi 5

Current recommended platform.

Observed improvements:
- stable BLE operation
- stable Ethernet
- improved USB handling
- stable multi-device polling
- stable watchdog recovery
- stable long-term continuous operation
