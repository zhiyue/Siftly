import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  primaryKey,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import { relations } from 'drizzle-orm'

// ── ID generator ────────────────────────────────────────────────────────────

function generateId(): string {
  // cuid-like: timestamp + random chars
  const ts = Date.now().toString(36)
  const rand = Array.from(crypto.getRandomValues(new Uint8Array(8)))
    .map((b) => b.toString(36).padStart(2, '0'))
    .join('')
    .slice(0, 12)
  return `c${ts}${rand}`
}

// ── Tables ──────────────────────────────────────────────────────────────────

export const bookmarks = sqliteTable(
  'Bookmark',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => generateId()),
    tweetId: text('tweetId').notNull().unique(),
    text: text('text').notNull(),
    authorHandle: text('authorHandle').notNull(),
    authorName: text('authorName').notNull(),
    tweetCreatedAt: text('tweetCreatedAt'),
    importedAt: text('importedAt')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    rawJson: text('rawJson').notNull(),
    semanticTags: text('semanticTags'),
    entities: text('entities'),
    enrichedAt: text('enrichedAt'),
    enrichmentMeta: text('enrichmentMeta'),
    source: text('source').notNull().default('bookmark'),
  },
  (table) => [
    index('Bookmark_authorHandle_idx').on(table.authorHandle),
    index('Bookmark_tweetCreatedAt_idx').on(table.tweetCreatedAt),
    index('Bookmark_enrichedAt_idx').on(table.enrichedAt),
    index('Bookmark_source_idx').on(table.source),
  ],
)

export const categories = sqliteTable(
  'Category',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => generateId()),
    name: text('name').notNull().unique(),
    slug: text('slug').notNull().unique(),
    color: text('color').notNull().default('#6366f1'),
    description: text('description'),
    isAiGenerated: integer('isAiGenerated', { mode: 'boolean' })
      .notNull()
      .default(false),
    createdAt: text('createdAt')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
)

export const bookmarkCategories = sqliteTable(
  'BookmarkCategory',
  {
    bookmarkId: text('bookmarkId')
      .notNull()
      .references(() => bookmarks.id, { onDelete: 'cascade' }),
    categoryId: text('categoryId')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    confidence: real('confidence').notNull().default(1.0),
  },
  (table) => [
    primaryKey({ columns: [table.bookmarkId, table.categoryId] }),
  ],
)

export const mediaItems = sqliteTable(
  'MediaItem',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => generateId()),
    bookmarkId: text('bookmarkId')
      .notNull()
      .references(() => bookmarks.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    url: text('url').notNull(),
    thumbnailUrl: text('thumbnailUrl'),
    localPath: text('localPath'),
    imageTags: text('imageTags'),
  },
  (table) => [
    index('MediaItem_bookmarkId_idx').on(table.bookmarkId),
    index('MediaItem_url_idx').on(table.url),
  ],
)

export const importJobs = sqliteTable('ImportJob', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => generateId()),
  filename: text('filename').notNull(),
  status: text('status').notNull().default('pending'),
  totalCount: integer('totalCount').notNull().default(0),
  processedCount: integer('processedCount').notNull().default(0),
  errorMessage: text('errorMessage'),
  createdAt: text('createdAt')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  updatedAt: text('updatedAt')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
})

export const settings = sqliteTable('Setting', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

// ── Relations ───────────────────────────────────────────────────────────────

export const bookmarkRelations = relations(bookmarks, ({ many }) => ({
  categories: many(bookmarkCategories),
  mediaItems: many(mediaItems),
}))

export const categoryRelations = relations(categories, ({ many }) => ({
  bookmarks: many(bookmarkCategories),
}))

export const bookmarkCategoryRelations = relations(
  bookmarkCategories,
  ({ one }) => ({
    bookmark: one(bookmarks, {
      fields: [bookmarkCategories.bookmarkId],
      references: [bookmarks.id],
    }),
    category: one(categories, {
      fields: [bookmarkCategories.categoryId],
      references: [categories.id],
    }),
  }),
)

export const mediaItemRelations = relations(mediaItems, ({ one }) => ({
  bookmark: one(bookmarks, {
    fields: [mediaItems.bookmarkId],
    references: [bookmarks.id],
  }),
}))
