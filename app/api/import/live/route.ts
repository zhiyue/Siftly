import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { settings } from '@/lib/schema'
import { startScheduler, stopScheduler, isSchedulerRunning } from '@/lib/x-sync'

/** GET — return current X credentials status + schedule config */
export async function GET() {
  try {
    const db = getDb()
    const [authRows, ct0Rows, intervalRows, lastSyncRows] = await Promise.all([
      db.select().from(settings).where(eq(settings.key, 'x_auth_token')).limit(1),
      db.select().from(settings).where(eq(settings.key, 'x_ct0')).limit(1),
      db.select().from(settings).where(eq(settings.key, 'x_sync_interval')).limit(1),
      db.select().from(settings).where(eq(settings.key, 'x_last_sync')).limit(1),
    ])

    return NextResponse.json({
      hasCredentials: !!(authRows[0]?.value && ct0Rows[0]?.value),
      syncInterval: intervalRows[0]?.value ?? 'off',
      lastSync: lastSyncRows[0]?.value ?? null,
      schedulerRunning: isSchedulerRunning(),
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load config' },
      { status: 500 },
    )
  }
}

/** POST — save X credentials + optional sync interval */
export async function POST(request: NextRequest) {
  let body: { authToken?: string; ct0?: string; syncInterval?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { authToken, ct0, syncInterval } = body

  // Validate credentials if provided — require both
  const trimmedAuth = authToken?.trim()
  const trimmedCt0 = ct0?.trim()

  if (authToken !== undefined && ct0 !== undefined) {
    if (!trimmedAuth || !trimmedCt0) {
      return NextResponse.json({ error: 'Both auth_token and ct0 are required' }, { status: 400 })
    }
  }

  if (syncInterval !== undefined) {
    const valid = ['off', '1h', '4h', '8h', '24h']
    if (!valid.includes(syncInterval)) {
      return NextResponse.json({ error: `Invalid interval. Use: ${valid.join(', ')}` }, { status: 400 })
    }
  }

  try {
    const db = getDb()
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
        await startScheduler()
      }
    }

    return NextResponse.json({ saved: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to save settings' },
      { status: 500 },
    )
  }
}

/** DELETE — remove credentials and stop scheduler */
export async function DELETE() {
  try {
    const db = getDb()
    const d1Keys = ['x_auth_token', 'x_ct0', 'x_sync_interval', 'x_last_sync']
    for (const key of d1Keys) {
      await db.delete(settings).where(eq(settings.key, key))
    }
    stopScheduler()
    return NextResponse.json({ deleted: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to delete credentials' },
      { status: 500 },
    )
  }
}
