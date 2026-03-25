import { Hono } from 'hono'
import type { Bindings } from '../index'
import { getDb } from '@/lib/db'
import { eq } from 'drizzle-orm'
import { settings } from '@/lib/schema'
import { startScheduler, stopScheduler, isSchedulerRunning, syncBookmarks, isSyncing } from '@/lib/x-sync'

const route = new Hono<{ Bindings: Bindings }>()

// GET /api/import/live — return current X credentials status + schedule config
route.get('/api/import/live', async (c) => {
  try {
    const db = getDb(c.env.DB)
    const [authRows, ct0Rows, intervalRows, lastSyncRows] = await Promise.all([
      db.select().from(settings).where(eq(settings.key, 'x_auth_token')).limit(1),
      db.select().from(settings).where(eq(settings.key, 'x_ct0')).limit(1),
      db.select().from(settings).where(eq(settings.key, 'x_sync_interval')).limit(1),
      db.select().from(settings).where(eq(settings.key, 'x_last_sync')).limit(1),
    ])

    return c.json({
      hasCredentials: !!(authRows[0]?.value && ct0Rows[0]?.value),
      syncInterval: intervalRows[0]?.value ?? 'off',
      lastSync: lastSyncRows[0]?.value ?? null,
      schedulerRunning: isSchedulerRunning(),
    })
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Failed to load config' },
      500,
    )
  }
})

// POST /api/import/live — save X credentials + optional sync interval
route.post('/api/import/live', async (c) => {
  let body: { authToken?: string; ct0?: string; syncInterval?: string } = {}
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const { authToken, ct0, syncInterval } = body

  const trimmedAuth = authToken?.trim()
  const trimmedCt0 = ct0?.trim()

  if (authToken !== undefined && ct0 !== undefined) {
    if (!trimmedAuth || !trimmedCt0) {
      return c.json({ error: 'Both auth_token and ct0 are required' }, 400)
    }
  }

  if (syncInterval !== undefined) {
    const valid = ['off', '1h', '4h', '8h', '24h']
    if (!valid.includes(syncInterval)) {
      return c.json({ error: `Invalid interval. Use: ${valid.join(', ')}` }, 400)
    }
  }

  try {
    const db = getDb(c.env.DB)
    if (trimmedAuth && trimmedCt0) {
      await Promise.all([
        db
          .insert(settings)
          .values({ key: 'x_auth_token', value: trimmedAuth })
          .onConflictDoUpdate({ target: settings.key, set: { value: trimmedAuth } }),
        db
          .insert(settings)
          .values({ key: 'x_ct0', value: trimmedCt0 })
          .onConflictDoUpdate({ target: settings.key, set: { value: trimmedCt0 } }),
      ])
    }

    if (syncInterval !== undefined) {
      await db
        .insert(settings)
        .values({ key: 'x_sync_interval', value: syncInterval })
        .onConflictDoUpdate({ target: settings.key, set: { value: syncInterval } })

      if (syncInterval === 'off') {
        stopScheduler()
      } else {
        await startScheduler(db)
      }
    }

    return c.json({ saved: true })
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Failed to save settings' },
      500,
    )
  }
})

// DELETE /api/import/live — remove credentials and stop scheduler
route.delete('/api/import/live', async (c) => {
  try {
    const db = getDb(c.env.DB)
    const d1Keys = ['x_auth_token', 'x_ct0', 'x_sync_interval', 'x_last_sync']
    for (const key of d1Keys) {
      await db.delete(settings).where(eq(settings.key, key))
    }
    stopScheduler()
    return c.json({ deleted: true })
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Failed to delete credentials' },
      500,
    )
  }
})

// POST /api/import/live/sync — trigger a manual sync
route.post('/api/import/live/sync', async (c) => {
  if (isSyncing()) {
    return c.json({ error: 'A sync is already in progress' }, 409)
  }

  try {
    const db = getDb(c.env.DB)
    const [authRows, ct0Rows] = await Promise.all([
      db.select().from(settings).where(eq(settings.key, 'x_auth_token')).limit(1),
      db.select().from(settings).where(eq(settings.key, 'x_ct0')).limit(1),
    ])

    if (!authRows[0]?.value || !ct0Rows[0]?.value) {
      return c.json(
        { error: 'X credentials not configured. Save your auth_token and ct0 first.' },
        400,
      )
    }

    const result = await syncBookmarks(db, authRows[0].value, ct0Rows[0].value)
    return c.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Sync failed'
    const status = msg.includes('already in progress') ? 409 : 500
    return c.json({ error: msg }, status)
  }
})

export default route
