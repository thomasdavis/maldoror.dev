#!/bin/sh
set -e

echo "Starting Maldoror SSH World..."

# Set Node.js memory limit (5.5GB heap - leave room for container overhead)
# Enable GC exposure for better memory management
export NODE_OPTIONS="--max-old-space-size=5632 --expose-gc"

# Generate SSH host key if it doesn't exist
if [ ! -f "$SSH_HOST_KEY_PATH" ]; then
  echo "Generating SSH host key..."
  ssh-keygen -t ed25519 -f "$SSH_HOST_KEY_PATH" -N ""
  echo "SSH host key generated at $SSH_HOST_KEY_PATH"
fi

# Run database migrations/push (--force skips interactive confirmation)
echo "Initializing database schema..."
cd /app/packages/db && npx drizzle-kit push --force
cd /app

# Start the SSH server
# Using exec node directly so Node.js becomes PID 1 and receives signals (for hot-reload)
echo "Starting SSH server..."
cd /app/apps/ssh-world
exec node dist/index.js
