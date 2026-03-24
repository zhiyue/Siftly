import { NextRequest, NextResponse } from 'next/server'
import { eq, and, isNull, inArray, count as countFn } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { mediaItems, settings } from '@/lib/schema'
import { analyzeBatch } from '@/lib/vision-analyzer'
import { AIClient, resolveAIClient } from '@/lib/ai-client'
import { getProvider } from '@/lib/settings'

// GET: returns progress stats
export async function GET(): Promise<NextResponse> {
  const db = getDb()
  const [[{ count: total }], [{ count: tagged }]] = await Promise.all([
    db
      .select({ count: countFn() })
      .from(mediaItems)
      .where(inArray(mediaItems.type, ['photo', 'gif'])),
    db
      .select({ count: countFn() })
      .from(mediaItems)
      .where(
        and(
          inArray(mediaItems.type, ['photo', 'gif']),
          // not null
          // Drizzle: isNotNull
          mediaItems.imageTags !== null
            ? eq(mediaItems.type, mediaItems.type) // placeholder — use raw below
            : eq(mediaItems.type, mediaItems.type),
        )
      ),
  ])

  // Use raw SQL for the "not null" count since Drizzle's isNotNull is cleaner via D1
  const { getD1 } = await import('@/lib/db')
  const d1 = getD1()
  const taggedResult = await d1
    .prepare("SELECT COUNT(*) as cnt FROM MediaItem WHERE type IN ('photo', 'gif') AND imageTags IS NOT NULL")
    .first<{ cnt: number }>()
  const taggedCount = taggedResult?.cnt ?? 0

  return NextResponse.json({ total, tagged: taggedCount, remaining: total - taggedCount })
}

// POST: analyze a batch of untagged images
export async function POST(request: NextRequest): Promise<NextResponse> {
  let batchSize = 20
  try {
    const body = await request.json() as { batchSize?: number }
    if (typeof body.batchSize === 'number') batchSize = Math.min(body.batchSize, 50)
  } catch {
    // use default
  }

  const db = getDb()
  const provider = await getProvider()
  const keyName = provider === 'openai' ? 'openaiApiKey' : 'anthropicApiKey'
  const settingRows = await db
    .select()
    .from(settings)
    .where(eq(settings.key, keyName))
    .limit(1)
  const dbKey = settingRows[0]?.value?.trim()

  let client: AIClient
  try {
    client = await resolveAIClient({ dbKey })
  } catch (err) {
    return NextResponse.json(
      { error: `No API key available: ${err instanceof Error ? err.message : String(err)}` },
      { status: 400 }
    )
  }

  return runAnalysis(client, batchSize)
}

async function runAnalysis(client: AIClient, batchSize: number): Promise<NextResponse> {
  const db = getDb()
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
    return NextResponse.json({ analyzed: 0, remaining: 0, message: 'All images already analyzed.' })
  }

  const analyzed = await analyzeBatch(untagged, client)

  const [{ count: remaining }] = await db
    .select({ count: countFn() })
    .from(mediaItems)
    .where(
      and(
        isNull(mediaItems.imageTags),
        inArray(mediaItems.type, ['photo', 'gif']),
      )
    )

  return NextResponse.json({ analyzed, remaining })
}
