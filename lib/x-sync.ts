import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { settings } from '@/lib/schema'
import { fetchPage, parsePage, importTweets } from '@/lib/twitter-api'

// ── Sync ────────────────────────────────────────────────────────────────────────

export async function syncBookmarks(
  authToken: string,
  ct0: string,
): Promise<{ imported: number; skipped: number }> {
  if (syncing) throw new Error('A sync is already in progress')
  syncing = true

  try {
    let imported = 0
    let skipped = 0
    let cursor: string | undefined
    const MAX_PAGES = 50

    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await fetchPage(authToken, ct0, cursor)
      const { tweets, nextCursor } = parsePage(data)

      // On the first page, verify the API response structure hasn't changed
      if (page === 0 && tweets.length === 0 && !nextCursor) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hasTimeline = (data as any)?.data?.bookmark_timeline_v2?.timeline
        if (!hasTimeline) {
          throw new Error('Twitter API response format has changed. The sync feature may need updating.')
        }
      }

      const result = await importTweets(tweets)
      imported += result.imported
      skipped += result.skipped

      if (!nextCursor || tweets.length === 0) break
      cursor = nextCursor

      if (page === MAX_PAGES - 1) {
        console.warn(`[x-sync] Hit max page limit (${MAX_PAGES}), stopping pagination`)
      }
    }

    // Only update last sync timestamp if we actually fetched tweets
    if (imported > 0 || skipped > 0) {
      const db = getDb()
      const now = new Date().toISOString()
      await db
        .insert(settings)
        .values({ key: 'x_last_sync', value: now })
        .onConflictDoUpdate({ target: settings.key, set: { value: now } })
    }

    return { imported, skipped }
  } finally {
    syncing = false
  }
}

// ── Scheduler ───────────────────────────────────────────────────────────────────

type SyncInterval = '1h' | '4h' | '8h' | '24h'

const INTERVAL_MS: Record<SyncInterval, number> = {
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '8h': 8 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null
let syncing = false

export async function startScheduler() {
  stopScheduler()

  const db = getDb()
  const rows = await db
    .select()
    .from(settings)
    .where(eq(settings.key, 'x_sync_interval'))
    .limit(1)
  const intervalValue = rows[0]?.value
  if (!intervalValue || intervalValue === 'off') return

  const interval = intervalValue as SyncInterval
  const ms = INTERVAL_MS[interval]
  if (!ms) {
    console.warn(`[x-sync] Invalid sync interval "${intervalValue}" in database, not starting scheduler`)
    return
  }

  schedulerTimer = setInterval(() => void runScheduledSync(), ms)
  console.log(`[x-sync] Scheduler started: every ${interval}`)
}

export function stopScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer)
    schedulerTimer = null
    console.log('[x-sync] Scheduler stopped')
  }
}

async function runScheduledSync() {
  if (syncing) return

  try {
    const db = getDb()
    const [authRows, ct0Rows] = await Promise.all([
      db.select().from(settings).where(eq(settings.key, 'x_auth_token')).limit(1),
      db.select().from(settings).where(eq(settings.key, 'x_ct0')).limit(1),
    ])

    if (!authRows[0]?.value || !ct0Rows[0]?.value) {
      console.log('[x-sync] Skipping scheduled sync: missing credentials')
      return
    }

    console.log(`[x-sync] Running scheduled sync at ${new Date().toISOString()}`)
    const result = await syncBookmarks(authRows[0].value, ct0Rows[0].value)
    console.log(`[x-sync] Sync complete: ${result.imported} imported, ${result.skipped} skipped`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[x-sync] Scheduled sync failed:', message)
    if (message.includes('401') || message.includes('403')) {
      console.error('[x-sync] Auth error detected, stopping scheduler')
      stopScheduler()
    }
  }
}

export function isSchedulerRunning() {
  return schedulerTimer !== null
}

export function isSyncing() {
  return syncing
}
