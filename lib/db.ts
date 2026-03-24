import { PrismaD1 } from '@prisma/adapter-d1'
import { PrismaClient } from '@/app/generated/prisma/client'
import { getCloudflareContext } from '@opennextjs/cloudflare'

/**
 * Returns a PrismaClient backed by Cloudflare D1.
 * Must only be called inside request handlers (not at module top-level).
 */
export function getDb(): PrismaClient {
  const { env } = getCloudflareContext()
  return new PrismaClient({
    adapter: new PrismaD1(env.DB),
  })
}

/**
 * Returns the raw D1 database binding for direct SQL operations (FTS5, batch).
 */
export function getD1(): D1Database {
  const { env } = getCloudflareContext()
  return env.DB
}

// Backward-compatible default export.
// Caches per-request to avoid creating PrismaClient on every property access.
let _cached: PrismaClient | null = null

export default new Proxy({} as PrismaClient, {
  get(_target, prop) {
    if (!_cached) _cached = getDb()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (_cached as any)[prop]
  },
})
