#!/bin/bash
set -e

# Configuration
SERVER="root@134.199.180.251"
ADMIN_SSH_PORT="22022"
DEPLOY_DIR="/opt/maldoror"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "=== Maldoror Deploy Script ==="
echo "Server: $SERVER"
echo "Deploy dir: $DEPLOY_DIR"
echo ""

# Check for active image generations before deploying
# This prevents wasting OpenAI credits by restarting mid-generation
STATS_URL="http://134.199.180.251:3000/operations"
echo ">>> Checking for active image generations..."
OPERATIONS_JSON=$(curl -s --connect-timeout 5 "$STATS_URL" 2>/dev/null || echo '{"error":"unreachable"}')

if echo "$OPERATIONS_JSON" | grep -q '"error"'; then
    echo "    Server unreachable (first deploy or server down) - proceeding"
elif echo "$OPERATIONS_JSON" | grep -q '"safe_to_deploy":false'; then
    ACTIVE_OPS=$(echo "$OPERATIONS_JSON" | grep -o '"active_operations":\[[^]]*\]' || echo "unknown")
    echo ""
    echo "!!! WARNING: Active image generations in progress !!!"
    echo "    $ACTIVE_OPS"
    echo ""
    echo "    Deploying now will waste OpenAI credits."
    echo "    Wait for generations to complete or use --force to override."
    echo ""
    if [ "$1" != "--force" ]; then
        echo "Aborting deploy. Use 'deploy.sh --force' to override."
        exit 1
    else
        echo "    --force flag used, proceeding anyway..."
    fi
else
    echo "    No active generations - safe to deploy"
fi
echo ""

# Check for .env.prod file
if [ ! -f "$PROJECT_ROOT/deploy/.env.prod" ]; then
    echo "ERROR: deploy/.env.prod not found!"
    echo "Create it with:"
    echo "  POSTGRES_PASSWORD=your_secure_password"
    echo "  AI_PROVIDER=openai"
    echo "  OPENAI_API_KEY=your_key"
    exit 1
fi

# Function to run SSH commands (handles port change)
ssh_cmd() {
    # Try admin port first, then fallback to default
    ssh -o ConnectTimeout=5 -p $ADMIN_SSH_PORT $SERVER "$@" 2>/dev/null || \
    ssh -o ConnectTimeout=5 $SERVER "$@"
}

echo ">>> Checking/Moving system SSH to port $ADMIN_SSH_PORT..."
ssh $SERVER "
    if ! grep -q 'Port $ADMIN_SSH_PORT' /etc/ssh/sshd_config; then
        echo 'Moving SSH to port $ADMIN_SSH_PORT...'
        sed -i 's/^#*Port .*/Port $ADMIN_SSH_PORT/' /etc/ssh/sshd_config
        if ! grep -q 'Port $ADMIN_SSH_PORT' /etc/ssh/sshd_config; then
            echo 'Port $ADMIN_SSH_PORT' >> /etc/ssh/sshd_config
        fi
    fi
    # Restart SSH with socket (Ubuntu uses ssh.socket)
    systemctl daemon-reload
    systemctl stop ssh.socket 2>/dev/null || true
    systemctl restart ssh
    echo 'SSH configured on port $ADMIN_SSH_PORT'
" || true

# Wait a moment for SSH to restart
sleep 2

echo ">>> Installing Docker on server (if needed)..."
ssh_cmd 'which docker || (apt-get update && apt-get install -y docker.io docker-compose-v2 && systemctl enable docker && systemctl start docker)'

echo ">>> Creating deploy directory..."
ssh_cmd "mkdir -p $DEPLOY_DIR"

echo ">>> Syncing project files..."
# Use the admin port for rsync
rsync -avz --delete \
    -e "ssh -p $ADMIN_SSH_PORT" \
    --exclude 'node_modules' \
    --exclude '.git' \
    --exclude 'dist' \
    --exclude '.env' \
    --exclude '.env.local' \
    --exclude 'deploy/.env.prod' \
    "$PROJECT_ROOT/" "$SERVER:$DEPLOY_DIR/" 2>/dev/null || \
rsync -avz --delete \
    --exclude 'node_modules' \
    --exclude '.git' \
    --exclude 'dist' \
    --exclude '.env' \
    --exclude '.env.local' \
    --exclude 'deploy/.env.prod' \
    "$PROJECT_ROOT/" "$SERVER:$DEPLOY_DIR/"

echo ">>> Copying production env file..."
scp -P $ADMIN_SSH_PORT "$PROJECT_ROOT/deploy/.env.prod" "$SERVER:$DEPLOY_DIR/.env" 2>/dev/null || \
scp "$PROJECT_ROOT/deploy/.env.prod" "$SERVER:$DEPLOY_DIR/.env"

echo ">>> Fixing file permissions..."
ssh_cmd "chmod 644 $DEPLOY_DIR/deploy/haproxy.cfg"

echo ">>> Generating version..."
"$PROJECT_ROOT/apps/ssh-world/scripts/generate-version.sh"

echo ">>> Building locally for dist sync..."
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

echo ">>> Syncing dist directories..."
rsync -avz --delete -e "ssh -p $ADMIN_SSH_PORT" "$PROJECT_ROOT/apps/ssh-world/dist/" "$SERVER:$DEPLOY_DIR/apps/ssh-world/dist/"
# Sync version.json AFTER dist (so --delete doesn't remove it)
rsync -avz -e "ssh -p $ADMIN_SSH_PORT" "$PROJECT_ROOT/apps/ssh-world/src/version.json" "$SERVER:$DEPLOY_DIR/apps/ssh-world/dist/"
rsync -avz --delete -e "ssh -p $ADMIN_SSH_PORT" "$PROJECT_ROOT/packages/ai/dist/" "$SERVER:$DEPLOY_DIR/packages/ai/dist/"
rsync -avz --delete -e "ssh -p $ADMIN_SSH_PORT" "$PROJECT_ROOT/packages/db/dist/" "$SERVER:$DEPLOY_DIR/packages/db/dist/"
rsync -avz --delete -e "ssh -p $ADMIN_SSH_PORT" "$PROJECT_ROOT/packages/protocol/dist/" "$SERVER:$DEPLOY_DIR/packages/protocol/dist/"
rsync -avz --delete -e "ssh -p $ADMIN_SSH_PORT" "$PROJECT_ROOT/packages/queue/dist/" "$SERVER:$DEPLOY_DIR/packages/queue/dist/"
rsync -avz --delete -e "ssh -p $ADMIN_SSH_PORT" "$PROJECT_ROOT/packages/render/dist/" "$SERVER:$DEPLOY_DIR/packages/render/dist/"
rsync -avz --delete -e "ssh -p $ADMIN_SSH_PORT" "$PROJECT_ROOT/packages/world/dist/" "$SERVER:$DEPLOY_DIR/packages/world/dist/"

echo ">>> Checking if this is first deploy..."
POSTGRES_RUNNING=$(ssh_cmd "docker ps --filter name=deploy-postgres -q" 2>/dev/null || echo "")

if [ -z "$POSTGRES_RUNNING" ]; then
    echo ">>> First deploy - starting all containers..."
    ssh_cmd "cd $DEPLOY_DIR && docker compose -f deploy/docker-compose.prod.yml up -d --build"
else
    echo ">>> Postgres running - only rebuilding ssh-world and haproxy..."
    ssh_cmd "cd $DEPLOY_DIR && docker compose -f deploy/docker-compose.prod.yml build ssh-world"
    ssh_cmd "cd $DEPLOY_DIR && docker compose -f deploy/docker-compose.prod.yml up -d --no-recreate postgres"
    ssh_cmd "cd $DEPLOY_DIR && docker compose -f deploy/docker-compose.prod.yml up -d ssh-world haproxy"
fi

echo ">>> Waiting for services to start..."
sleep 15

echo ">>> Checking service status..."
ssh_cmd "cd $DEPLOY_DIR && docker compose -f deploy/docker-compose.prod.yml ps"

echo ""
echo "=== Deploy Complete ==="
echo ""
echo "Game SSH:  ssh abyss.maldoror.dev"
echo "Admin SSH: ssh -p $ADMIN_SSH_PORT root@134.199.180.251"
echo "Stats:     http://134.199.180.251:8404/stats"
echo ""
echo "For future deploys without disconnecting users:"
echo "  pnpm deploy:hot"
