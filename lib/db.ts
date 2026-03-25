import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema'

export type AppDb = ReturnType<typeof getDb>

/**
 * Returns a Drizzle ORM instance backed by Cloudflare D1.
 * Caller passes the D1 binding (e.g. `c.env.DB` from Hono context).
 */
export function getDb(d1: D1Database) {
  return drizzle(d1, { schema })
}
