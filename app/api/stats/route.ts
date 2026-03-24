import { NextResponse } from 'next/server'
import { eq, count as countFn, desc, isNull } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { bookmarks, categories, bookmarkCategories, mediaItems } from '@/lib/schema'

export async function GET(): Promise<NextResponse> {
  try {
    const db = getDb()

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

    // For top categories with counts, we need a different approach since Drizzle
    // doesn't have _count like Prisma. Use a subquery approach.
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

    return NextResponse.json({
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
    return NextResponse.json(
      { error: `Failed to fetch stats: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}
