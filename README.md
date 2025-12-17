# Maldoror

A terminal-based MMO accessible via SSH. Connect and explore a procedurally generated world with AI-generated avatars.

```
ssh abyss.maldoror.dev
```

## Project Structure

```
maldoror.dev/
├── apps/
│   └── ssh-world/        # SSH server application
├── packages/
│   ├── ai/               # AI avatar generation
│   ├── db/               # Database schema (Drizzle + Postgres)
│   ├── protocol/         # Shared types
│   ├── render/           # Terminal rendering
│   ├── world/            # Procedural world generation
│   └── queue/            # Background job processing
└── deploy/               # Deployment configuration
```

## Local Development

### Prerequisites

- Node.js 20+
- pnpm 9.15+
- Docker (for PostgreSQL)

### Setup

```bash
# Install dependencies
pnpm install

# Start PostgreSQL
pnpm docker:up

# Push database schema
pnpm db:push

# Generate SSH host key
cd apps/ssh-world && pnpm generate-keys && cd ../..

# Start development server
pnpm dev:ssh
```

### Connect locally

```bash
ssh -p 2222 localhost
```

## Deployment

### DigitalOcean / VPS Deployment

The project includes a deploy script for Docker-based deployment to any VPS.

#### Prerequisites

- A VPS with SSH access (Ubuntu recommended)
- Your SSH key added to the server
- A domain pointing to your server IP (optional)

#### Configuration

1. Create the production environment file:

```bash
cp deploy/.env.prod.example deploy/.env.prod
```

2. Edit `deploy/.env.prod` with your credentials:

```env
POSTGRES_PASSWORD=your_secure_password
AI_PROVIDER=openai
OPENAI_API_KEY=sk-your-key-here
AI_MODEL=gpt-4.1-mini
```

Or for Anthropic:

```env
POSTGRES_PASSWORD=your_secure_password
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-your-key-here
AI_MODEL=claude-sonnet-4-20250514
```

3. Update the server IP in `deploy/deploy.sh` if needed:

```bash
SERVER="root@your-server-ip"
```

#### Deploy

```bash
./deploy/deploy.sh
```

This will:
- Move system SSH to port 22022 (first deploy only)
- Install Docker on the server (if needed)
- Sync project files via rsync
- Build the Docker image
- Start HAProxy, PostgreSQL, and the SSH server
- Initialize the database schema

#### Connect

```bash
ssh your-server-ip
# or with a domain
ssh abyss.yourdomain.com
```

#### Admin Access

System SSH is moved to port 22022 to free up port 22 for the game:

```bash
ssh -p 22022 root@your-server-ip
```

### Architecture

```
Internet (port 22) → HAProxy → ssh-world:2222 (game)
Internet (port 22022) → System SSH (admin)
```

HAProxy provides:
- **Zero-downtime deployments**: Connections are queued during restarts
- **Health checking**: Routes only to healthy backends
- **Graceful draining**: Existing sessions continue during shutdown
- **Stats dashboard**: Available at `http://your-server:8404/stats`

#### Zero-Downtime Restarts

The deployment uses connection draining for seamless restarts:

1. New container starts and becomes healthy
2. HAProxy routes new connections to new container
3. Old container receives SIGTERM
4. Old container stops accepting new connections
5. Existing sessions continue (up to 5 min drain timeout)
6. Player state saved to database on disconnect
7. Reconnecting players restore their position automatically

### Railway Deployment

The project also supports Railway deployment with the included `Dockerfile` and `railway.toml`.

1. Link your repo to Railway
2. Add a PostgreSQL database
3. Set environment variables:
   - `AI_PROVIDER`
   - `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`
   - `AI_MODEL`
4. Enable TCP Proxy in Settings → Networking on port 2222

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `SSH_PORT` | Port for SSH server | `2222` |
| `AI_PROVIDER` | `openai` or `anthropic` | `anthropic` |
| `OPENAI_API_KEY` | OpenAI API key | - |
| `ANTHROPIC_API_KEY` | Anthropic API key | - |
| `AI_MODEL` | Model for avatar generation | `claude-sonnet-4-20250514` |

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev:ssh` | Start SSH server in dev mode |
| `pnpm build` | Build all packages |
| `pnpm db:push` | Push schema to database |
| `pnpm db:studio` | Open Drizzle Studio |
| `pnpm docker:up` | Start local PostgreSQL |
| `pnpm docker:down` | Stop local PostgreSQL |
| `./deploy/deploy.sh` | Deploy to production |
