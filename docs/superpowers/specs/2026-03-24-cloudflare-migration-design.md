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

### FTS5 (`lib/fts.ts`)

D1 supports FTS5 virtual tables. Core logic preserved with adjustments:

- Raw SQL operations (CREATE VIRTUAL TABLE, INSERT, MATCH) may need to bypass Prisma and use `env.DB.prepare(...).run()` directly, since Prisma's D1 adapter has limited raw SQL support
- D1 does not support exporting databases with virtual tables — backup strategy must account for this

### D1 Transaction Limitation

D1 does not support interactive transactions (`prisma.$transaction([...])`). The FTS rebuild batch inserts are replaced with D1's batch API (`env.DB.batch([stmt1, stmt2, ...])`) which provides atomicity.

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
- `lib/codex-cli.ts` — if it depends on subprocess calls

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

Remove all imports of `getCliAvailability`, `claudePrompt`, `modelNameToCliAlias`, `codexPrompt` from `lib/ai-client.ts`, `lib/categorizer.ts`, and any other files.

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
- Process one batch per alarm invocation
- Set next alarm after each batch completes
- State persists across alarm invocations in DO storage
- Frontend polls GET endpoint for progress (no SSE needed)

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

### Removed Files/Routes

- `lib/claude-cli.ts` (subprocess calls)
- `lib/codex-cli.ts` (subprocess calls)
- `app/api/settings/cli-status/` (entire route)

### Config Adjustments

- `next.config.ts`: remove `turbopack.root: __dirname`
- `DATABASE_URL` env var no longer needed (D1 via binding)
- Secrets set via `wrangler secret put`

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
