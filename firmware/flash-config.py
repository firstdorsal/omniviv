#!/usr/bin/env python3
"""Flash device configuration to ESP32-S3 config partition.

Prompts interactively for WiFi credentials, API URL, and stop IFOPT,
then writes them to the config partition at offset 0x410000.

Usage:
    python3 flash-config.py [--port /dev/ttyACM0]
"""

import argparse
import getpass
import json
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

CONFIG_OFFSET = 0x410000
CONFIG_SIZE = 4096
MAGIC = b"OMNI"


def build_config_blob(ssid: str, password: str, api_url: str, stop_ifopt: str) -> bytes:
    payload = json.dumps({
        "wifi_ssid": ssid,
        "wifi_password": password,
        "api_url": api_url,
        "stop_ifopt": stop_ifopt,
    }, separators=(",", ":"))

    payload_bytes = payload.encode("utf-8")
    if len(payload_bytes) > CONFIG_SIZE - 8:
        print(f"Error: config JSON too large ({len(payload_bytes)} bytes, max {CONFIG_SIZE - 8})")
        sys.exit(1)

    blob = bytearray(b"\xFF" * CONFIG_SIZE)
    blob[0:4] = MAGIC
    struct.pack_into("<I", blob, 4, len(payload_bytes))
    blob[8 : 8 + len(payload_bytes)] = payload_bytes
    return bytes(blob)


def find_port() -> str:
    import glob
    candidates = glob.glob("/dev/ttyACM*") + glob.glob("/dev/ttyUSB*")
    if len(candidates) == 1:
        return candidates[0]
    if len(candidates) > 1:
        print("Multiple serial ports found:")
        for i, p in enumerate(candidates):
            print(f"  [{i}] {p}")
        choice = input("Select port number: ").strip()
        return candidates[int(choice)]
    print("Error: no serial port found. Connect the device and try again,")
    print("or specify the port with --port /dev/ttyACM0")
    sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Flash device configuration")
    parser.add_argument("--port", help="Serial port (auto-detected if omitted)")
    parser.add_argument("--baud", type=int, default=921600, help="Baud rate (default: 921600)")
    args = parser.parse_args()

    print("=== Omniviv Device Config Flasher ===\n")

    ssid = input("WiFi SSID: ").strip()
    if not ssid:
        print("Error: SSID cannot be empty")
        sys.exit(1)

    password = getpass.getpass("WiFi Password: ")
    if not password:
        print("Error: password cannot be empty")
        sys.exit(1)

    api_url = input("API URL [http://10.0.0.20]: ").strip() or "http://10.0.0.20"
    stop_ifopt = input("Stop IFOPT [de:09761:114:0:B]: ").strip() or "de:09761:114:0:B"

    print(f"\nConfig summary:")
    print(f"  SSID:       {ssid}")
    print(f"  Password:   {'*' * len(password)}")
    print(f"  API URL:    {api_url}")
    print(f"  Stop IFOPT: {stop_ifopt}")

    confirm = input("\nFlash this config? [Y/n]: ").strip().lower()
    if confirm and confirm != "y":
        print("Aborted.")
        sys.exit(0)

    blob = build_config_blob(ssid, password, api_url, stop_ifopt)

    port = args.port or find_port()
    print(f"\nUsing port: {port}")

    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as f:
        f.write(blob)
        tmp_path = f.name

    try:
        cmd = [
            "esptool.py",
            "--chip", "esp32s3",
            "--port", port,
            "--baud", str(args.baud),
            "write_flash",
            hex(CONFIG_OFFSET),
            tmp_path,
        ]
        print(f"Running: {' '.join(cmd)}\n")
        result = subprocess.run(cmd, check=False)
        if result.returncode != 0:
            print("\nesptool failed. Make sure esptool is installed (pip install esptool)")
            sys.exit(1)
        print("\nConfig flashed successfully! Reset the device to apply.")
    finally:
        Path(tmp_path).unlink(missing_ok=True)


if __name__ == "__main__":
    main()
