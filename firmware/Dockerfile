FROM python:3.12-slim AS builder

RUN apt-get update && \
    apt-get install -y --no-install-recommends git && \
    rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir platformio

WORKDIR /firmware

# Copy only dependency config first (cached layer for pio pkg install)
COPY platformio.ini partitions.csv lv_conf.h ./

# Install PlatformIO platform + libraries (cached unless platformio.ini changes)
RUN pio pkg install

# Copy source files (only this layer rebuilds on source changes)
COPY src/ src/

# Build firmware
RUN pio run -e esp32s3-display

# Output stage - just the binaries
FROM scratch AS export
COPY --from=builder /firmware/.pio/build/esp32s3-display/bootloader.bin /bootloader.bin
COPY --from=builder /firmware/.pio/build/esp32s3-display/partitions.bin /partitions.bin
COPY --from=builder /firmware/.pio/build/esp32s3-display/firmware.bin /firmware.bin
