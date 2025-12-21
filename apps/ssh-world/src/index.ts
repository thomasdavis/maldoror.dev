// Sentry must be imported first
import './instrument.js';
import * as Sentry from '@sentry/node';

import 'dotenv/config';
import { SSHServer } from './server/ssh-server.js';
import { StatsServer } from './server/stats-server.js';
import { WorkerManager } from './server/worker-manager.js';
import { db, schema } from '@maldoror/db';
import type { ProviderConfig } from '@maldoror/ai';
import { resourceMonitor } from './utils/resource-monitor.js';
import { getVersion, refreshVersion } from './version.js';
import { setBuildVersion } from '@maldoror/render';

const startTime = new Date();

async function main() {
  // Set build version from version.json (generated at build time)
  const versionInfo = getVersion();
  setBuildVersion(versionInfo.version);
  console.log(`Starting Maldoror SSH World Server ${versionInfo.version}`);

  // Start resource monitoring immediately (log every 30 seconds)
  resourceMonitor.start(30000);
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

  // Initialize worker manager (manages game server in child process)
  const workerManager = new WorkerManager({
    worldSeed,
    tickRate: 15,
    chunkCacheSize: 256,
    providerConfig,
  });

  // Start worker
  await workerManager.start();
  console.log('Game worker started');

  // Initialize SSH server
  const sshServer = new SSHServer({
    port: parseInt(process.env.SSH_PORT || '2222', 10),
    hostKeyPath: process.env.SSH_HOST_KEY_PATH || './keys/host.key',
    banner: `\x1b[38;2;180;80;255m
    ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
    █\x1b[38;2;200;100;255m ███╗   ███╗ █████╗ ██╗     ██████╗  ██████╗ ██████╗  ██████╗ ██████╗  \x1b[38;2;180;80;255m█
    █\x1b[38;2;210;120;255m ████╗ ████║██╔══██╗██║     ██╔══██╗██╔═══██╗██╔══██╗██╔═══██╗██╔══██╗ \x1b[38;2;180;80;255m█
    █\x1b[38;2;220;140;255m ██╔████╔██║███████║██║     ██║  ██║██║   ██║██████╔╝██║   ██║██████╔╝ \x1b[38;2;180;80;255m█
    █\x1b[38;2;230;160;255m ██║╚██╔╝██║██╔══██║██║     ██║  ██║██║   ██║██╔══██╗██║   ██║██╔══██╗ \x1b[38;2;180;80;255m█
    █\x1b[38;2;240;180;255m ██║ ╚═╝ ██║██║  ██║███████╗██████╔╝╚██████╔╝██║  ██║╚██████╔╝██║  ██║ \x1b[38;2;180;80;255m█
    █\x1b[38;2;250;200;255m ╚═╝     ╚═╝╚═╝  ╚═╝╚══════╝╚═════╝  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝ \x1b[38;2;180;80;255m█
    ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
\x1b[38;2;120;120;160m                   T E R M I N A L   M M O
\x1b[0m
`,
    workerManager,
  });

  // Start SSH server
  sshServer.start();

  // Start stats HTTP server
  const statsServer = new StatsServer({
    port: parseInt(process.env.STATS_PORT || '3000', 10),
    getSessionCount: () => sshServer.getSessionCount(),
    getTransportMetrics: () => sshServer.getTransportMetrics(),
    workerManager,
    worldSeed,
    startTime,
  });
  statsServer.start();

  // Hot reload handler - SIGUSR1 triggers worker reload
  // SSH connections stay alive, only game logic restarts
  process.on('SIGUSR1', async () => {
    console.log('\n=== Hot reload triggered (SIGUSR1) ===');
    try {
      // Re-read version.json (updated by deploy script)
      refreshVersion();
      const newVersion = getVersion();
      setBuildVersion(newVersion.version);
      console.log(`[Hot Reload] Updated version to ${newVersion.version}`);

      await workerManager.hotReload();
      console.log('=== Hot reload complete ===\n');
    } catch (error) {
      console.error('Hot reload failed:', error);
      Sentry.captureException(error);
    }
  });

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
    statsServer.stop();
    workerManager.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`SSH server listening on port ${process.env.SSH_PORT || 2222}`);
  console.log('Connect with: ssh -p 2222 localhost');
  console.log('Hot reload: kill -USR1 <pid>');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  Sentry.captureException(error);
  process.exit(1);
});
