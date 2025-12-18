#!/bin/sh
set -e

echo "Starting Maldoror SSH World..."

# Set Node.js memory limit to prevent OOM crashes (512MB heap)
export NODE_OPTIONS="--max-old-space-size=512"

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
echo "Starting SSH server..."
exec pnpm --filter @maldoror/ssh-world start
