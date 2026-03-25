import prisma from '@/lib/db'
import { fetchPage, parsePage, importTweets } from '@/lib/twitter-api'

// ── Sync ────────────────────────────────────────────────────────────────────────

export type SyncMode = 'incremental' | 'full'

export async function syncBookmarks(
  authToken: string,
  ct0: string,
  mode: SyncMode = 'incremental',
): Promise<{ imported: number; skipped: number; pages: number; mode: SyncMode }> {
  if (syncing) throw new Error('A sync is already in progress')
  syncing = true

  try {
    let imported = 0
    let skipped = 0
    let cursor: string | undefined
    let consecutiveSkipPages = 0
    const MAX_PAGES = mode === 'full' ? 200 : 50

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

      // Incremental mode: bookmarks are reverse-chronological.
      // If an entire page was skipped, all subsequent pages are older.
      // Use 2 consecutive skip pages as threshold (like Twillot) to be safe
      // against edge cases like deleted bookmarks leaving gaps.
      if (mode === 'incremental' && result.imported === 0 && tweets.length > 0) {
        consecutiveSkipPages++
        if (consecutiveSkipPages >= 2) {
          console.log(`[x-sync] Incremental: ${consecutiveSkipPages} consecutive pages fully skipped, stopping early at page ${page + 1}`)
          break
        }
      } else {
        consecutiveSkipPages = 0
      }

      if (!nextCursor || tweets.length === 0) break
      cursor = nextCursor

      if (page === MAX_PAGES - 1) {
        console.warn(`[x-sync] Hit max page limit (${MAX_PAGES}), stopping pagination`)
      }
    }

    // Update last sync timestamp
    if (imported > 0 || skipped > 0) {
      const now = new Date().toISOString()
      await prisma.setting.upsert({
        where: { key: 'x_last_sync' },
        update: { value: now },
        create: { key: 'x_last_sync', value: now },
      })
    }

    const pages = Math.ceil((imported + skipped) / 100) || 0
    return { imported, skipped, pages, mode }
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

  const intervalSetting = await prisma.setting.findUnique({ where: { key: 'x_sync_interval' } })
  if (!intervalSetting?.value || intervalSetting.value === 'off') return

  const interval = intervalSetting.value as SyncInterval
  const ms = INTERVAL_MS[interval]
  if (!ms) {
    console.warn(`[x-sync] Invalid sync interval "${intervalSetting.value}" in database, not starting scheduler`)
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
    const [authSetting, ct0Setting] = await Promise.all([
      prisma.setting.findUnique({ where: { key: 'x_auth_token' } }),
      prisma.setting.findUnique({ where: { key: 'x_ct0' } }),
    ])

    if (!authSetting?.value || !ct0Setting?.value) {
      console.log('[x-sync] Skipping scheduled sync: missing credentials')
      return
    }

    console.log(`[x-sync] Running scheduled sync at ${new Date().toISOString()}`)
    const result = await syncBookmarks(authSetting.value, ct0Setting.value)
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
