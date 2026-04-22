import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { env } from '../env.js';
import * as schema from './schema.js';

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function db(): ReturnType<typeof drizzle<typeof schema>> {
  if (_db) return _db;
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set');
  }
  const client = postgres(env.DATABASE_URL, {
    max: 10,
    idle_timeout: 30,
  });
  _db = drizzle(client, { schema, casing: 'snake_case' });
  return _db;
}
