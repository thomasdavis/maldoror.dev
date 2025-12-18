import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema/index';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required');
}

const pool = new Pool({
  connectionString,
  max: 10,                      // Reduced from 20 to prevent connection exhaustion
  idleTimeoutMillis: 30000,     // Close idle connections after 30s
  connectionTimeoutMillis: 10000, // Increased from 2s - wait up to 10s for connection
  statement_timeout: 30000,     // Kill queries running longer than 30s
});

export const db = drizzle(pool, { schema });
export type Database = typeof db;
