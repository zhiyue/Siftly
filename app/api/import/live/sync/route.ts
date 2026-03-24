import { NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { settings } from '@/lib/schema'
import { syncBookmarks, isSyncing } from '@/lib/x-sync'

/** POST — trigger a manual sync using stored credentials */
export async function POST() {
  if (isSyncing()) {
    return NextResponse.json({ error: 'A sync is already in progress' }, { status: 409 })
  }

  try {
    const db = getDb()
    const [authRows, ct0Rows] = await Promise.all([
      db.select().from(settings).where(eq(settings.key, 'x_auth_token')).limit(1),
      db.select().from(settings).where(eq(settings.key, 'x_ct0')).limit(1),
    ])

    if (!authRows[0]?.value || !ct0Rows[0]?.value) {
      return NextResponse.json(
        { error: 'X credentials not configured. Save your auth_token and ct0 first.' },
        { status: 400 },
      )
    }

    const result = await syncBookmarks(authRows[0].value, ct0Rows[0].value)
    return NextResponse.json(result)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Sync failed'
    const status = msg.includes('already in progress') ? 409 : 500
    return NextResponse.json({ error: msg }, { status })
  }
}
