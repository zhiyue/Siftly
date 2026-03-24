import { NextRequest, NextResponse } from 'next/server'
import { eq, desc, inArray } from 'drizzle-orm'
import { getDb, getD1 } from '@/lib/db'
import { bookmarks, categories, bookmarkCategories } from '@/lib/schema'

const DEFAULT_PAGE = 1
const DEFAULT_LIMIT = 24
const MAX_LIMIT = 100

function parseIntParam(value: string | null, defaultValue: number): number {
  if (!value) return defaultValue
  const parsed = parseInt(value, 10)
  return isNaN(parsed) || parsed < 1 ? defaultValue : parsed
}

interface RouteContext {
  params: Promise<{ slug: string }>
}

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { slug } = await context.params
  const { searchParams } = new URL(request.url)

  const page = parseIntParam(searchParams.get('page'), DEFAULT_PAGE)
  const limit = Math.min(parseIntParam(searchParams.get('limit'), DEFAULT_LIMIT), MAX_LIMIT)
  const skip = (page - 1) * limit

  try {
    const db = getDb()
    const d1 = getD1()

    const categoryRow = await db
      .select()
      .from(categories)
      .where(eq(categories.slug, slug))
      .limit(1)

    if (categoryRow.length === 0) {
      return NextResponse.json({ error: `Category not found: ${slug}` }, { status: 404 })
    }
    const category = categoryRow[0]

    // Get total count
    const countResult = await d1
      .prepare(
        'SELECT COUNT(*) as total FROM Bookmark b WHERE b.id IN (SELECT bc.bookmarkId FROM BookmarkCategory bc JOIN Category c ON bc.categoryId = c.id WHERE c.slug = ?)'
      )
      .bind(slug)
      .first<{ total: number }>()
    const total = countResult?.total ?? 0

    // Get bookmark IDs for this page
    const idsResult = await d1
      .prepare(
        'SELECT b.id FROM Bookmark b WHERE b.id IN (SELECT bc.bookmarkId FROM BookmarkCategory bc JOIN Category c ON bc.categoryId = c.id WHERE c.slug = ?) ORDER BY b.importedAt DESC LIMIT ? OFFSET ?'
      )
      .bind(slug, limit, skip)
      .all<{ id: string }>()

    const ids = idsResult.results.map((r) => r.id)

    if (ids.length === 0) {
      return NextResponse.json({
        category: {
          id: category.id,
          name: category.name,
          slug: category.slug,
          color: category.color,
          description: category.description,
          isAiGenerated: category.isAiGenerated,
          createdAt: category.createdAt,
        },
        bookmarks: [],
        total,
        page,
        limit,
      })
    }

    const rows = await db.query.bookmarks.findMany({
      where: inArray(bookmarks.id, ids),
      orderBy: desc(bookmarks.importedAt),
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
      category: {
        id: category.id,
        name: category.name,
        slug: category.slug,
        color: category.color,
        description: category.description,
        isAiGenerated: category.isAiGenerated,
        createdAt: category.createdAt,
      },
      bookmarks: formatted,
      total,
      page,
      limit,
    })
  } catch (err) {
    console.error(`Category [${slug}] fetch error:`, err)
    return NextResponse.json(
      { error: `Failed to fetch category: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const { slug } = await context.params

  try {
    const db = getDb()
    const categoryRow = await db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(eq(categories.slug, slug))
      .limit(1)

    if (categoryRow.length === 0) {
      return NextResponse.json({ error: `Category not found: ${slug}` }, { status: 404 })
    }

    // Delete bookmark-category links first, then the category
    await db.delete(bookmarkCategories).where(eq(bookmarkCategories.categoryId, categoryRow[0].id))
    await db.delete(categories).where(eq(categories.slug, slug))

    return NextResponse.json({
      deleted: true,
      slug,
      name: categoryRow[0].name,
    })
  } catch (err) {
    console.error(`Category [${slug}] delete error:`, err)
    return NextResponse.json(
      { error: `Failed to delete category: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}
