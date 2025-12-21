#!/bin/bash
set -e

# Hot Reload Script
# Updates code and triggers hot reload WITHOUT disconnecting users

SERVER="root@134.199.180.251"
ADMIN_SSH_PORT="22022"
DEPLOY_DIR="/opt/maldoror"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Maldoror Hot Reload ==="
echo "Server: $SERVER"
echo ""

# Function to run SSH commands
ssh_cmd() {
    ssh -o ConnectTimeout=5 -p $ADMIN_SSH_PORT $SERVER "$@"
}

# Generate version info (git hash + timestamp)
echo ">>> Generating version..."
"$PROJECT_ROOT/apps/ssh-world/scripts/generate-version.sh"

# Build locally first
echo ">>> Building locally..."
cd "$PROJECT_ROOT"
pnpm build

# Rebuild db package with tsup (required for ESM compatibility in production)
echo ">>> Rebuilding db package with tsup..."
cd "$PROJECT_ROOT/packages/db"
npx tsup src/index.ts src/schema/index.ts \
    --format esm \
    --dts \
    --clean \
    --external drizzle-orm \
    --external pg \
    --external @maldoror/protocol
cd "$PROJECT_ROOT"

echo ">>> Syncing dist files to server..."
# Sync all dist directories
rsync -avz --delete \
    -e "ssh -p $ADMIN_SSH_PORT" \
    "$PROJECT_ROOT/apps/ssh-world/dist/" "$SERVER:$DEPLOY_DIR/apps/ssh-world/dist/"

# Sync version.json AFTER dist (so --delete doesn't remove it)
rsync -avz \
    -e "ssh -p $ADMIN_SSH_PORT" \
    "$PROJECT_ROOT/apps/ssh-world/src/version.json" "$SERVER:$DEPLOY_DIR/apps/ssh-world/dist/"

rsync -avz --delete \
    -e "ssh -p $ADMIN_SSH_PORT" \
    "$PROJECT_ROOT/packages/ai/dist/" "$SERVER:$DEPLOY_DIR/packages/ai/dist/"

rsync -avz --delete \
    -e "ssh -p $ADMIN_SSH_PORT" \
    "$PROJECT_ROOT/packages/db/dist/" "$SERVER:$DEPLOY_DIR/packages/db/dist/"

rsync -avz --delete \
    -e "ssh -p $ADMIN_SSH_PORT" \
    "$PROJECT_ROOT/packages/protocol/dist/" "$SERVER:$DEPLOY_DIR/packages/protocol/dist/"

rsync -avz --delete \
    -e "ssh -p $ADMIN_SSH_PORT" \
    "$PROJECT_ROOT/packages/queue/dist/" "$SERVER:$DEPLOY_DIR/packages/queue/dist/"

rsync -avz --delete \
    -e "ssh -p $ADMIN_SSH_PORT" \
    "$PROJECT_ROOT/packages/render/dist/" "$SERVER:$DEPLOY_DIR/packages/render/dist/"

rsync -avz --delete \
    -e "ssh -p $ADMIN_SSH_PORT" \
    "$PROJECT_ROOT/packages/world/dist/" "$SERVER:$DEPLOY_DIR/packages/world/dist/"

echo ">>> Triggering hot reload..."
# Get the PID of the node process inside the container and send SIGUSR1
ssh_cmd "docker exec deploy-ssh-world-1 sh -c 'kill -USR1 1'"

echo ""
echo "=== Hot Reload Complete ==="
echo "Connected users should see 'Updating Server...' briefly then continue playing"
