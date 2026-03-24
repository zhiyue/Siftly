# Siftly Cloudflare Migration Design

**Date:** 2026-03-24
**Status:** Approved
**Branch:** `feat/cloudflare-migration`

## Overview

Migrate Siftly from a local Node.js self-hosted app to a Cloudflare Workers self-hosted deployment, fully adopting the Cloudflare ecosystem. The app remains single-user, self-hosted — only the runtime environment changes.

## Technical Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Framework | Next.js + OpenNext adapter | Minimal code changes, preserves App Router |
| Database | Cloudflare D1 + Prisma + @prisma/adapter-d1 | D1 is SQLite-compatible, Prisma adapter exists |
| Full-text search | D1 FTS5 | D1 supports FTS5 virtual tables natively |
| AI pipeline state | Durable Objects | Persistent in-memory state, supports long-running tasks via Alarms |
| Media storage | Cloudflare R2 | S3-compatible, free egress, native Workers integration |
| Access control | Cloudflare Access (Zero Trust) | No app code changes needed, handles auth at the edge |
| AI authentication | API key via Workers Secrets | Claude CLI auth removed (relies on Node.js-only APIs) |
| Migration strategy | One-shot in worktree | All changes made together in an isolated branch |

## Section 1: Project Infrastructure

### New Files

- `wrangler.jsonc` — Workers configuration with all bindings
- `open-next.config.ts` — OpenNext adapter configuration with R2 incremental cache

### Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | D1 | Main database (replaces SQLite file) |
| `MEDIA_BUCKET` | R2 | Tweet media file storage |
| `PIPELINE_DO` | Durable Object | AI categorization pipeline state |
| `ANTHROPIC_API_KEY` | Secret | Anthropic API key |
| `OPENAI_API_KEY` | Secret | OpenAI API key (optional) |

### Dependency Changes

**Remove:**
- `better-sqlite3`
- `@prisma/adapter-better-sqlite3`
- `@types/better-sqlite3`

**Add:**
- `@prisma/adapter-d1`
- `@opennextjs/cloudflare`
- `wrangler`

### Prisma Schema

- `datasource` keeps `provider = "sqlite"` (D1 is SQLite)
- Generator adds `previewFeatures = ["driverAdapters"]`
- Migrations executed via `wrangler d1 migrations apply`

### CLI Tool (`cli/siftly.ts`)

Retained. Adapted to access remote D1 via `wrangler d1 execute` or D1 REST API. Add `--remote` flag to distinguish local dev vs remote.

## Section 2: Data Layer

### `lib/db.ts` Rewrite

Replace the module-level singleton pattern with a function that obtains D1 from Cloudflare context:

```typescript
import { PrismaD1 } from '@prisma/adapter-d1'
import { getCloudflareContext } from '@opennextjs/cloudflare'

export function getDb() {
  const { env } = getCloudflareContext()
  return new PrismaClient({ adapter: new PrismaD1(env.DB) })
}
```

All `import prisma from '@/lib/db'` calls across the codebase change to `const prisma = getDb()`.

**Important:** `getCloudflareContext()` only works inside a request context. `getDb()` must only be called inside route handlers or functions that run within a request — never at module top-level. Module-level `const prisma = getDb()` will crash.

### Module-Level Caches

Several files use module-level caches (`lib/settings.ts`, `app/api/search/ai/route.ts`) that rely on long-lived process memory. Workers are stateless — these caches will be cold on each request. This is acceptable for a single-user app with D1's low latency. No changes needed, but be aware of the behavior difference.

### FTS5 (`lib/fts.ts`)

D1 supports FTS5 virtual tables. Core logic preserved with adjustments:

- Raw SQL operations (CREATE VIRTUAL TABLE, INSERT, MATCH) may need to bypass Prisma and use `env.DB.prepare(...).run()` directly, since Prisma's D1 adapter has limited raw SQL support
- D1 does not support exporting databases with virtual tables — backup strategy must account for this

### FTS5 Implementation Strategy

All FTS5 operations bypass Prisma entirely and use the D1 binding directly (`env.DB.prepare(...).run()`). Prisma's D1 adapter has limited and inconsistent support for `$executeRawUnsafe`, `$executeRaw`, and `$queryRaw`. To avoid implementation churn, `lib/fts.ts` will accept a D1 database handle and use it directly for all CREATE VIRTUAL TABLE, INSERT, and MATCH operations.

### D1 Transaction Limitation

D1 does not support interactive transactions (`prisma.$transaction([...])`). All affected call sites:

1. **`lib/fts.ts`** — batch inserts during FTS rebuild → use `env.DB.batch([...prepared statements])`
2. **`lib/categorizer.ts` `writeCategoryResults()`** — upserts + updateMany → rewrite as raw SQL via `env.DB.batch()`
3. **`app/api/bookmarks/route.ts` DELETE handler** — batch deleteMany → rewrite as raw SQL or sequential operations

Note: Prisma client operations (e.g., `prisma.bookmarkCategory.upsert`) cannot be passed to D1's batch API. These must be rewritten as raw prepared SQL statements.

### D1 Query Size Limits

D1 has a 10MB response size limit per query. The `rawJson` field stores full tweet JSON which can be large. Operations that fetch all bookmarks (like FTS rebuild) must use cursor-based pagination to avoid exceeding limits.

## Section 3: AI Authentication Layer

### Removed

All Node.js-specific auth code from `lib/claude-cli-auth.ts`:
- `readMacCredentials()` — macOS keychain via `execSync`
- `readFileCredentials()` — filesystem credential reading
- `readCliCredentials()` — credential caching
- `getCliOAuthToken()` / `createCliAnthropicClient()` / `createEnvCliAnthropicClient()`
- `getCliAuthStatus()`

Also removed:
- `lib/claude-cli.ts` — CLI subprocess calls (`claudePrompt()`, `spawnSync`)
- `lib/codex-cli.ts` — subprocess calls (`codexPrompt()`)
- `lib/openai-auth.ts` — same Node.js dependencies (`readFileSync`, `homedir`, `fs`, `os`, `path`); `resolveOpenAIClient()` simplified to: override key → DB-saved key → `OPENAI_API_KEY` Workers Secret

### Simplified Auth Chain

`resolveAnthropicClient()` reduced to:
1. Override key (from request body)
2. DB-saved key (Setting table)
3. `ANTHROPIC_API_KEY` from Workers Secret (via `getCloudflareContext().env`)

### Removed Routes/UI

- `app/api/settings/cli-status/` — entire route deleted
- `app/api/settings/test/` — simplified to only test API key
- Settings page — CLI auth status card removed

### Code Cleanup

Remove all imports of `getCliAvailability`, `claudePrompt`, `modelNameToCliAlias`, `codexPrompt`, `getCodexCliAvailability` from all files. Complete list of affected files:

- `lib/ai-client.ts`
- `lib/categorizer.ts`
- `lib/vision-analyzer.ts`
- `app/api/search/ai/route.ts`

All CLI-first, SDK-fallback patterns in these files must be replaced with SDK-only paths.

## Section 4: Pipeline State Layer (Durable Objects)

### Architecture

```
Frontend (polling)
  ↓
API Route (GET/POST/DELETE /api/categorize)
  ↓ fetch to DO
PipelineDO (singleton, fixed ID)
  ├── start() → begins pipeline execution
  ├── stop() → sets abort flag
  └── status() → returns current state
```

### `PipelineDO` Class (`lib/pipeline-do.ts`)

Responsibilities:
- Hold pipeline state (stage, done, total, stageCounts, error)
- Receive commands from API routes (start / stop / status)
- Execute the pipeline (vision → entities → enrichment → categorize)
- Persist state in DO's built-in SQLite storage (`this.ctx.storage`)

### Long Task Execution via Alarms

Durable Objects have a 30s CPU time limit per request but support Alarms:
- Process one batch per alarm invocation (batch = N bookmarks, configurable)
- Set next alarm after each batch completes
- State persists across alarm invocations in DO storage
- Frontend polls GET endpoint for progress (no SSE needed)

### Batch Processing Design

The current pipeline uses `runWithConcurrency` (5 parallel workers), `catPending` queue with flush threshold, and closure-based state. This must be redesigned for alarm-based execution:

- **Batch unit**: a fixed number of bookmarks (e.g., 10) processed per alarm tick
- **Queue**: pending bookmark IDs stored in DO SQLite storage, dequeued per batch
- **Sequential stages**: each alarm tick processes one stage for the current batch, then advances
- **No concurrent workers**: DO is single-threaded; process bookmarks sequentially within each batch
- **Categorization flush**: accumulate category results in DO storage, flush to D1 at stage boundaries

### Wrangler Config

```jsonc
"durable_objects": {
  "bindings": [{ "name": "PIPELINE_DO", "class_name": "PipelineDO" }]
}
```

### API Route Simplification

`app/api/categorize/route.ts` becomes a thin proxy:
- GET/POST/DELETE all forward to the DO singleton instance (ID: `"singleton"`)
- All `globalThis` state code removed

## Section 5: Media Storage Layer (R2)

### New Module: `lib/r2.ts`

Utility functions:
- `uploadMedia(key, data, contentType)` — upload to R2
- `getMediaUrl(key)` — generate access URL
- `deleteMedia(key)` — remove from R2

### Storage Strategy

- `MediaItem.localPath` field semantics change to R2 object key (e.g., `media/{bookmarkId}/{filename}`)
- On import: fetch `twimg.com` images → store in R2 → save R2 key to `localPath`
- On display: prefer R2 (via API proxy), fallback to original URL

### Access via Worker Proxy

New route `app/api/media/[key]/route.ts`:
- Reads from `env.MEDIA_BUCKET.get(key)` and returns the object
- Protected by Cloudflare Access (no public bucket needed)

### Vision Analysis Adaptation

`lib/vision-analyzer.ts`:
- Prefer reading from R2 (if cached) when analyzing images
- After analysis, cache to R2 if not already stored

## Section 6: Cleanup & Deployment

### Removed Node.js Dependencies

- `better-sqlite3` + `@types/better-sqlite3` + `@prisma/adapter-better-sqlite3`
- All `child_process`, `fs`, `os` imports from auth code

### `Buffer` Usage Replacement

Workers do not have Node.js `Buffer` global. All occurrences must be replaced:

- `lib/vision-analyzer.ts` `fetchImageAsBase64()`: `Buffer.from(buffer).toString('base64')` → use `btoa(String.fromCharCode(...new Uint8Array(buffer)))` or Workers-native approach
- `lib/exporter.ts`: `Buffer.from(arrayBuffer)` and `zip.generateAsync({ type: 'nodebuffer' })` → change to `type: 'uint8array'`
- `app/api/export/route.ts`: same JSZip `nodebuffer` issue
- `lib/openai-auth.ts`: `Buffer.from(...)` for JWT parsing → removed with the file

### Middleware Auth Conflict

`middleware.ts` implements HTTP Basic Auth using `process.env.SIFTLY_USERNAME/SIFTLY_PASSWORD`. Since Cloudflare Access handles auth, this middleware should be removed. If retained for defense-in-depth, `process.env` must go through `getCloudflareContext().env`.

### Removed Files/Routes

- `lib/claude-cli.ts` (subprocess calls)
- `lib/codex-cli.ts` (subprocess calls)
- `lib/openai-auth.ts` (filesystem/subprocess calls — simplified into `lib/ai-client.ts`)
- `app/api/settings/cli-status/` (entire route)

### Config Adjustments

- `next.config.ts`: remove `turbopack.root: __dirname`
- `prisma.config.ts`: update — no longer references `process.env["DATABASE_URL"]`; migrations use `prisma migrate diff` to generate SQL, then `wrangler d1 migrations apply`
- `DATABASE_URL` env var no longer needed (D1 via binding)
- Secrets set via `wrangler secret put`

### Local Development

- `start.sh` updated to use `wrangler dev` (or `opennextjs-cloudflare dev`) instead of `next dev`
- Wrangler provides a local D1 emulator for development
- `wrangler.jsonc` supports `[env.dev]` overrides for local bindings

### Deployment Flow

```bash
npx opennextjs-cloudflare build   # Build for Workers
npx wrangler d1 migrations apply  # Apply DB migrations
npx wrangler deploy               # Deploy to Workers
```

### Cloudflare Access

Configured in Cloudflare Dashboard:
- Create Access Application protecting the entire domain
- Auth method: email OTP, GitHub OAuth, or other IdP
- No application code changes required
