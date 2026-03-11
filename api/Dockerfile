ARG PROFILE="release"
ARG SERVICE_NAME="omniviv-api"
ARG SERVICE_VERSION="0.1.0"
ARG BINARY_NAME="omniviv-api"

FROM clux/muslrust:nightly AS chef-builder
RUN cargo install cargo-chef

FROM chef-builder AS planner
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY build.rs ./
COPY src src
COPY proto proto
RUN cargo chef prepare --recipe-path recipe.json

FROM chef-builder AS builder
ARG PROFILE
ARG BINARY_NAME
ARG SERVICE_NAME
USER root
WORKDIR /build

# Install protobuf-compiler (pinning causes dependency issues with security updates)
RUN apt-get update && apt-get install -y upx protobuf-compiler

# Build dependencies (cached layer)
COPY --from=planner /build/recipe.json recipe.json
RUN if [ "${PROFILE}" = "release" ]; then \
        cargo chef cook --release --recipe-path recipe.json; \
    else \
        cargo chef cook --recipe-path recipe.json; \
    fi

# Build application
COPY Cargo.toml Cargo.lock ./
COPY build.rs ./
COPY src src
COPY proto proto
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
FROM busybox:musl AS busybox

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
