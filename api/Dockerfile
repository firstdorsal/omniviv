ARG PROFILE="release"
ARG SERVICE_NAME="omniviv-api"
ARG SERVICE_VERSION="0.2.0"
ARG BINARY_NAME="omniviv-api"

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
ARG SERVICE_NAME
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
COPY migrations migrations

RUN cargo build --bin ${BINARY_NAME} --profile=${PROFILE}

RUN if [ "${PROFILE}" = "dev" ]; then \
        mv /build/target/x86_64-unknown-linux-musl/debug/${BINARY_NAME} /${BINARY_NAME}; \
    else \
        mv /build/target/x86_64-unknown-linux-musl/${PROFILE}/${BINARY_NAME} /${BINARY_NAME}; \
    fi

RUN if [ "${PROFILE}" = "release" ]; then strip /${BINARY_NAME}; fi
RUN if [ "${PROFILE}" = "release" ]; then upx --best --lzma /${BINARY_NAME}; fi

RUN useradd -u 50003 -N ${SERVICE_NAME}

# Create data directories with correct ownership
RUN mkdir -p /app/data/gtfs && chown -R ${SERVICE_NAME}:users /app/data

# Get static wget for health checks
FROM busybox:musl@sha256:19b646668802469d968a05342a601e78da4322a414a7c09b1c9ee25165042138 AS busybox

# Final stage
FROM scratch
ARG SERVICE_NAME
ARG SERVICE_VERSION
ARG BINARY_NAME

WORKDIR /app

COPY --from=builder /${BINARY_NAME} ./api
COPY --from=builder /etc/passwd /etc/passwd
COPY --from=busybox /bin/wget /wget
COPY --from=builder --chown=50003:users /app/data /app/data
COPY migrations migrations
COPY static static

USER ${SERVICE_NAME}

ENV SERVICE_NAME=${SERVICE_NAME}
ENV SERVICE_VERSION=${SERVICE_VERSION}

EXPOSE 3000

STOPSIGNAL SIGTERM
ENTRYPOINT ["./api"]
