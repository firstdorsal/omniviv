#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$SCRIPT_DIR/../web"
OUTPUT_FILE="$WEB_DIR/src/api.ts"
OPENAPI_FILE="/tmp/openapi.json"
SERVER_PORT=3000
SERVER_PID=""

cleanup() {
    if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
        echo -e "${YELLOW}Stopping server (PID: $SERVER_PID)...${NC}"
        kill "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    rm -f "$OPENAPI_FILE"
}

trap cleanup EXIT

echo -e "${GREEN}Building server...${NC}"
cd "$SCRIPT_DIR"
cargo build --release 2>&1 | tail -5

echo -e "${GREEN}Starting server temporarily...${NC}"
./target/release/omniviv-api &
SERVER_PID=$!

# Wait for server to be ready
echo -e "${YELLOW}Waiting for server to start...${NC}"
MAX_ATTEMPTS=30
ATTEMPT=0
while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    if curl -s "http://localhost:$SERVER_PORT/api-docs/openapi.json" > /dev/null 2>&1; then
        echo -e "${GREEN}Server is ready!${NC}"
        break
    fi
    ATTEMPT=$((ATTEMPT + 1))
    sleep 1
done

if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
    echo -e "${RED}Server failed to start within ${MAX_ATTEMPTS} seconds${NC}"
    exit 1
fi

echo -e "${GREEN}Fetching OpenAPI specification...${NC}"
curl -s "http://localhost:$SERVER_PORT/api-docs/openapi.json" | jq . > "$OPENAPI_FILE"

if [ ! -s "$OPENAPI_FILE" ]; then
    echo -e "${RED}Failed to fetch OpenAPI specification${NC}"
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
