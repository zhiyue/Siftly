import { NextRequest, NextResponse } from 'next/server'
import { eq, desc, asc, like, inArray, sql, and, count as countFn } from 'drizzle-orm'
import { getDb, getD1 } from '@/lib/db'
import { bookmarks, bookmarkCategories, categories, mediaItems } from '@/lib/schema'

const DEFAULT_PAGE = 1
const DEFAULT_LIMIT = 24
const MAX_LIMIT = 100

function parseIntParam(value: string | null, defaultValue: number): number {
  if (!value) return defaultValue
  const parsed = parseInt(value, 10)
  return isNaN(parsed) || parsed < 1 ? defaultValue : parsed
}

export async function DELETE(): Promise<NextResponse> {
  try {
    const db = getDb()
    // Delete in dependency order
    await db.delete(bookmarkCategories)
    await db.delete(mediaItems)
    await db.delete(bookmarks)
    await db.delete(categories)
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Clear bookmarks error:', err)
    return NextResponse.json(
      { error: `Failed to clear bookmarks: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url)

  const q = searchParams.get('q')?.trim() ?? ''
  const source = searchParams.get('source')?.trim() ?? ''
  const categorySlug = searchParams.get('category')?.trim() ?? ''
  const mediaType = searchParams.get('mediaType')?.trim() ?? ''
  const uncategorized = searchParams.get('uncategorized') === 'true'
  const sortParam = searchParams.get('sort')?.trim() ?? 'newest'
  const page = parseIntParam(searchParams.get('page'), DEFAULT_PAGE)
  const limit = Math.min(parseIntParam(searchParams.get('limit'), DEFAULT_LIMIT), MAX_LIMIT)
  const skip = (page - 1) * limit

  try {
    const d1 = getD1()
    const db = getDb()

    // Build WHERE conditions and params for raw SQL (needed for relation-based filters)
    const conditions: string[] = ['1=1']
    const params: unknown[] = []

    if (source === 'bookmark' || source === 'like') {
      conditions.push('b.source = ?')
      params.push(source)
    }

    if (q) {
      conditions.push('b.text LIKE ?')
      params.push(`%${q}%`)
    }

    if (uncategorized) {
      conditions.push('b.id NOT IN (SELECT bookmarkId FROM BookmarkCategory)')
    } else if (categorySlug) {
      conditions.push(
        'b.id IN (SELECT bc.bookmarkId FROM BookmarkCategory bc JOIN Category c ON bc.categoryId = c.id WHERE c.slug = ?)'
      )
      params.push(categorySlug)
    }

    if (mediaType === 'photo' || mediaType === 'video') {
      conditions.push(
        'b.id IN (SELECT m.bookmarkId FROM MediaItem m WHERE m.type = ?)'
      )
      params.push(mediaType)
    }

    const whereClause = conditions.join(' AND ')
    const orderDir = sortParam === 'oldest' ? 'ASC' : 'DESC'

    // Count total
    const countResult = await d1
      .prepare(`SELECT COUNT(*) as total FROM Bookmark b WHERE ${whereClause}`)
      .bind(...params)
      .first<{ total: number }>()
    const total = countResult?.total ?? 0

    // Fetch bookmark IDs for this page
    const idsResult = await d1
      .prepare(
        `SELECT b.id FROM Bookmark b WHERE ${whereClause} ORDER BY b.tweetCreatedAt ${orderDir}, b.importedAt ${orderDir} LIMIT ? OFFSET ?`
      )
      .bind(...params, limit, skip)
      .all<{ id: string }>()

    const ids = idsResult.results.map((r) => r.id)

    if (ids.length === 0) {
      return NextResponse.json({ bookmarks: [], total, page, limit })
    }

    // Hydrate with Drizzle relational queries
    const rows = await db.query.bookmarks.findMany({
      where: inArray(bookmarks.id, ids),
      orderBy: sortParam === 'oldest'
        ? [asc(bookmarks.tweetCreatedAt), asc(bookmarks.importedAt)]
        : [desc(bookmarks.tweetCreatedAt), desc(bookmarks.importedAt)],
      with: {
        mediaItems: true,
        categories: {
          with: {
            category: {
              columns: { id: true, name: true, slug: true, color: true },
            },
          },
        },
      },
    })

    const formatted = rows.map((bookmark) => ({
      id: bookmark.id,
      tweetId: bookmark.tweetId,
      text: bookmark.text,
      authorHandle: bookmark.authorHandle,
      authorName: bookmark.authorName,
      source: bookmark.source,
      tweetCreatedAt: bookmark.tweetCreatedAt ?? null,
      importedAt: bookmark.importedAt,
      mediaItems: bookmark.mediaItems.map((m) => ({
        id: m.id,
        type: m.type,
        url: m.url,
        thumbnailUrl: m.thumbnailUrl,
      })),
      categories: bookmark.categories.map((bc) => ({
        id: bc.category.id,
        name: bc.category.name,
        slug: bc.category.slug,
        color: bc.category.color,
        confidence: bc.confidence,
      })),
    }))

    return NextResponse.json({
      bookmarks: formatted,
      total,
      page,
      limit,
    })
  } catch (err) {
    console.error('Bookmarks fetch error:', err)
    return NextResponse.json(
      { error: `Failed to fetch bookmarks: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}
