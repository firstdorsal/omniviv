# 0. build stage


FROM node:23-alpine3.19 AS build-stage
WORKDIR /build
RUN npm install -g pnpm@9.15.9

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Get static wget for health checks
FROM busybox:musl AS busybox

# 1. execution stage
FROM pektin/feoco@sha256:834eba9e93f482f40dba38db0fe09207ab55f61fda5934a078f6f0b208c7a42a
COPY --from=build-stage /build/dist/ /public/
COPY --from=busybox /bin/wget /wget
COPY server/config.yml /
