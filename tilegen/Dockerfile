ARG PROFILE="release"
ARG SERVICE_NAME="omniviv-tilegen"
ARG BINARY_NAME="omniviv-tilegen"

# ---- Rust build stage (same pattern as api/Dockerfile) ----
FROM clux/muslrust:nightly-2026-03-22@sha256:8292104d511d378fccd5ab62c4a7e0dd42c60ff6808a45d6eaea666097abd2cb AS chef-builder
RUN cargo install cargo-chef

FROM chef-builder AS planner
WORKDIR /build
COPY Cargo.toml Cargo.lock build.rs ./
COPY src src
RUN cargo chef prepare --recipe-path recipe.json

FROM chef-builder AS builder
ARG PROFILE
ARG BINARY_NAME
USER root
WORKDIR /build

RUN apt-get update && apt-get install -y upx

# Build dependencies (cached layer)
COPY --from=planner /build/recipe.json recipe.json
RUN if [ "${PROFILE}" = "release" ]; then \
        cargo chef cook --release --recipe-path recipe.json; \
    else \
        cargo chef cook --recipe-path recipe.json; \
    fi

# Build application
COPY Cargo.toml Cargo.lock build.rs ./
COPY src src

RUN cargo build --bin ${BINARY_NAME} --profile=${PROFILE}

RUN if [ "${PROFILE}" = "dev" ]; then \
        mv /build/target/x86_64-unknown-linux-musl/debug/${BINARY_NAME} /${BINARY_NAME}; \
    else \
        mv /build/target/x86_64-unknown-linux-musl/${PROFILE}/${BINARY_NAME} /${BINARY_NAME}; \
    fi

RUN if [ "${PROFILE}" = "release" ]; then strip /${BINARY_NAME}; fi
RUN if [ "${PROFILE}" = "release" ]; then upx --best --lzma /${BINARY_NAME}; fi

# ---- Minimal JRE via jlink (for Planetiler only) ----
FROM eclipse-temurin:21-jdk-alpine AS jre-builder
RUN jlink \
    --add-modules java.base,java.logging,java.sql,java.xml,java.desktop \
    --strip-debug --no-man-pages --no-header-files \
    --compress=zip-6 \
    --output /jre-minimal

# ---- Runtime stage ----
FROM alpine:3.21
ARG SERVICE_NAME
ARG BINARY_NAME

# Minimal JRE for Planetiler
COPY --from=jre-builder /jre-minimal /opt/java
ENV JAVA_HOME=/opt/java
ENV PATH="/opt/java/bin:$PATH"

# Planetiler JAR
ARG PLANETILER_VERSION=0.9.0
ADD https://github.com/onthegomap/planetiler/releases/download/v${PLANETILER_VERSION}/planetiler.jar /opt/planetiler.jar

# martin-cp for bulk transit tile generation
COPY --from=ghcr.io/maplibre/martin@sha256:b51c201d4b1a2128676fbe3c8f370dae74efa49b3f14f13a0b0248ffddfdea86 /usr/local/bin/martin-cp /usr/local/bin/martin-cp

# tilegen binary (statically linked via musl)
COPY --from=builder /${BINARY_NAME} /usr/local/bin/tilegen

# Non-root user
RUN adduser -D -u 50003 ${SERVICE_NAME} && \
    mkdir -p /tiles/basemap /tiles/transit /data && \
    chown -R ${SERVICE_NAME}:${SERVICE_NAME} /tiles /data

USER ${SERVICE_NAME}

ENV SERVICE_NAME=${SERVICE_NAME}

WORKDIR /app

STOPSIGNAL SIGTERM

# Run with the lowest possible CPU and I/O priority so tilegen never starves
# other workloads on the system. nice -n 19 = lowest CPU priority. ionice -c 3
# = idle I/O class (only runs when no other process needs I/O). Both nice and
# ionice from busybox propagate to all child processes (including martin-cp
# and Planetiler).
ENTRYPOINT ["nice", "-n", "19", "ionice", "-c", "3", "tilegen"]
