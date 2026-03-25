import { Hono } from 'hono'
import type { Bindings } from '../index'
import { getDb } from '@/lib/db'
import { eq, desc, asc, inArray } from 'drizzle-orm'
import { bookmarks, bookmarkCategories, categories, mediaItems } from '@/lib/schema'

const DEFAULT_PAGE = 1
const DEFAULT_LIMIT = 24
const MAX_LIMIT = 100

function parseIntParam(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue
  const parsed = parseInt(value, 10)
  return isNaN(parsed) || parsed < 1 ? defaultValue : parsed
}

const route = new Hono<{ Bindings: Bindings }>()

route.delete('/api/bookmarks', async (c) => {
  try {
    const db = getDb(c.env.DB)
    await db.delete(bookmarkCategories)
    await db.delete(mediaItems)
    await db.delete(bookmarks)
    await db.delete(categories)
    return c.json({ success: true })
  } catch (err) {
    console.error('Clear bookmarks error:', err)
    return c.json(
      { error: `Failed to clear bookmarks: ${err instanceof Error ? err.message : String(err)}` },
      500
    )
  }
})

route.get('/api/bookmarks', async (c) => {
  const q = c.req.query('q')?.trim() ?? ''
  const source = c.req.query('source')?.trim() ?? ''
  const categorySlug = c.req.query('category')?.trim() ?? ''
  const mediaType = c.req.query('mediaType')?.trim() ?? ''
  const uncategorized = c.req.query('uncategorized') === 'true'
  const sortParam = c.req.query('sort')?.trim() ?? 'newest'
  const page = parseIntParam(c.req.query('page'), DEFAULT_PAGE)
  const limit = Math.min(parseIntParam(c.req.query('limit'), DEFAULT_LIMIT), MAX_LIMIT)
  const skip = (page - 1) * limit

  try {
    const d1 = c.env.DB
    const db = getDb(d1)

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

    const countResult = await d1
      .prepare(`SELECT COUNT(*) as total FROM Bookmark b WHERE ${whereClause}`)
      .bind(...params)
      .first<{ total: number }>()
    const total = countResult?.total ?? 0

    const idsResult = await d1
      .prepare(
        `SELECT b.id FROM Bookmark b WHERE ${whereClause} ORDER BY b.tweetCreatedAt ${orderDir}, b.importedAt ${orderDir} LIMIT ? OFFSET ?`
      )
      .bind(...params, limit, skip)
      .all<{ id: string }>()

    const ids = idsResult.results.map((r) => r.id)

    if (ids.length === 0) {
      return c.json({ bookmarks: [], total, page, limit })
    }

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

    return c.json({ bookmarks: formatted, total, page, limit })
  } catch (err) {
    console.error('Bookmarks fetch error:', err)
    return c.json(
      { error: `Failed to fetch bookmarks: ${err instanceof Error ? err.message : String(err)}` },
      500
    )
  }
})

// PUT /api/bookmarks/:id/categories — Replace all categories for a bookmark
route.put('/api/bookmarks/:id/categories', async (c) => {
  const id = c.req.param('id')
  let body: { categoryIds?: string[] } = {}
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON' }, 400)
  }

  const { categoryIds = [] } = body

  try {
    const db = getDb(c.env.DB)
    await db.delete(bookmarkCategories).where(eq(bookmarkCategories.bookmarkId, id))

    if (categoryIds.length > 0) {
      await db.insert(bookmarkCategories).values(
        categoryIds.map((categoryId) => ({
          bookmarkId: id,
          categoryId,
          confidence: 1.0,
        })),
      )
    }

    return c.json({ success: true })
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : 'Failed to update categories' },
      500
    )
  }
})

export default route
