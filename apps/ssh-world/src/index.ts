import 'dotenv/config';
import { SSHServer } from './server/ssh-server.js';
import { GameServer } from './game/game-server.js';
import { db, schema } from '@maldoror/db';
import type { ProviderConfig } from '@maldoror/ai';

async function main() {
  // Configure AI provider from environment
  const providerConfig: ProviderConfig = {
    provider: (process.env.AI_PROVIDER as 'openai' | 'anthropic') || 'openai',
    model: process.env.AI_MODEL || 'gpt-4o',
    apiKey: process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY,
  };
  console.log('Starting Maldoror SSH World Server...');

  // Get or create world seed
  let worldSeed: bigint;
  const worldRecord = await db.query.world.findFirst();

  if (worldRecord) {
    worldSeed = worldRecord.seed;
    console.log(`Using existing world seed: ${worldSeed}`);
  } else {
    // Generate random seed
    worldSeed = BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));
    await db.insert(schema.world).values({
      seed: worldSeed,
      name: 'Maldoror',
    });
    console.log(`Created new world with seed: ${worldSeed}`);
  }

  // Initialize game server
  const gameServer = new GameServer({
    worldSeed,
    tickRate: 15,
    chunkCacheSize: 256,
  });

  // Initialize SSH server
  const sshServer = new SSHServer({
    port: parseInt(process.env.SSH_PORT || '2222', 10),
    hostKeyPath: process.env.SSH_HOST_KEY_PATH || './keys/host.key',
    banner: `
    ╔══════════════════════════════════════╗
    ║     Welcome to the Abyss...          ║
    ║         M A L D O R O R              ║
    ╚══════════════════════════════════════╝

`,
    gameServer,
    worldSeed,
    providerConfig,
  });

  // Start servers
  gameServer.start();
  sshServer.start();

  // Graceful shutdown with connection draining
  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log('\nGraceful shutdown initiated...');
    console.log('Stopping new connections, draining existing sessions...');

    // Stop accepting new connections
    sshServer.stopAccepting();

    // Wait for existing sessions to finish (max 5 minutes)
    const drainTimeout = 5 * 60 * 1000;
    const startTime = Date.now();

    while (sshServer.getSessionCount() > 0) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= drainTimeout) {
        console.log('Drain timeout reached, forcing shutdown...');
        break;
      }
      console.log(`Waiting for ${sshServer.getSessionCount()} sessions to close... (${Math.round((drainTimeout - elapsed) / 1000)}s remaining)`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

    console.log('All sessions closed, shutting down...');
    sshServer.stop();
    gameServer.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`SSH server listening on port ${process.env.SSH_PORT || 2222}`);
  console.log('Connect with: ssh -p 2222 localhost');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
