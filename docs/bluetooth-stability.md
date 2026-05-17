# Bluetooth Stability Notes

## Antenna orientation matters

For Marstek / Hame B2500 batteries,
BLE signal quality is heavily affected by device orientation.

Best observed signal:
- near the physical power button side

Likely observation:
- internal BLE antenna appears to be located
  near the power button area.

## Important installation recommendation

Orient the battery so that:
- the power-button side faces the BLE adapter
- line-of-sight is preferred
- metal obstacles are minimized

## RSSI observations

Reliable long-term polling typically required:

-70 dBm or better

Observed behavior below this threshold:
- connection instability
- increased reconnects
- BLE timeouts
- watchdog recovery loops
- partial polling failures

## Recommendations

Recommended:
- dedicated external BLE adapter
- short distance
- clear antenna orientation
- stable power supply
- Raspberry Pi 5 preferred

Not recommended:
- hidden behind metal objects
- weak RSSI links
- Pi Zero 2 W with heavy USB load
