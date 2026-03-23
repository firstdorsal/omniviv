# 0. build stage


FROM node:23-alpine3.19@sha256:4ebaf825598cb2f47eb2a52c4a0badf800681b49064e9cae73d3ae7a31a7ee44 AS build-stage
WORKDIR /build
RUN npm install -g pnpm@9.15.9

COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Get static wget for health checks
FROM busybox:musl@sha256:19b646668802469d968a05342a601e78da4322a414a7c09b1c9ee25165042138 AS busybox

# 1. execution stage
FROM pektin/feoco@sha256:834eba9e93f482f40dba38db0fe09207ab55f61fda5934a078f6f0b208c7a42a
COPY --from=build-stage /build/dist/ /public/
COPY --from=busybox /bin/wget /wget
COPY server/config.yml /
