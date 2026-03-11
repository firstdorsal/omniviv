#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
OUTPUT_DIR="$PROJECT_ROOT/web/public/firmware"
FIRMWARE_VERSION="0.1.0"

echo "=== Building Omniviv Departure Board Firmware v${FIRMWARE_VERSION} ==="

# Build firmware in Docker
echo "Building firmware in Docker..."
docker build \
    --target export \
    --output "type=local,dest=$OUTPUT_DIR" \
    "$SCRIPT_DIR"

# Verify output files exist
for f in bootloader.bin partitions.bin firmware.bin; do
    if [ ! -f "$OUTPUT_DIR/$f" ]; then
        echo "ERROR: Missing output file: $f"
        exit 1
    fi
    echo "  $f: $(wc -c < "$OUTPUT_DIR/$f") bytes"
done

# Generate manifest.json
# Config partition offset: 0x410000 = 4259840
cat > "$OUTPUT_DIR/manifest.json" << EOF
{
  "version": "${FIRMWARE_VERSION}",
  "board": "VIEWE-UEDX24320024E-WB-A",
  "description": "Omniviv Departure Board",
  "configOffset": 4259840,
  "files": [
    { "name": "bootloader.bin", "offset": 0 },
    { "name": "partitions.bin", "offset": 32768 },
    { "name": "firmware.bin", "offset": 65536 }
  ]
}
EOF

echo "=== Build complete ==="
echo "Output in: $OUTPUT_DIR"
echo "Manifest: $OUTPUT_DIR/manifest.json"
