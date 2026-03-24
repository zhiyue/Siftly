#!/usr/bin/env npx tsx
/**
 * CLI tool for direct database access.
 *
 * NOTE: This CLI is not yet adapted for the Drizzle/D1 migration.
 * It previously used Prisma with local SQLite. For D1 access, use
 * `npx wrangler d1 execute siftly-db --command "SELECT ..."` instead.
 *
 * TODO: Rewrite using drizzle-orm/better-sqlite3 for local dev,
 * or wrangler D1 commands for remote.
 */

console.error(
  'CLI not available in the Cloudflare Workers build. Use wrangler d1 commands or the web UI instead.\n' +
  'Example: npx wrangler d1 execute siftly-db --local --command "SELECT COUNT(*) FROM Bookmark"'
)
process.exit(1)
