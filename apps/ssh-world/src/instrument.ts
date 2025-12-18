import * as Sentry from "@sentry/node";

Sentry.init({
  dsn: "https://d6fabb4de8a1426f456cf07e2682f9a2@o4510553170378752.ingest.us.sentry.io/4510553192267776",
  sendDefaultPii: true,
  environment: process.env.NODE_ENV || 'development',
});

export { Sentry };
