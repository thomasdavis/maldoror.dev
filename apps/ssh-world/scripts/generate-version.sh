#!/bin/bash
# Generate version.json with git commit hash and build timestamp

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUTPUT_FILE="$SCRIPT_DIR/../src/version.json"

# Get git commit hash (short form)
GIT_HASH=$(git rev-parse --short HEAD 2>/dev/null || echo "dev")

# Get build timestamp
BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Create version.json
cat > "$OUTPUT_FILE" << EOF
{
  "hash": "$GIT_HASH",
  "buildTime": "$BUILD_TIME",
  "version": "v$GIT_HASH"
}
EOF

echo "Generated version.json: v$GIT_HASH"
