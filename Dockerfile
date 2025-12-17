FROM node:20-alpine AS base

# Install pnpm and openssh for key generation
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN apk add --no-cache openssh-keygen

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/ssh-world/package.json ./apps/ssh-world/
COPY packages/db/package.json ./packages/db/
COPY packages/protocol/package.json ./packages/protocol/
COPY packages/render/package.json ./packages/render/
COPY packages/world/package.json ./packages/world/
COPY packages/ai/package.json ./packages/ai/
COPY packages/queue/package.json ./packages/queue/
COPY packages/tsconfig/package.json ./packages/tsconfig/

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build all packages
RUN pnpm build

# Re-bundle db package with tsup for proper ESM resolution
RUN cd packages/db && npx tsup src/index.ts src/schema/index.ts \
    --format esm \
    --dts \
    --clean \
    --external drizzle-orm \
    --external pg \
    --external @maldoror/protocol

# Production stage
FROM node:20-alpine AS runner

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
RUN apk add --no-cache openssh-keygen

WORKDIR /app

# Copy built application
COPY --from=base /app .

# Create keys directory
RUN mkdir -p /app/apps/ssh-world/keys

# Copy startup script
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENV NODE_ENV=production
ENV SSH_HOST_KEY_PATH=/app/apps/ssh-world/keys/host.key

EXPOSE 2222

ENTRYPOINT ["/docker-entrypoint.sh"]
