import { Hono } from 'hono'
import type { Bindings } from '../index'
import { getDb } from '@/lib/db'
import { eq, count as countFn, desc, isNull } from 'drizzle-orm'
import { bookmarks, categories, bookmarkCategories, mediaItems } from '@/lib/schema'

const route = new Hono<{ Bindings: Bindings }>()

route.get('/api/stats', async (c) => {
  try {
    const db = getDb(c.env.DB)

    const [
      [{ count: totalBookmarks }],
      [{ count: bookmarkCount }],
      [{ count: likeCount }],
      [{ count: totalCategories }],
      [{ count: totalMedia }],
      [{ count: uncategorizedCount }],
    ] = await Promise.all([
      db.select({ count: countFn() }).from(bookmarks),
      db.select({ count: countFn() }).from(bookmarks).where(eq(bookmarks.source, 'bookmark')),
      db.select({ count: countFn() }).from(bookmarks).where(eq(bookmarks.source, 'like')),
      db.select({ count: countFn() }).from(categories),
      db.select({ count: countFn() }).from(mediaItems),
      db.select({ count: countFn() }).from(bookmarks).where(isNull(bookmarks.enrichedAt)),
    ])

    const recentBookmarks = await db.query.bookmarks.findMany({
      limit: 5,
      orderBy: desc(bookmarks.importedAt),
      with: {
        mediaItems: {
          columns: { id: true, type: true, url: true, thumbnailUrl: true },
        },
        categories: {
          with: {
            category: {
              columns: { id: true, name: true, slug: true, color: true },
            },
          },
        },
      },
    })

    const topCategoriesRaw = await db
      .select({
        id: categories.id,
        name: categories.name,
        slug: categories.slug,
        color: categories.color,
        count: countFn(),
      })
      .from(categories)
      .leftJoin(bookmarkCategories, eq(categories.id, bookmarkCategories.categoryId))
      .groupBy(categories.id)
      .orderBy(desc(countFn()))
      .limit(5)

    const formattedRecent = recentBookmarks.map((b) => ({
      id: b.id,
      tweetId: b.tweetId,
      text: b.text,
      authorHandle: b.authorHandle,
      authorName: b.authorName,
      tweetCreatedAt: b.tweetCreatedAt ?? null,
      importedAt: b.importedAt,
      mediaItems: b.mediaItems,
      categories: b.categories.map((bc) => ({
        id: bc.category.id,
        name: bc.category.name,
        slug: bc.category.slug,
        color: bc.category.color,
        confidence: bc.confidence,
      })),
    }))

    const topCategories = topCategoriesRaw.map((cat) => ({
      name: cat.name,
      slug: cat.slug,
      color: cat.color,
      count: cat.count,
    }))

    return c.json({
      totalBookmarks,
      bookmarkCount,
      likeCount,
      totalCategories,
      totalMedia,
      uncategorizedCount,
      recentBookmarks: formattedRecent,
      topCategories,
    })
  } catch (err) {
    console.error('Stats fetch error:', err)
    return c.json(
      { error: `Failed to fetch stats: ${err instanceof Error ? err.message : String(err)}` },
      500
    )
  }
})

export default route
