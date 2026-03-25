import { Hono } from 'hono'
import type { Bindings } from '../index'
import { getDb } from '@/lib/db'
import { eq, or, asc, count as countFn, desc, inArray } from 'drizzle-orm'
import { bookmarks, categories, bookmarkCategories } from '@/lib/schema'
import { seedDefaultCategories } from '@/lib/categorizer'

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

const DEFAULT_PAGE = 1
const DEFAULT_LIMIT = 24
const MAX_LIMIT = 100

function parseIntParam(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue
  const parsed = parseInt(value, 10)
  return isNaN(parsed) || parsed < 1 ? defaultValue : parsed
}

const route = new Hono<{ Bindings: Bindings }>()

// GET /api/categories
route.get('/api/categories', async (c) => {
  try {
    const db = getDb(c.env.DB)
    const [{ count: catCount }] = await db.select({ count: countFn() }).from(categories)
    if (catCount === 0) await seedDefaultCategories(db)

    const rows = await db
      .select({
        id: categories.id,
        name: categories.name,
        slug: categories.slug,
        color: categories.color,
        description: categories.description,
        isAiGenerated: categories.isAiGenerated,
        createdAt: categories.createdAt,
        bookmarkCount: countFn(),
      })
      .from(categories)
      .leftJoin(bookmarkCategories, eq(categories.id, bookmarkCategories.categoryId))
      .groupBy(categories.id)
      .orderBy(asc(categories.name))

    const formatted = rows.map((cat) => ({
      id: cat.id,
      name: cat.name,
      slug: cat.slug,
      color: cat.color,
      description: cat.description,
      isAiGenerated: cat.isAiGenerated,
      createdAt: cat.createdAt,
      bookmarkCount: cat.bookmarkCount,
    }))

    return c.json({ categories: formatted })
  } catch (err) {
    console.error('Categories fetch error:', err)
    return c.json(
      { error: `Failed to fetch categories: ${err instanceof Error ? err.message : String(err)}` },
      500
    )
  }
})

// POST /api/categories
route.post('/api/categories', async (c) => {
  let body: { name?: string; color?: string; description?: string } = {}
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400)
  }

  const { name, color, description } = body

  if (!name || typeof name !== 'string' || name.trim() === '') {
    return c.json({ error: 'Missing required field: name' }, 400)
  }

  const trimmedName = name.trim()
  const slug = generateSlug(trimmedName)

  if (!slug) {
    return c.json({ error: 'Invalid category name: could not generate a valid slug' }, 400)
  }

  const validColor =
    color && typeof color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(color)
      ? color
      : '#6366f1'

  try {
    const db = getDb(c.env.DB)
    const existing = await db
      .select({ id: categories.id })
      .from(categories)
      .where(or(eq(categories.name, trimmedName), eq(categories.slug, slug)))
      .limit(1)

    if (existing.length > 0) {
      return c.json({ error: 'Category with that name or slug already exists' }, 409)
    }

    const inserted = await db
      .insert(categories)
      .values({
        name: trimmedName,
        slug,
        color: validColor,
        description: description?.trim() ?? null,
        isAiGenerated: false,
      })
      .returning()

    const category = inserted[0]

    return c.json(
      {
        category: {
          id: category.id,
          name: category.name,
          slug: category.slug,
          color: category.color,
          description: category.description,
          isAiGenerated: category.isAiGenerated,
          createdAt: category.createdAt,
          bookmarkCount: 0,
        },
      },
      201
    )
  } catch (err) {
    console.error('Category create error:', err)
    return c.json(
      { error: `Failed to create category: ${err instanceof Error ? err.message : String(err)}` },
      500
    )
  }
})

// GET /api/categories/:slug
route.get('/api/categories/:slug', async (c) => {
  const slug = c.req.param('slug')
  const page = parseIntParam(c.req.query('page'), DEFAULT_PAGE)
  const limit = Math.min(parseIntParam(c.req.query('limit'), DEFAULT_LIMIT), MAX_LIMIT)
  const skip = (page - 1) * limit

  try {
    const d1 = c.env.DB
    const db = getDb(d1)

    const categoryRow = await db
      .select()
      .from(categories)
      .where(eq(categories.slug, slug))
      .limit(1)

    if (categoryRow.length === 0) {
      return c.json({ error: `Category not found: ${slug}` }, 404)
    }
    const category = categoryRow[0]

    const countResult = await d1
      .prepare(
        'SELECT COUNT(*) as total FROM Bookmark b WHERE b.id IN (SELECT bc.bookmarkId FROM BookmarkCategory bc JOIN Category c ON bc.categoryId = c.id WHERE c.slug = ?)'
      )
      .bind(slug)
      .first<{ total: number }>()
    const total = countResult?.total ?? 0

    const idsResult = await d1
      .prepare(
        'SELECT b.id FROM Bookmark b WHERE b.id IN (SELECT bc.bookmarkId FROM BookmarkCategory bc JOIN Category c ON bc.categoryId = c.id WHERE c.slug = ?) ORDER BY b.importedAt DESC LIMIT ? OFFSET ?'
      )
      .bind(slug, limit, skip)
      .all<{ id: string }>()

    const ids = idsResult.results.map((r) => r.id)

    if (ids.length === 0) {
      return c.json({
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

    return c.json({
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
    return c.json(
      { error: `Failed to fetch category: ${err instanceof Error ? err.message : String(err)}` },
      500
    )
  }
})

// DELETE /api/categories/:slug
route.delete('/api/categories/:slug', async (c) => {
  const slug = c.req.param('slug')

  try {
    const db = getDb(c.env.DB)
    const categoryRow = await db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(eq(categories.slug, slug))
      .limit(1)

    if (categoryRow.length === 0) {
      return c.json({ error: `Category not found: ${slug}` }, 404)
    }

    await db.delete(bookmarkCategories).where(eq(bookmarkCategories.categoryId, categoryRow[0].id))
    await db.delete(categories).where(eq(categories.slug, slug))

    return c.json({
      deleted: true,
      slug,
      name: categoryRow[0].name,
    })
  } catch (err) {
    console.error(`Category [${slug}] delete error:`, err)
    return c.json(
      { error: `Failed to delete category: ${err instanceof Error ? err.message : String(err)}` },
      500
    )
  }
})

export default route
