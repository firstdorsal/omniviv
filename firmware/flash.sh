#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${1:-/dev/ttyACM0}"

if [ ! -e "$PORT" ]; then
    echo "ERROR: Serial port $PORT not found"
    echo "Available ports:"
    ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null || echo "  (none)"
    echo ""
    echo "Usage: bash flash.sh [port]"
    exit 1
fi

echo "=== Flashing Omniviv Firmware via PlatformIO ==="
echo "Port: $PORT"
echo ""

docker run --rm \
    --device="$PORT:$PORT" \
    -v "$SCRIPT_DIR:/firmware" \
    -w /firmware \
    python:3.12-slim \
    bash -c "
        apt-get update -qq && apt-get install -y -qq --no-install-recommends git >/dev/null 2>&1 && \
        pip install --no-cache-dir -q platformio && \
        pio pkg install && \
        pio run -e esp32s3-display -t upload --upload-port $PORT
    "

echo ""
echo "=== Flash complete ==="
echo "Device will reboot automatically."
