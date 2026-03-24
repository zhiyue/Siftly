import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { bookmarks, mediaItems, importJobs } from '@/lib/schema'
import { parseBookmarksJson } from '@/lib/parser'

export async function POST(request: NextRequest): Promise<NextResponse> {
  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Failed to parse form data' }, { status: 400 })
  }

  const sourceParam = (formData.get('source') as string | null)?.trim()
  const file = formData.get('file')
  if (!file || !(file instanceof Blob)) {
    return NextResponse.json(
      { error: 'Missing required field: file' },
      { status: 400 }
    )
  }

  const filename =
    file instanceof File ? file.name : 'bookmarks.json'

  let jsonString: string
  try {
    jsonString = await file.text()
  } catch {
    return NextResponse.json({ error: 'Failed to read file content' }, { status: 400 })
  }

  const db = getDb()

  // Create an import job to track progress
  const inserted = await db
    .insert(importJobs)
    .values({
      filename,
      status: 'processing',
      totalCount: 0,
      processedCount: 0,
    })
    .returning({ id: importJobs.id })
  const importJobId = inserted[0].id

  let parsedBookmarks
  try {
    parsedBookmarks = parseBookmarksJson(jsonString)
  } catch (err) {
    await db
      .update(importJobs)
      .set({
        status: 'error',
        errorMessage: err instanceof Error ? err.message : String(err),
      })
      .where(eq(importJobs.id, importJobId))
    return NextResponse.json(
      { error: `Failed to parse bookmarks JSON: ${err instanceof Error ? err.message : String(err)}` },
      { status: 422 }
    )
  }

  // Determine source: formData param > JSON field > default "bookmark"
  let jsonSource: string | undefined
  try {
    const parsed = JSON.parse(jsonString)
    if (typeof parsed?.source === 'string') jsonSource = parsed.source
  } catch { /* already parsed above */ }
  const source = (sourceParam === 'like' || sourceParam === 'bookmark')
    ? sourceParam
    : (jsonSource === 'like' ? 'like' : 'bookmark')

  await db
    .update(importJobs)
    .set({ totalCount: parsedBookmarks.length })
    .where(eq(importJobs.id, importJobId))

  let importedCount = 0
  let skippedCount = 0

  for (const bookmark of parsedBookmarks) {
    try {
      const existing = await db
        .select({ id: bookmarks.id })
        .from(bookmarks)
        .where(eq(bookmarks.tweetId, bookmark.tweetId))
        .limit(1)

      if (existing.length > 0) {
        skippedCount++
        continue
      }

      const created = await db
        .insert(bookmarks)
        .values({
          tweetId: bookmark.tweetId,
          text: bookmark.text,
          authorHandle: bookmark.authorHandle,
          authorName: bookmark.authorName,
          tweetCreatedAt: bookmark.tweetCreatedAt
            ? (bookmark.tweetCreatedAt instanceof Date
                ? bookmark.tweetCreatedAt.toISOString()
                : String(bookmark.tweetCreatedAt))
            : null,
          rawJson: bookmark.rawJson,
          source,
        })
        .returning({ id: bookmarks.id })

      if (bookmark.media.length > 0) {
        await db.insert(mediaItems).values(
          bookmark.media.map((m) => ({
            bookmarkId: created[0].id,
            type: m.type,
            url: m.url,
            thumbnailUrl: m.thumbnailUrl ?? null,
          })),
        )
      }

      importedCount++
    } catch (err) {
      console.error(`Failed to import tweet ${bookmark.tweetId}:`, err)
      skippedCount++
    }
  }

  await db
    .update(importJobs)
    .set({
      status: 'done',
      processedCount: importedCount,
    })
    .where(eq(importJobs.id, importJobId))

  return NextResponse.json({
    jobId: importJobId,
    imported: importedCount,
    skipped: skippedCount,
    parsed: parsedBookmarks.length,
  })
}
