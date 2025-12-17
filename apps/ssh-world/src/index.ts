import 'dotenv/config';
import { SSHServer } from './server/ssh-server.js';
import { GameServer } from './game/game-server.js';
import { db, schema } from '@maldoror/db';

async function main() {
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
  });

  // Start servers
  gameServer.start();
  sshServer.start();

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
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
