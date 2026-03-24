# Cloudflare Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Siftly from local Node.js to Cloudflare Workers using D1, R2, Durable Objects, and OpenNext adapter.

**Architecture:** Next.js App Router deployed via OpenNext adapter to Cloudflare Workers. SQLite replaced by D1 (Prisma adapter). Media stored in R2. AI pipeline state managed by a Durable Object with alarm-based batch processing. Auth handled by Cloudflare Access + API keys via Workers Secrets.

**Tech Stack:** Next.js 16, OpenNext Cloudflare adapter, Cloudflare D1/R2/Durable Objects, Prisma 7 + @prisma/adapter-d1, Anthropic SDK, OpenAI SDK

**Spec:** `docs/superpowers/specs/2026-03-24-cloudflare-migration-design.md`

---

## File Map

### New Files
| File | Purpose |
|------|---------|
| `wrangler.jsonc` | Workers config: D1, R2, DO, secrets, static assets |
| `open-next.config.ts` | OpenNext adapter config |
| `lib/pipeline-do.ts` | PipelineDO Durable Object class |
| `lib/r2.ts` | R2 media upload/download utilities |
| `app/api/r2/[...key]/route.ts` | R2 media proxy endpoint (not `/api/media/` to avoid conflict with existing twimg proxy) |
| `env.d.ts` | Cloudflare env type definitions |
| `migrations/0001_init.sql` | D1 migration (initial schema) |

### Modified Files
| File | Change |
|------|--------|
| `package.json` | Swap deps: remove better-sqlite3, add @prisma/adapter-d1, @opennextjs/cloudflare, wrangler |
| `prisma/schema.prisma` | Add `previewFeatures = ["driverAdapters"]`, update output path |
| `lib/db.ts` | Rewrite: PrismaBetterSqlite3 → PrismaD1 via getCloudflareContext() |
| `lib/fts.ts` | Bypass Prisma, use D1 binding directly for FTS5 ops |
| `lib/claude-cli-auth.ts` | Gut: remove all Node.js-specific code, keep only `resolveAnthropicClient()` simplified |
| `lib/openai-auth.ts` | Gut: remove filesystem/CLI code, keep only `resolveOpenAIClient()` simplified |
| `lib/ai-client.ts` | Update imports after auth files simplified |
| `lib/categorizer.ts` | Remove CLI imports; rewrite `writeCategoryResults()` $transaction → raw SQL |
| `lib/vision-analyzer.ts` | Remove CLI imports; add R2 caching for images |
| `lib/exporter.ts` | Change JSZip output from `nodebuffer` to `uint8array`; read media from R2 |
| `lib/settings.ts` | Change `import prisma` to `getDb()` call inside functions |
| `lib/rawjson-extractor.ts` | Change `import prisma` to `getDb()` |
| `lib/twitter-api.ts` | Change `import prisma` to `getDb()` |
| `lib/x-sync.ts` | Change `import prisma` to `getDb()` |
| `app/api/categorize/route.ts` | Rewrite: thin proxy to PipelineDO |
| `app/api/bookmarks/route.ts` | Rewrite $transaction → sequential deletes or raw SQL |
| `app/api/export/route.ts` | Change JSZip `nodebuffer` → `uint8array` |
| `app/api/search/ai/route.ts` | Remove CLI imports; change prisma import to getDb() |
| `app/api/settings/test/route.ts` | Remove CLI auth imports; simplify |
| `app/api/settings/route.ts` | Change prisma import to getDb() |
| `app/api/stats/route.ts` | Change prisma import to getDb() |
| `app/api/mindmap/route.ts` | Change prisma import to getDb() |
| `app/api/categories/route.ts` | Change prisma import to getDb() |
| `app/api/categories/[slug]/route.ts` | Change prisma import to getDb() |
| `app/api/import/route.ts` | Change prisma import to getDb() |
| `app/api/import/twitter/route.ts` | Change prisma import to getDb() |
| `app/api/import/live/route.ts` | Change prisma import to getDb() |
| `app/api/import/live/sync/route.ts` | Change prisma import to getDb() |
| `app/api/import/bookmarklet/route.ts` | Change prisma import to getDb() |
| `app/api/bookmarks/[id]/categories/route.ts` | Change prisma import to getDb() |
| `app/api/analyze/images/route.ts` | Change prisma import to getDb() |
| `app/page.tsx` | Change prisma import to getDb() |
| `middleware.ts` | Remove (Cloudflare Access replaces it) |
| `next.config.ts` | Remove `turbopack.root: __dirname` |
| `start.sh` | Update to use `wrangler dev` instead of `next dev` |
| `app/settings/page.tsx` | Remove CLI status UI components (ClaudeCliStatusBox, CodexCliStatusBox) |

### Deleted Files
| File | Reason |
|------|--------|
| `lib/claude-cli.ts` | Subprocess calls, incompatible with Workers |
| `lib/codex-cli.ts` | Subprocess calls, incompatible with Workers |
| `app/api/settings/cli-status/` | CLI auth no longer exists |

---

## Task 1: Project Infrastructure — Dependencies & Config

**Files:**
- Create: `wrangler.jsonc`
- Create: `open-next.config.ts`
- Modify: `package.json`
- Modify: `next.config.ts`
- Delete: `middleware.ts`

- [ ] **Step 1: Update package.json dependencies**

Remove:
```
better-sqlite3
@prisma/adapter-better-sqlite3
@types/better-sqlite3
```

Add:
```
@prisma/adapter-d1
@opennextjs/cloudflare
wrangler (devDependency)
```

Run: `cd /Users/zhiyue/workspace/Siftly-cloudflare && npm remove better-sqlite3 @prisma/adapter-better-sqlite3 @types/better-sqlite3 && npm install @prisma/adapter-d1 @opennextjs/cloudflare && npm install -D wrangler`

- [ ] **Step 2: Create wrangler.jsonc**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "siftly",
  "main": ".open-next/worker.js",
  "compatibility_date": "2025-04-01",
  "compatibility_flags": ["nodejs_compat"],

  "assets": {
    "directory": ".open-next/assets",
    "binding": "ASSETS"
  },

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "siftly-db",
      "database_id": "<YOUR_D1_DATABASE_ID>"
    }
  ],

  "r2_buckets": [
    {
      "binding": "MEDIA_BUCKET",
      "bucket_name": "siftly-media"
    }
  ],

  "durable_objects": {
    "bindings": [
      {
        "name": "PIPELINE_DO",
        "class_name": "PipelineDO"
      }
    ]
  },

  "vars": {
    "ANTHROPIC_BASE_URL": "",
    "OPENAI_BASE_URL": ""
  }
}
```

Note: `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are set via `wrangler secret put`, not in vars.

- [ ] **Step 3: Create open-next.config.ts**

```typescript
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({});
```

- [ ] **Step 4: Update next.config.ts**

Remove `turbopack.root: __dirname`. Keep `images.remotePatterns`.

```typescript
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '*.twimg.com',
      },
    ],
  },
}

export default nextConfig
```

- [ ] **Step 5: Delete middleware.ts**

Cloudflare Access replaces HTTP Basic Auth. Remove the file entirely.

- [ ] **Step 6: Create env.d.ts for Cloudflare binding types**

```typescript
// env.d.ts
interface CloudflareEnv {
  DB: D1Database
  MEDIA_BUCKET: R2Bucket
  PIPELINE_DO: DurableObjectNamespace
  ANTHROPIC_API_KEY: string
  OPENAI_API_KEY: string
  ANTHROPIC_BASE_URL: string
  OPENAI_BASE_URL: string
  ASSETS: Fetcher
}

declare module '@opennextjs/cloudflare' {
  export function getCloudflareContext(): {
    env: CloudflareEnv
    cf: IncomingRequestCfProperties
    ctx: ExecutionContext
  }
}
```

This must be added early — nearly every subsequent task depends on these types.

- [ ] **Step 7: Update start.sh**

Replace `npx next dev` with `npx wrangler dev` (or `npx opennextjs-cloudflare dev`). Keep the deps install and prisma generate steps.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: add Cloudflare infrastructure — wrangler, OpenNext, deps swap"
```

---

## Task 2: Prisma Schema & D1 Migration

**Files:**
- Modify: `prisma/schema.prisma`
- Modify: `prisma.config.ts`
- Create: `migrations/0001_init.sql`

- [ ] **Step 1: Update prisma/schema.prisma**

Change generator to:
```prisma
generator client {
  provider        = "prisma-client"
  output          = "../app/generated/prisma"
  previewFeatures = ["driverAdapters"]
}

datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```

The `url` is needed for Prisma CLI operations (migrate diff). At runtime D1 binding is used instead.

- [ ] **Step 2: Generate D1 migration SQL**

```bash
cd /Users/zhiyue/workspace/Siftly-cloudflare
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > migrations/0001_init.sql
```

Review the generated SQL to ensure it creates all tables correctly.

- [ ] **Step 3: Update prisma.config.ts**

Update to work with D1 migration workflow. The file is only used by Prisma CLI locally.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "feat: update Prisma schema for D1 driver adapter"
```

---

## Task 3: Data Layer — Rewrite lib/db.ts

**Files:**
- Modify: `lib/db.ts`

- [ ] **Step 1: Rewrite lib/db.ts**

```typescript
import { PrismaD1 } from '@prisma/adapter-d1'
import { PrismaClient } from '@/app/generated/prisma/client'
import { getCloudflareContext } from '@opennextjs/cloudflare'

/**
 * Returns a PrismaClient backed by Cloudflare D1.
 * Must only be called inside request handlers (not at module top-level).
 */
export function getDb(): PrismaClient {
  const { env } = getCloudflareContext()
  return new PrismaClient({
    adapter: new PrismaD1(env.DB),
  })
}

/**
 * Returns the raw D1 database binding for direct SQL operations (FTS5, batch).
 */
export function getD1(): D1Database {
  const { env } = getCloudflareContext()
  return env.DB
}

// Backward-compatible default export.
// Caches per-request to avoid creating PrismaClient on every property access.
let _cached: PrismaClient | null = null

export default new Proxy({} as PrismaClient, {
  get(_target, prop) {
    if (!_cached) _cached = getDb()
    return (_cached as Record<string | symbol, unknown>)[prop]
  },
})
```

The Proxy default export allows gradual migration — existing `import prisma from '@/lib/db'` calls continue to work as long as they execute inside a request context. This avoids changing 25+ files atomically.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Users/zhiyue/workspace/Siftly-cloudflare && npx tsc --noEmit 2>&1 | head -20`

Expect type errors from removed deps (better-sqlite3) — those are expected at this stage.

- [ ] **Step 3: Commit**

```bash
git add lib/db.ts && git commit -m "feat: rewrite db layer for Cloudflare D1"
```

---

## Task 4: Auth Layer — Remove Node.js-specific Auth Code

**Files:**
- Modify: `lib/claude-cli-auth.ts`
- Modify: `lib/openai-auth.ts`
- Modify: `lib/ai-client.ts`
- Delete: `lib/claude-cli.ts`
- Delete: `lib/codex-cli.ts`
- Modify: `app/api/settings/test/route.ts`
- Delete: `app/api/settings/cli-status/`

- [ ] **Step 1: Rewrite lib/claude-cli-auth.ts**

Remove all Node.js imports (child_process, fs, os). Keep only `resolveAnthropicClient()` simplified:

```typescript
import Anthropic from '@anthropic-ai/sdk'
import { getCloudflareContext } from '@opennextjs/cloudflare'

/**
 * Resolves an Anthropic client. Auth chain:
 * 1. Override key (from request)
 * 2. DB-saved key
 * 3. ANTHROPIC_API_KEY Workers Secret
 */
export function resolveAnthropicClient(options: {
  overrideKey?: string
  dbKey?: string
  baseURL?: string
} = {}): Anthropic {
  const { env } = getCloudflareContext()
  const baseURL = options.baseURL || env.ANTHROPIC_BASE_URL || undefined

  if (options.overrideKey?.trim()) {
    return new Anthropic({ apiKey: options.overrideKey.trim(), ...(baseURL ? { baseURL } : {}) })
  }

  if (options.dbKey?.trim()) {
    return new Anthropic({ apiKey: options.dbKey.trim(), ...(baseURL ? { baseURL } : {}) })
  }

  const envKey = (env.ANTHROPIC_API_KEY as string | undefined)?.trim()
  if (envKey) {
    return new Anthropic({ apiKey: envKey, ...(baseURL ? { baseURL } : {}) })
  }

  if (baseURL) {
    return new Anthropic({ apiKey: 'proxy', baseURL })
  }

  throw new Error('No Anthropic API key found. Add your key in Settings.')
}
```

- [ ] **Step 2: Rewrite lib/openai-auth.ts**

Remove all Node.js imports. Keep only `resolveOpenAIClient()` simplified:

```typescript
import OpenAI from 'openai'
import { getCloudflareContext } from '@opennextjs/cloudflare'

/**
 * Resolves an OpenAI client. Auth chain:
 * 1. Override key (from request)
 * 2. DB-saved key
 * 3. OPENAI_API_KEY Workers Secret
 */
export function resolveOpenAIClient(options: {
  overrideKey?: string
  dbKey?: string
  baseURL?: string
} = {}): OpenAI {
  const { env } = getCloudflareContext()
  const baseURL = options.baseURL || env.OPENAI_BASE_URL || undefined

  if (options.overrideKey?.trim()) {
    return new OpenAI({ apiKey: options.overrideKey.trim(), ...(baseURL ? { baseURL } : {}) })
  }

  if (options.dbKey?.trim()) {
    return new OpenAI({ apiKey: options.dbKey.trim(), ...(baseURL ? { baseURL } : {}) })
  }

  const envKey = (env.OPENAI_API_KEY as string | undefined)?.trim()
  if (envKey) {
    return new OpenAI({ apiKey: envKey, ...(baseURL ? { baseURL } : {}) })
  }

  if (baseURL) {
    return new OpenAI({ apiKey: 'proxy', baseURL })
  }

  throw new Error('No OpenAI API key found. Add your key in Settings.')
}
```

- [ ] **Step 3: Update lib/ai-client.ts**

Remove re-exports. Update imports to point to simplified files:

```typescript
import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { resolveAnthropicClient } from './claude-cli-auth'
import { resolveOpenAIClient } from './openai-auth'
import { getProvider } from './settings'
```

No other changes — the `AIClient` interface and implementations stay the same.

- [ ] **Step 4: Delete lib/claude-cli.ts and lib/codex-cli.ts**

```bash
rm lib/claude-cli.ts lib/codex-cli.ts
```

- [ ] **Step 5: Delete app/api/settings/cli-status/ directory**

```bash
rm -rf app/api/settings/cli-status
```

- [ ] **Step 6: Update app/api/settings/test/route.ts**

Remove `getCliAuthStatus` import. Simplify to only test API keys.

- [ ] **Step 7: Update app/settings/page.tsx**

Remove `ClaudeCliStatusBox` and `CodexCliStatusBox` components (they fetch from the deleted `/api/settings/cli-status` endpoint). Remove any UI that displays CLI auth status.

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: remove Node.js-specific auth, simplify to API key only"
```

---

## Task 5: Remove CLI Imports from AI Consumers

**Files:**
- Modify: `lib/categorizer.ts`
- Modify: `lib/vision-analyzer.ts`
- Modify: `app/api/search/ai/route.ts`

- [ ] **Step 1: Clean lib/categorizer.ts**

Remove lines 3-4:
```
import { getCliAvailability, claudePrompt, modelNameToCliAlias } from '@/lib/claude-cli-auth'
import { getCodexCliAvailability, codexPrompt } from '@/lib/codex-cli'
```

Search for all usages of these functions in the file and remove the CLI-first fallback paths. All AI calls should go through the `AIClient` interface (via `resolveAIClient()`).

- [ ] **Step 2: Clean lib/vision-analyzer.ts**

Same pattern — remove CLI imports (lines 3-4) and all CLI fallback code paths. All vision/enrichment calls go through `AIClient`.

- [ ] **Step 3: Clean app/api/search/ai/route.ts**

Remove lines 7-8 CLI imports. Remove CLI fallback logic. AI search calls go through `AIClient`.

- [ ] **Step 4: Verify no remaining CLI references**

```bash
cd /Users/zhiyue/workspace/Siftly-cloudflare
grep -rn "claude-cli\|codex-cli\|getCliAvailability\|claudePrompt\|codexPrompt\|getCodexCli" --include="*.ts" lib/ app/
```

Expect: zero matches (except possibly the auth files themselves which were already rewritten).

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: remove all CLI fallback paths from AI consumers"
```

---

## Task 6: FTS5 — Bypass Prisma for Direct D1 SQL

**Files:**
- Modify: `lib/fts.ts`

- [ ] **Step 1: Rewrite lib/fts.ts to use D1 binding directly**

```typescript
import { getD1, getDb } from '@/lib/db'

const FTS_TABLE = 'bookmark_fts'

export async function ensureFtsTable(): Promise<void> {
  const db = getD1()
  await db.prepare(`
    CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(
      bookmark_id UNINDEXED,
      text,
      semantic_tags,
      entities,
      image_tags,
      tokenize='porter unicode61'
    )
  `).run()
}

export async function rebuildFts(): Promise<void> {
  const db = getD1()
  const prisma = getDb()
  await ensureFtsTable()
  await db.prepare(`DELETE FROM ${FTS_TABLE}`).run()

  // Paginate to avoid D1 response size limits
  // D1 batch() limit is ~100 statements per call
  const PAGE_SIZE = 100
  let cursor: string | undefined

  while (true) {
    const bookmarks = await prisma.bookmark.findMany({
      take: PAGE_SIZE,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: {
        id: true,
        text: true,
        semanticTags: true,
        entities: true,
        mediaItems: { select: { imageTags: true } },
      },
    })

    if (bookmarks.length === 0) break

    const stmts = bookmarks.map((b) => {
      const imageTagsText = b.mediaItems
        .map((m) => m.imageTags ?? '')
        .filter(Boolean)
        .join(' ')
      return db.prepare(
        `INSERT INTO ${FTS_TABLE}(bookmark_id, text, semantic_tags, entities, image_tags) VALUES (?, ?, ?, ?, ?)`
      ).bind(b.id, b.text, b.semanticTags ?? '', b.entities ?? '', imageTagsText)
    })

    await db.batch(stmts)
    cursor = bookmarks[bookmarks.length - 1].id
  }
}

export async function ftsSearch(keywords: string[]): Promise<string[]> {
  if (keywords.length === 0) return []

  try {
    const db = getD1()
    await ensureFtsTable()

    const terms = keywords
      .map((kw) => kw.replace(/["*()]/g, ' ').trim())
      .filter((kw) => kw.length >= 2)

    if (terms.length === 0) return []

    const matchQuery = terms.join(' OR ')

    const { results } = await db.prepare(
      `SELECT bookmark_id FROM ${FTS_TABLE} WHERE ${FTS_TABLE} MATCH ? ORDER BY rank LIMIT 150`
    ).bind(matchQuery).all<{ bookmark_id: string }>()

    return results.map((r) => r.bookmark_id)
  } catch {
    return []
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/fts.ts && git commit -m "feat: rewrite FTS5 to use D1 binding directly"
```

---

## Task 7: Fix $transaction Call Sites

**Files:**
- Modify: `lib/categorizer.ts` (writeCategoryResults)
- Modify: `app/api/bookmarks/route.ts` (DELETE handler)

- [ ] **Step 1: Rewrite writeCategoryResults in lib/categorizer.ts**

Replace the `prisma.$transaction([...upsertOps, ...])` with D1 batch:

```typescript
import { getD1 } from '@/lib/db'

// Inside writeCategoryResults(), replace the $transaction block:
const d1 = getD1()
const stmts: D1PreparedStatement[] = []

for (const { category: slug, confidence } of result.assignments) {
  const categoryId = categoryBySlug.get(slug)
  if (!categoryId) continue
  stmts.push(
    d1.prepare(
      `INSERT INTO BookmarkCategory (bookmarkId, categoryId, confidence)
       VALUES (?, ?, ?)
       ON CONFLICT (bookmarkId, categoryId) DO UPDATE SET confidence = ?`
    ).bind(bookmarkId, categoryId, confidence, confidence)
  )
  bookmarkIdsToUpdate.push(bookmarkId)
}

if (stmts.length === 0) return

// Add the updateMany as raw SQL
const placeholders = bookmarkIdsToUpdate.map(() => '?').join(',')
stmts.push(
  d1.prepare(
    `UPDATE Bookmark SET enrichedAt = ? WHERE id IN (${placeholders})`
  ).bind(now.toISOString(), ...bookmarkIdsToUpdate)
)

await d1.batch(stmts)
```

- [ ] **Step 2: Rewrite DELETE handler in app/api/bookmarks/route.ts**

Replace `prisma.$transaction([...deleteMany])` with sequential deletes:

```typescript
export async function DELETE(): Promise<NextResponse> {
  try {
    const prisma = getDb()
    // D1 doesn't support interactive transactions.
    // Delete in dependency order. These are all-or-nothing enough for a clear-all operation.
    await prisma.bookmarkCategory.deleteMany({})
    await prisma.mediaItem.deleteMany({})
    await prisma.bookmark.deleteMany({})
    await prisma.category.deleteMany({})
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('Clear bookmarks error:', err)
    return NextResponse.json(
      { error: `Failed to clear bookmarks: ${err instanceof Error ? err.message : String(err)}` },
      { status: 500 }
    )
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: replace \$transaction with D1 batch/sequential ops"
```

---

## Task 8: R2 Media Layer

**Files:**
- Create: `lib/r2.ts`
- Create: `app/api/r2/[...key]/route.ts`

- [ ] **Step 1: Create lib/r2.ts**

```typescript
import { getCloudflareContext } from '@opennextjs/cloudflare'

function getBucket(): R2Bucket {
  const { env } = getCloudflareContext()
  return env.MEDIA_BUCKET
}

export async function uploadMedia(
  key: string,
  data: ArrayBuffer | ReadableStream | Uint8Array,
  contentType: string
): Promise<void> {
  const bucket = getBucket()
  await bucket.put(key, data, {
    httpMetadata: { contentType },
  })
}

export async function getMedia(key: string): Promise<R2ObjectBody | null> {
  const bucket = getBucket()
  return bucket.get(key)
}

export async function deleteMedia(key: string): Promise<void> {
  const bucket = getBucket()
  await bucket.delete(key)
}

export function mediaKey(bookmarkId: string, filename: string): string {
  return `media/${bookmarkId}/${filename}`
}
```

- [ ] **Step 2: Create app/api/r2/[...key]/route.ts**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getMedia } from '@/lib/r2'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ key: string[] }> }
): Promise<NextResponse> {
  const { key } = await params
  const objectKey = key.join('/')

  const object = await getMedia(objectKey)
  if (!object) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  const headers = new Headers()
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'application/octet-stream')
  headers.set('Cache-Control', 'public, max-age=31536000, immutable')

  return new NextResponse(object.body, { headers })
}
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: add R2 media storage layer and proxy endpoint"
```

---

## Task 9: Durable Object — PipelineDO

**Files:**
- Create: `lib/pipeline-do.ts`
- Modify: `app/api/categorize/route.ts`

- [ ] **Step 1: Create lib/pipeline-do.ts**

Implement the `PipelineDO` class with:
- `fetch()` handler routing GET/POST/DELETE to status/start/stop
- `alarm()` handler for batch processing
- State stored in `this.ctx.storage` (DO built-in KV)
- Pipeline stages: vision → entities → enrichment → categorize
- Each alarm processes a batch of bookmarks for the current stage
- Advances to next stage when current stage completes

Key design:
- `POST /start`: loads uncategorized bookmark IDs into storage, sets first alarm
- `GET /status`: returns current state JSON
- `DELETE /stop`: sets abort flag, state resets on next alarm check
- `alarm()`: dequeues next batch, processes it, stores results, schedules next alarm

The pipeline logic from the current `categorize/route.ts` POST handler moves here, adapted for batch-per-alarm execution.

**Important:** Durable Objects run in a different context than the Next.js worker. `getCloudflareContext()` does NOT work inside a DO. The DO receives `env` via its constructor and must create its own PrismaClient:

```typescript
export class PipelineDO extends DurableObject {
  private db: D1Database
  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env)
    this.db = env.DB
  }
  private getPrisma() {
    return new PrismaClient({ adapter: new PrismaD1(this.db) })
  }
}
```

This is the largest and most complex file. The full implementation should:
1. Use `this.db` and `this.getPrisma()` for database access (NOT `getDb()`/`getD1()`)
2. Import `categorizeBatch`, `mapBookmarkForCategorization`, `writeCategoryResults`, `seedDefaultCategories` from `lib/categorizer.ts`
3. Import `analyzeItem`, `enrichBatchSemanticTags` from `lib/vision-analyzer.ts`
4. Import `backfillEntities` from `lib/rawjson-extractor.ts`
5. Import `rebuildFts` from `lib/fts.ts`
6. Track state: `{ status, stage, done, total, stageCounts, lastError, error, pendingIds, currentBatchIndex }`
7. Process ~10 bookmarks per alarm tick
8. Call `this.ctx.storage.setAlarm(Date.now() + 100)` to schedule next batch (100ms delay)

- [ ] **Step 2: Rewrite app/api/categorize/route.ts**

Replace the entire file with a thin proxy:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getCloudflareContext } from '@opennextjs/cloudflare'

function getPipelineDO(): DurableObjectStub {
  const { env } = getCloudflareContext()
  const id = env.PIPELINE_DO.idFromName('singleton')
  return env.PIPELINE_DO.get(id)
}

export async function GET(): Promise<NextResponse> {
  const stub = getPipelineDO()
  const resp = await stub.fetch(new Request('https://do/status'))
  const data = await resp.json()
  return NextResponse.json(data)
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const stub = getPipelineDO()
  const body = await request.text()
  const resp = await stub.fetch(new Request('https://do/start', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/json' },
  }))
  const data = await resp.json()
  return NextResponse.json(data)
}

export async function DELETE(): Promise<NextResponse> {
  const stub = getPipelineDO()
  const resp = await stub.fetch(new Request('https://do/stop', { method: 'DELETE' }))
  const data = await resp.json()
  return NextResponse.json(data)
}
```

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: implement PipelineDO and proxy categorize route"
```

---

## Task 10: Export & JSZip Fix

**Files:**
- Modify: `lib/exporter.ts`
- Modify: `app/api/export/route.ts`

- [ ] **Step 1: Fix lib/exporter.ts**

Change `zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })` to:
```typescript
zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' })
```

Update any code that expects `Buffer` return to handle `Uint8Array` instead.

- [ ] **Step 2: Fix app/api/export/route.ts**

Same change: `type: 'nodebuffer'` → `type: 'uint8array'`.

Update the Response constructor to use `Uint8Array` directly (which works as a valid BodyInit).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "fix: use uint8array for JSZip output (Workers compat)"
```

---

## Task 11: Bulk Prisma Import Update

**Files:** All remaining files that `import prisma from '@/lib/db'`

The Proxy-based default export from Task 3 makes this optional for correctness, but for cleanliness these should be updated.

- [ ] **Step 1: Update all API routes and lib files**

For each file listed in the File Map under "Change prisma import to getDb()":

Replace:
```typescript
import prisma from '@/lib/db'
```

With usage of `getDb()` inside functions:
```typescript
import { getDb } from '@/lib/db'
// Then inside each function:
const prisma = getDb()
```

Files (16 API routes + 4 lib files + 1 page):
- `lib/settings.ts`
- `lib/rawjson-extractor.ts`
- `lib/twitter-api.ts`
- `lib/x-sync.ts`
- `app/page.tsx`
- `app/api/stats/route.ts`
- `app/api/mindmap/route.ts`
- `app/api/settings/route.ts`
- `app/api/settings/test/route.ts`
- `app/api/categories/route.ts`
- `app/api/categories/[slug]/route.ts`
- `app/api/import/route.ts`
- `app/api/import/twitter/route.ts`
- `app/api/import/live/route.ts`
- `app/api/import/live/sync/route.ts`
- `app/api/import/bookmarklet/route.ts`
- `app/api/bookmarks/[id]/categories/route.ts`
- `app/api/analyze/images/route.ts`
- `app/api/search/ai/route.ts`
- `app/api/export/route.ts`
- `app/api/bookmarks/route.ts`

- [ ] **Step 2: Verify no remaining old imports**

```bash
grep -rn "import prisma from" --include="*.ts" --include="*.tsx" lib/ app/
```

Expect: zero matches.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "refactor: migrate all prisma imports to getDb()"
```

---

## Task 12: Vision Analyzer — R2 Integration

**Files:**
- Modify: `lib/vision-analyzer.ts`

- [ ] **Step 1: Add R2 caching to vision-analyzer.ts**

In `fetchImageAsBase64()` or wherever images are fetched for analysis:
- Before fetching from `twimg.com`, check if the image exists in R2
- After fetching from the original URL, upload to R2 for future use
- Update `MediaItem.localPath` with the R2 key

Use `getMedia()` and `uploadMedia()` from `lib/r2.ts`.

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "feat: add R2 caching for vision analysis images"
```

---

## Task 13: Build Verification & Final Cleanup

**Files:** Various

- [ ] **Step 1: Run TypeScript check**

```bash
cd /Users/zhiyue/workspace/Siftly-cloudflare && npx tsc --noEmit
```

Fix any type errors.

- [ ] **Step 2: Verify no Node.js-only imports remain**

```bash
grep -rn "child_process\|'fs'\|from 'os'" --include="*.ts" lib/ app/
```

Expect: zero matches.

- [ ] **Step 3: Attempt OpenNext build**

```bash
npx opennextjs-cloudflare build
```

Fix any build errors.

- [ ] **Step 4: Test with wrangler dev**

```bash
npx wrangler dev
```

Verify the app starts locally with D1 local emulator.

- [ ] **Step 5: Commit any remaining fixes**

```bash
git add -A && git commit -m "fix: resolve build errors for Cloudflare Workers"
```

---

## Task 14: CLI Tool Adaptation

**Files:**
- Modify: `cli/siftly.ts`

- [ ] **Step 1: Update CLI for remote D1 access**

The CLI needs to work differently now:
- Add `--remote` flag to query the deployed D1 via REST API or `wrangler d1 execute`
- For local dev, it can use `wrangler d1 execute --local`
- Update the database access to not import from `@/lib/db` (which requires Cloudflare context)

- [ ] **Step 2: Commit**

```bash
git add -A && git commit -m "feat: adapt CLI tool for D1 remote access"
```
