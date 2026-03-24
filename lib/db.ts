import { drizzle } from 'drizzle-orm/d1'
import { getCloudflareContext } from '@opennextjs/cloudflare'
import * as schema from './schema'

export type Database = ReturnType<typeof drizzle<typeof schema>>

/**
 * Returns a Drizzle ORM instance backed by Cloudflare D1.
 * Must only be called inside request handlers (not at module top-level).
 */
export function getDb(): Database {
  const { env } = getCloudflareContext()
  return drizzle(env.DB, { schema })
}

/**
 * Returns the raw D1 database binding for direct SQL operations (FTS5, batch).
 */
export function getD1(): D1Database {
  const { env } = getCloudflareContext()
  return env.DB
}
