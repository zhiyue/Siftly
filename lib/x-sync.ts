import { eq } from 'drizzle-orm'
import { settings } from '@/lib/schema'
import { fetchPage, parsePage, importTweets } from '@/lib/twitter-api'
import type { AppDb } from '@/lib/db'

// ── Progress tracking ────────────────────────────────────────────────────────

export interface SyncProgress {
  status: 'idle' | 'syncing' | 'done' | 'error'
  page: number
  imported: number
  skipped: number
  hasMore: boolean
  error?: string
}

const _progress: SyncProgress = {
  status: 'idle', page: 0, imported: 0, skipped: 0, hasMore: false,
}

export function getSyncProgress(): SyncProgress {
  return { ..._progress }
}

// ── Chunked sync ─────────────────────────────────────────────────────────────

const PAGES_PER_CHUNK = 20

// Cursor persists between chunks within a sync session
let _cursor: string | undefined
let syncing = false

/**
 * Sync one chunk of pages. Returns hasMore=true if there are more pages.
 * Client calls repeatedly until hasMore=false.
 *
 * @param resume - true to continue from last cursor, false to start fresh
 */
export async function syncChunk(
  db: AppDb,
  authToken: string,
  ct0: string,
  resume = false,
): Promise<{ imported: number; skipped: number; hasMore: boolean }> {
  if (syncing) throw new Error('A sync is already in progress')
  syncing = true

  if (!resume) {
    _cursor = undefined
    _progress.page = 0
    _progress.imported = 0
    _progress.skipped = 0
    _progress.hasMore = false
    _progress.error = undefined
  }
  _progress.status = 'syncing'

  try {
    let chunkImported = 0
    let chunkSkipped = 0
    let hasMore = false

    for (let i = 0; i < PAGES_PER_CHUNK; i++) {
      _progress.page++
      console.log(`[x-sync] Fetching page ${_progress.page}...`)

      const data = await fetchPage(authToken, ct0, _cursor)
      const { tweets, nextCursor } = parsePage(data)

      console.log(`[x-sync] Page ${_progress.page}: ${tweets.length} tweets, nextCursor=${!!nextCursor}`)

      if (_progress.page === 1 && tweets.length === 0 && !nextCursor) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const hasTimeline = (data as any)?.data?.bookmark_timeline_v2?.timeline
        if (!hasTimeline) {
          throw new Error('Twitter API response format has changed.')
        }
      }

      const result = await importTweets(db, tweets)
      chunkImported += result.imported
      chunkSkipped += result.skipped
      _progress.imported += result.imported
      _progress.skipped += result.skipped

      console.log(`[x-sync] Page ${_progress.page}: +${result.imported} imported, +${result.skipped} skipped (total: ${_progress.imported}/${_progress.skipped})`)

      if (!nextCursor || tweets.length === 0) {
        hasMore = false
        _cursor = undefined
        break
      }
      _cursor = nextCursor
      hasMore = true
    }

    _progress.hasMore = hasMore

    // Update last sync timestamp
    const now = new Date().toISOString()
    await db
      .insert(settings)
      .values({ key: 'x_last_sync', value: now })
      .onConflictDoUpdate({ target: settings.key, set: { value: now } })

    if (!hasMore) {
      _progress.status = 'done'
      console.log(`[x-sync] Sync complete: ${_progress.imported} imported, ${_progress.skipped} skipped`)
    }

    return { imported: chunkImported, skipped: chunkSkipped, hasMore }
  } catch (err) {
    _progress.status = 'error'
    _progress.error = err instanceof Error ? err.message : String(err)
    _cursor = undefined
    console.error(`[x-sync] Sync error:`, _progress.error)
    throw err
  } finally {
    syncing = false
  }
}

// ── Scheduler ───────────────────────────────────────────────────────────────

type SyncInterval = '1h' | '4h' | '8h' | '24h'

const INTERVAL_MS: Record<SyncInterval, number> = {
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '8h': 8 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
}

let schedulerTimer: ReturnType<typeof setInterval> | null = null
let _schedulerDb: AppDb | null = null

export async function startScheduler(db: AppDb) {
  stopScheduler()
  _schedulerDb = db

  const rows = await db.select().from(settings).where(eq(settings.key, 'x_sync_interval')).limit(1)
  const intervalValue = rows[0]?.value
  if (!intervalValue || intervalValue === 'off') return

  const interval = intervalValue as SyncInterval
  const ms = INTERVAL_MS[interval]
  if (!ms) return

  schedulerTimer = setInterval(() => void runScheduledSync(), ms)
  console.log(`[x-sync] Scheduler started: every ${interval}`)
}

export function stopScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer)
    schedulerTimer = null
    _schedulerDb = null
  }
}

async function runScheduledSync() {
  if (syncing || !_schedulerDb) return
  const db = _schedulerDb

  try {
    const [authRows, ct0Rows] = await Promise.all([
      db.select().from(settings).where(eq(settings.key, 'x_auth_token')).limit(1),
      db.select().from(settings).where(eq(settings.key, 'x_ct0')).limit(1),
    ])
    if (!authRows[0]?.value || !ct0Rows[0]?.value) return

    // Chunked: keep going until done
    let hasMore = true
    let first = true
    while (hasMore) {
      const r = await syncChunk(db, authRows[0].value, ct0Rows[0].value, !first)
      hasMore = r.hasMore
      first = false
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[x-sync] Scheduled sync failed:', msg)
    if (msg.includes('401') || msg.includes('403')) stopScheduler()
  }
}

export function isSchedulerRunning() { return schedulerTimer !== null }
export function isSyncing() { return syncing }
