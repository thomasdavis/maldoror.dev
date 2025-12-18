import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";

Sentry.init({
  dsn: process.env.SENTRY_DSN || "https://d6fabb4de8a1426f456cf07e2682f9a2@o4510553170378752.ingest.us.sentry.io/4510553192267776",
  sendDefaultPii: true,
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: 1.0,
  profilesSampleRate: 1.0,
  integrations: [
    nodeProfilingIntegration(),
  ],
  beforeSend(event) {
    // Add memory info to all events
    const mem = process.memoryUsage();
    event.contexts = {
      ...event.contexts,
      memory: {
        heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
        heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
        rss_mb: Math.round(mem.rss / 1024 / 1024),
        external_mb: Math.round(mem.external / 1024 / 1024),
      },
    };
    return event;
  },
});

// Capture unhandled rejections
process.on('unhandledRejection', (reason) => {
  Sentry.captureException(reason);
});

// Capture uncaught exceptions
process.on('uncaughtException', (error) => {
  Sentry.captureException(error);
  // Note: OOM crashes from V8 won't trigger this - the process is killed by the OS
});

export { Sentry };
