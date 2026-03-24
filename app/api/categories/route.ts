import { NextRequest, NextResponse } from 'next/server'
import { eq, or, asc, count as countFn, desc } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { categories, bookmarkCategories } from '@/lib/schema'
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

export async function GET(): Promise<NextResponse> {
  try {
    const db = getDb()
    // Seed defaults on first load so the nav always has categories
    const [{ count: catCount }] = await db.select({ count: countFn() }).from(categories)
    if (catCount === 0) await seedDefaultCategories()

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

    return NextResponse.json({ categories: formatted })
  } catch (err) {
    console.error('Categories fetch error:', err)
    return NextResponse.json(
      { error: `Failed to fetch categories: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { name?: string; color?: string; description?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { name, color, description } = body

  if (!name || typeof name !== 'string' || name.trim() === '') {
    return NextResponse.json(
      { error: 'Missing required field: name' },
      { status: 400 }
    )
  }

  const trimmedName = name.trim()
  const slug = generateSlug(trimmedName)

  if (!slug) {
    return NextResponse.json(
      { error: 'Invalid category name: could not generate a valid slug' },
      { status: 400 }
    )
  }

  const validColor =
    color && typeof color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(color)
      ? color
      : '#6366f1'

  try {
    const db = getDb()
    const existing = await db
      .select({ id: categories.id })
      .from(categories)
      .where(or(eq(categories.name, trimmedName), eq(categories.slug, slug)))
      .limit(1)

    if (existing.length > 0) {
      return NextResponse.json(
        { error: `Category with that name or slug already exists` },
        { status: 409 }
      )
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

    return NextResponse.json(
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
      { status: 201 }
    )
  } catch (err) {
    console.error('Category create error:', err)
    return NextResponse.json(
      { error: `Failed to create category: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}
