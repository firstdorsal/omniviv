#!/bin/bash
set -eo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$SCRIPT_DIR/../web"
OUTPUT_FILE="$WEB_DIR/src/api.ts"
OPENAPI_FILE="$(mktemp /tmp/openapi.XXXXXX.json)"

cleanup() {
    rm -f "$OPENAPI_FILE"
}

trap cleanup EXIT

echo -e "${GREEN}Building generate-openapi binary...${NC}"
cd "$SCRIPT_DIR"
cargo build --release --bin generate-openapi 2>&1 | tail -5

echo -e "${GREEN}Generating OpenAPI specification...${NC}"
./target/release/generate-openapi > "$OPENAPI_FILE"

if [ ! -s "$OPENAPI_FILE" ]; then
    echo -e "${RED}Failed to generate OpenAPI specification${NC}"
    exit 1
fi

# Save formatted copy to server directory
cp "$OPENAPI_FILE" "$SCRIPT_DIR/openapi.json"
echo -e "${GREEN}OpenAPI spec saved to: $SCRIPT_DIR/openapi.json${NC}"

echo -e "${GREEN}Generating TypeScript API client...${NC}"

# Create temporary directory for docker build
DOCKER_BUILD_DIR=$(mktemp -d)
cp "$OPENAPI_FILE" "$DOCKER_BUILD_DIR/openapi.json"

cat > "$DOCKER_BUILD_DIR/Dockerfile" << 'DOCKERFILE'
FROM node:23.9.0-alpine3.21@sha256:191433e4778ded9405c9fc981f963ad2062a8648b59a9bc97d7194f3d183b2b2
WORKDIR /app
RUN yarn add swagger-typescript-api
RUN echo "npx swagger-typescript-api generate -p ./openapi.json -o ./out/ -n api.ts" > gen.sh
ENTRYPOINT ["sh","gen.sh"]
DOCKERFILE

docker build -t omniviv-api-gen "$DOCKER_BUILD_DIR" -q

docker run --rm \
    -v "$DOCKER_BUILD_DIR/openapi.json:/app/openapi.json:ro" \
    -v "$WEB_DIR/src:/app/out" \
    omniviv-api-gen

rm -rf "$DOCKER_BUILD_DIR"

if [ -f "$OUTPUT_FILE" ]; then
    echo -e "${GREEN}Successfully generated: $OUTPUT_FILE${NC}"
    echo -e "${YELLOW}File size: $(wc -c < "$OUTPUT_FILE") bytes${NC}"
else
    echo -e "${RED}Failed to generate API client${NC}"
    exit 1
fi
