import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { bookmarkCategories } from '@/lib/schema'

// PUT: Replace all categories for a bookmark
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params
  let body: { categoryIds?: string[] } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { categoryIds = [] } = body

  try {
    const db = getDb()
    // Delete existing categories
    await db.delete(bookmarkCategories).where(eq(bookmarkCategories.bookmarkId, id))

    // Insert new categories
    if (categoryIds.length > 0) {
      await db.insert(bookmarkCategories).values(
        categoryIds.map((categoryId) => ({
          bookmarkId: id,
          categoryId,
          confidence: 1.0,
        })),
      )
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to update categories' },
      { status: 500 }
    )
  }
}
