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
