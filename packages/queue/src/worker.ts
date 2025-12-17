import 'dotenv/config';
import { run } from 'graphile-worker';
import { taskList } from './tasks/index.js';

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL environment variable is required');
    process.exit(1);
  }

  console.log('Starting Maldoror Worker...');

  const runner = await run({
    connectionString,
    taskList,
    concurrency: 5,
    pollInterval: 1000,
    noHandleSignals: false,
  });

  console.log('Worker started, listening for jobs...');

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    await runner.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Keep process running
  await runner.promise;
}

main().catch((error) => {
  console.error('Worker error:', error);
  process.exit(1);
});
