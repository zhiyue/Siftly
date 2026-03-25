import { Hono } from 'hono'
import type { Bindings } from '../index'
import { getDb } from '@/lib/db'
import { eq, and, isNull, inArray, count as countFn } from 'drizzle-orm'
import { mediaItems, settings } from '@/lib/schema'
import { analyzeBatch } from '@/lib/vision-analyzer'
import { AIClient, resolveAIClient } from '@/lib/ai-client'
import { getProvider } from '@/lib/settings'

const route = new Hono<{ Bindings: Bindings }>()

// GET /api/analyze/images — returns progress stats
route.get('/api/analyze/images', async (c) => {
  const d1 = c.env.DB
  const db = getDb(d1)

  const [[{ count: total }]] = await Promise.all([
    db
      .select({ count: countFn() })
      .from(mediaItems)
      .where(inArray(mediaItems.type, ['photo', 'gif'])),
  ])

  // Use raw SQL for the "not null" count
  const taggedResult = await d1
    .prepare("SELECT COUNT(*) as cnt FROM MediaItem WHERE type IN ('photo', 'gif') AND imageTags IS NOT NULL")
    .first<{ cnt: number }>()
  const taggedCount = taggedResult?.cnt ?? 0

  return c.json({ total, tagged: taggedCount, remaining: total - taggedCount })
})

// POST /api/analyze/images — analyze a batch of untagged images
route.post('/api/analyze/images', async (c) => {
  let batchSize = 20
  try {
    const body = await c.req.json() as { batchSize?: number }
    if (typeof body.batchSize === 'number') batchSize = Math.min(body.batchSize, 50)
  } catch {
    // use default
  }

  const d1 = c.env.DB
  const db = getDb(d1)
  const bucket = c.env.MEDIA_BUCKET
  const env = c.env

  const provider = await getProvider(db)
  const keyName = provider === 'openai' ? 'openaiApiKey' : 'anthropicApiKey'
  const settingRows = await db
    .select()
    .from(settings)
    .where(eq(settings.key, keyName))
    .limit(1)
  const dbKey = settingRows[0]?.value?.trim()

  let client: AIClient
  try {
    client = await resolveAIClient({ db, dbKey, env })
  } catch (err) {
    return c.json(
      { error: `No API key available: ${err instanceof Error ? err.message : String(err)}` },
      400
    )
  }

  const untagged = await db
    .select({
      id: mediaItems.id,
      bookmarkId: mediaItems.bookmarkId,
      url: mediaItems.url,
      thumbnailUrl: mediaItems.thumbnailUrl,
      type: mediaItems.type,
    })
    .from(mediaItems)
    .where(
      and(
        isNull(mediaItems.imageTags),
        inArray(mediaItems.type, ['photo', 'gif']),
      )
    )
    .limit(batchSize)

  if (untagged.length === 0) {
    return c.json({ analyzed: 0, remaining: 0, message: 'All images already analyzed.' })
  }

  const analyzed = await analyzeBatch(db, bucket, untagged, client)

  const [{ count: remaining }] = await db
    .select({ count: countFn() })
    .from(mediaItems)
    .where(
      and(
        isNull(mediaItems.imageTags),
        inArray(mediaItems.type, ['photo', 'gif']),
      )
    )

  return c.json({ analyzed, remaining })
})

export default route
