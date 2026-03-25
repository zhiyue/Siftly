# Hono + React SPA Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Next.js + OpenNext with Hono (API) + React SPA (Vite) for native Cloudflare Workers support including Durable Objects.

**Architecture:** Hono handles all API routes and exports the PipelineDO class from the worker entry point. React SPA built with Vite is served via Workers Static Assets. The lib/ layer (Drizzle, R2, FTS5, AI clients) is reused as-is. `getCloudflareContext()` from OpenNext is replaced with Hono's `c.env` passed through to lib functions.

**Tech Stack:** Hono, Vite, React 19, React Router, Drizzle ORM, Cloudflare D1/R2/Durable Objects, Tailwind CSS v4

**Spec:** `docs/superpowers/specs/2026-03-24-cloudflare-migration-design.md`

---

## File Map

### New Files (src/worker/)
| File | Purpose |
|------|---------|
| `src/worker/index.ts` | Worker entry point: Hono app + PipelineDO export |
| `src/worker/routes/stats.ts` | GET /api/stats |
| `src/worker/routes/bookmarks.ts` | GET/DELETE /api/bookmarks, GET /api/bookmarks/:id/categories |
| `src/worker/routes/categories.ts` | GET/POST /api/categories, GET/PUT/DELETE /api/categories/:slug |
| `src/worker/routes/categorize.ts` | GET/POST/DELETE /api/categorize |
| `src/worker/routes/import.ts` | POST /api/import, POST /api/import/twitter, POST /api/import/bookmarklet |
| `src/worker/routes/import-live.ts` | POST /api/import/live, POST /api/import/live/sync |
| `src/worker/routes/search.ts` | POST /api/search/ai |
| `src/worker/routes/settings.ts` | GET/PUT /api/settings, POST /api/settings/test |
| `src/worker/routes/analyze.ts` | GET/POST /api/analyze/images |
| `src/worker/routes/export.ts` | GET /api/export |
| `src/worker/routes/media.ts` | GET /api/media, GET /api/r2/* |
| `src/worker/routes/mindmap.ts` | GET /api/mindmap |
| `src/worker/routes/link-preview.ts` | GET /api/link-preview |
| `src/worker/middleware.ts` | Shared middleware (env injection into lib functions) |

### New Files (src/app/ — React SPA)
| File | Purpose |
|------|---------|
| `src/app/main.tsx` | React entry point |
| `src/app/App.tsx` | Root layout with Nav + React Router |
| `src/app/routes.tsx` | Route definitions |
| `src/app/pages/Home.tsx` | Dashboard (from app/page.tsx) |
| `src/app/pages/Bookmarks.tsx` | Browse bookmarks (from app/bookmarks/page.tsx) |
| `src/app/pages/Categories.tsx` | Category list (from app/categories/page.tsx) |
| `src/app/pages/CategoryDetail.tsx` | Single category (from app/categories/[slug]/page.tsx) |
| `src/app/pages/Import.tsx` | Import wizard (from app/import/page.tsx) |
| `src/app/pages/Categorize.tsx` | Pipeline monitor (from app/categorize/page.tsx) |
| `src/app/pages/AiSearch.tsx` | AI search (from app/ai-search/page.tsx) |
| `src/app/pages/Mindmap.tsx` | Graph view (from app/mindmap/page.tsx) |
| `src/app/pages/Settings.tsx` | Settings (from app/settings/page.tsx) |
| `vite.config.ts` | Vite config for React SPA build |
| `index.html` | SPA HTML shell |

### Modified Files
| File | Change |
|------|--------|
| `lib/db.ts` | Remove `getCloudflareContext()`, accept D1 binding as parameter |
| `lib/fts.ts` | Accept D1 binding as parameter instead of `getD1()` |
| `lib/r2.ts` | Accept R2 bucket as parameter instead of `getCloudflareContext()` |
| `lib/claude-cli-auth.ts` | Accept env as parameter |
| `lib/openai-auth.ts` | Accept env as parameter |
| `lib/settings.ts` | Accept db as parameter |
| `lib/pipeline-do.ts` | Re-enable as real DO with D1 access |
| `lib/pipeline-state.ts` | Keep as fallback, update interface |
| `wrangler.jsonc` | Update entry point, re-enable DO, configure static assets |
| `package.json` | Add hono, vite, react-router; remove next, @opennextjs/cloudflare |
| `tsconfig.json` | Update for Vite + Workers |

### Deleted Files
| File | Reason |
|------|--------|
| `app/` (entire directory) | Replaced by src/app/ (SPA) and src/worker/ (API) |
| `next.config.ts` | No longer using Next.js |
| `open-next.config.ts` | No longer using OpenNext |
| `next-env.d.ts` | No longer using Next.js |
| `postcss.config.mjs` | Reconfigure for Vite |

---

## Key Architecture Decision: Env Passing

Currently lib functions use `getCloudflareContext()` from OpenNext. With Hono, env is available via `c.env`. Two approaches:

**Chosen: Explicit parameter passing.** Each lib function that needs D1/R2/env receives it as a parameter. This is cleaner, testable, and works in both Worker request context and Durable Object context.

```typescript
// lib/db.ts — before
export function getDb() {
  const { env } = getCloudflareContext()
  return drizzle(env.DB, { schema })
}

// lib/db.ts — after
export function getDb(d1: D1Database) {
  return drizzle(d1, { schema })
}

// In Hono route:
app.get('/api/stats', (c) => {
  const db = getDb(c.env.DB)
  // ...
})

// In Durable Object:
class PipelineDO {
  constructor(ctx, env) {
    this.db = getDb(env.DB)
  }
}
```

---

## Task 1: Infrastructure — Deps, Vite, Wrangler Config

**Files:**
- Modify: `package.json`
- Create: `vite.config.ts`
- Create: `index.html`
- Create: `src/worker/index.ts` (minimal)
- Modify: `wrangler.jsonc`
- Modify: `tsconfig.json`

- [ ] **Step 1: Update package.json**

Remove: `next`, `@opennextjs/cloudflare`
Add: `hono`, `react-router` (v7)
Add devDeps: `vite`, `@vitejs/plugin-react`, `@hono/vite-dev-server`

```bash
npm remove next @opennextjs/cloudflare eslint-config-next
npm install hono react-router
npm install -D vite @vitejs/plugin-react
```

Update scripts:
```json
{
  "scripts": {
    "dev": "wrangler dev",
    "dev:spa": "vite",
    "build:spa": "vite build",
    "build": "vite build && wrangler deploy --dry-run",
    "deploy": "vite build && wrangler deploy"
  }
}
```

- [ ] **Step 2: Create vite.config.ts**

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  root: '.',
  build: {
    outDir: 'public',
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
})
```

- [ ] **Step 3: Create index.html**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Siftly</title>
    <link rel="icon" href="/icon.svg" />
  </head>
  <body class="flex min-h-screen bg-zinc-950 text-zinc-100 antialiased">
    <div id="root"></div>
    <script type="module" src="/src/app/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Create minimal src/worker/index.ts**

```typescript
import { Hono } from 'hono'

type Bindings = {
  DB: D1Database
  MEDIA_BUCKET: R2Bucket
  PIPELINE_DO: DurableObjectNamespace
  ANTHROPIC_API_KEY: string
  OPENAI_API_KEY: string
  ANTHROPIC_BASE_URL: string
  OPENAI_BASE_URL: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/api/health', (c) => c.json({ ok: true }))

// SPA fallback — serve index.html for non-API routes
app.get('*', (c) => {
  // Workers Static Assets handles this automatically
  return c.notFound()
})

export default app
export { PipelineDO } from '../lib/pipeline-do'
```

- [ ] **Step 5: Update wrangler.jsonc**

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "siftly",
  "main": "src/worker/index.ts",
  "compatibility_date": "2025-04-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "directory": "public",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application"
  },
  "d1_databases": [{
    "binding": "DB",
    "database_name": "siftly-db",
    "database_id": "<YOUR_D1_DATABASE_ID>"
  }],
  "r2_buckets": [{
    "binding": "MEDIA_BUCKET",
    "bucket_name": "siftly-media"
  }],
  "durable_objects": {
    "bindings": [{ "name": "PIPELINE_DO", "class_name": "PipelineDO" }]
  },
  "migrations": [
    { "tag": "v1", "new_classes": ["PipelineDO"] }
  ],
  "vars": {
    "ANTHROPIC_BASE_URL": "",
    "OPENAI_BASE_URL": ""
  }
}
```

Key: `not_found_handling: "single-page-application"` makes non-API paths serve index.html for client-side routing.

- [ ] **Step 6: Update tsconfig.json**

Remove Next.js plugin. Add Vite types. Keep paths alias.

- [ ] **Step 7: Commit**

```bash
git -c commit.gpgsign=false add -A && git -c commit.gpgsign=false commit -m "feat: add Hono + Vite infrastructure, remove Next.js"
```

---

## Task 2: Refactor lib/ — Remove getCloudflareContext, Accept Params

**Files:**
- Modify: `lib/db.ts`
- Modify: `lib/fts.ts`
- Modify: `lib/r2.ts`
- Modify: `lib/claude-cli-auth.ts`
- Modify: `lib/openai-auth.ts`
- Modify: `lib/ai-client.ts`
- Modify: `lib/settings.ts`
- Modify: `lib/categorizer.ts`
- Modify: `lib/vision-analyzer.ts`
- Modify: `lib/rawjson-extractor.ts`
- Modify: `lib/exporter.ts`
- Modify: `lib/twitter-api.ts`
- Modify: `lib/x-sync.ts`

- [ ] **Step 1: Rewrite lib/db.ts**

Remove `getCloudflareContext` import. Accept D1 as parameter:

```typescript
import { drizzle } from 'drizzle-orm/d1'
import * as schema from './schema'

export type AppDb = ReturnType<typeof getDb>

export function getDb(d1: D1Database) {
  return drizzle(d1, { schema })
}
```

- [ ] **Step 2: Rewrite lib/fts.ts**

Change `getD1()` calls to accept D1 as parameter. Change `getDb()` calls to accept D1.

```typescript
export async function ensureFtsTable(d1: D1Database): Promise<void> { ... }
export async function rebuildFts(d1: D1Database): Promise<void> { ... }
export async function ftsSearch(d1: D1Database, keywords: string[]): Promise<string[]> { ... }
```

- [ ] **Step 3: Rewrite lib/r2.ts**

Accept R2Bucket as parameter:

```typescript
export async function uploadMedia(bucket: R2Bucket, key: string, data: ..., contentType: string) { ... }
export async function getMedia(bucket: R2Bucket, key: string) { ... }
export async function deleteMedia(bucket: R2Bucket, key: string) { ... }
```

- [ ] **Step 4: Rewrite auth files**

`lib/claude-cli-auth.ts`: Accept env object instead of using `getCloudflareContext()`:
```typescript
export function resolveAnthropicClient(options: {
  overrideKey?: string; dbKey?: string; baseURL?: string;
  env?: { ANTHROPIC_API_KEY?: string; ANTHROPIC_BASE_URL?: string }
} = {}): Anthropic { ... }
```

`lib/openai-auth.ts`: Same pattern for OpenAI.

`lib/ai-client.ts`: Pass env through to auth functions.

- [ ] **Step 5: Rewrite lib/settings.ts**

Accept db as parameter:
```typescript
export async function getActiveModel(db: AppDb): Promise<string> { ... }
export async function getProvider(db: AppDb): Promise<'anthropic' | 'openai'> { ... }
```

- [ ] **Step 6: Update remaining lib files**

`lib/categorizer.ts`, `lib/vision-analyzer.ts`, `lib/rawjson-extractor.ts`, `lib/exporter.ts`, `lib/twitter-api.ts`, `lib/x-sync.ts` — all need to accept db/d1/bucket/env as parameters instead of calling `getDb()`/`getD1()`/`getCloudflareContext()` internally.

The pattern is consistent: each function receives what it needs from the caller (the Hono route handler).

- [ ] **Step 7: Commit**

```bash
git -c commit.gpgsign=false add -A && git -c commit.gpgsign=false commit -m "refactor: make lib functions accept explicit db/env params"
```

---

## Task 3: Hono API Routes — Core (stats, bookmarks, categories)

**Files:**
- Create: `src/worker/routes/stats.ts`
- Create: `src/worker/routes/bookmarks.ts`
- Create: `src/worker/routes/categories.ts`
- Modify: `src/worker/index.ts`

- [ ] **Step 1: Create route files**

Each route file exports a Hono sub-app. Pattern:

```typescript
import { Hono } from 'hono'
import { getDb } from '@/lib/db'

const route = new Hono<{ Bindings: Bindings }>()

route.get('/api/stats', async (c) => {
  const db = getDb(c.env.DB)
  // ... translate the logic from app/api/stats/route.ts
  return c.json(result)
})

export default route
```

Read each Next.js route file, translate:
- `NextRequest` → `c.req` (Hono Request)
- `NextResponse.json(data)` → `c.json(data)`
- `NextResponse.json(data, { status: 400 })` → `c.json(data, 400)`
- `request.nextUrl.searchParams` → `c.req.query('param')`
- `request.json()` → `c.req.json()`
- Route params: `params.slug` → `c.req.param('slug')`

- [ ] **Step 2: Wire routes into index.ts**

```typescript
import stats from './routes/stats'
import bookmarks from './routes/bookmarks'
import categories from './routes/categories'

app.route('/', stats)
app.route('/', bookmarks)
app.route('/', categories)
```

- [ ] **Step 3: Commit**

---

## Task 4: Hono API Routes — Pipeline, Import, Search

**Files:**
- Create: `src/worker/routes/categorize.ts`
- Create: `src/worker/routes/import.ts`
- Create: `src/worker/routes/import-live.ts`
- Create: `src/worker/routes/search.ts`

These are the more complex routes. The categorize route uses `ctx.waitUntil()` — in Hono, use `c.executionCtx.waitUntil()`.

For the categorize route with PipelineDO:
```typescript
route.get('/api/categorize', async (c) => {
  const id = c.env.PIPELINE_DO.idFromName('singleton')
  const stub = c.env.PIPELINE_DO.get(id)
  const resp = await stub.fetch(new Request('https://do/status'))
  return c.json(await resp.json())
})
```

- [ ] **Step 1: Create all four route files**
- [ ] **Step 2: Wire into index.ts**
- [ ] **Step 3: Commit**

---

## Task 5: Hono API Routes — Settings, Analyze, Export, Media, Mindmap, Link-preview

**Files:**
- Create: `src/worker/routes/settings.ts`
- Create: `src/worker/routes/analyze.ts`
- Create: `src/worker/routes/export.ts`
- Create: `src/worker/routes/media.ts`
- Create: `src/worker/routes/mindmap.ts`
- Create: `src/worker/routes/link-preview.ts`

- [ ] **Step 1: Create all route files**
- [ ] **Step 2: Wire into index.ts**
- [ ] **Step 3: Commit**

---

## Task 6: PipelineDO — Real Durable Object

**Files:**
- Modify: `lib/pipeline-do.ts`
- Modify: `src/worker/index.ts`

- [ ] **Step 1: Update PipelineDO**

The DO class is already written. Update it to:
1. Accept `env.DB` in constructor, create Drizzle db
2. Manage pipeline state via `this.ctx.storage`
3. Export from worker entry point

```typescript
// src/worker/index.ts
export { PipelineDO } from '../lib/pipeline-do'
```

- [ ] **Step 2: Update categorize route to use DO**

Replace `PipelineStateManager` (globalThis) with actual DO fetch calls.

- [ ] **Step 3: Commit**

---

## Task 7: React SPA — Shell, Router, Layout

**Files:**
- Create: `src/app/main.tsx`
- Create: `src/app/App.tsx`
- Create: `src/app/routes.tsx`
- Move: `components/` → `src/app/components/`
- Move: `app/globals.css` → `src/app/globals.css`

- [ ] **Step 1: Create SPA entry point**

```tsx
// src/app/main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import App from './App'
import './globals.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>
)
```

- [ ] **Step 2: Create App.tsx with layout**

Move layout from `app/layout.tsx`. Nav + Routes + CommandPalette.

- [ ] **Step 3: Create routes.tsx**

```tsx
import { Routes, Route } from 'react-router'
import Home from './pages/Home'
import Bookmarks from './pages/Bookmarks'
// ...

export default function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/bookmarks" element={<Bookmarks />} />
      <Route path="/categories" element={<Categories />} />
      <Route path="/categories/:slug" element={<CategoryDetail />} />
      <Route path="/import" element={<Import />} />
      <Route path="/categorize" element={<Categorize />} />
      <Route path="/ai-search" element={<AiSearch />} />
      <Route path="/mindmap" element={<Mindmap />} />
      <Route path="/settings" element={<Settings />} />
    </Routes>
  )
}
```

- [ ] **Step 4: Move components**

Move `components/` to `src/app/components/`. Update imports. Remove any `next/link`, `next/image`, `next/navigation` usage:
- `<Link href="...">` → `<Link to="...">` (react-router)
- `useRouter()` → `useNavigate()` (react-router)
- `usePathname()` → `useLocation()` (react-router)
- `<Image>` → `<img>` (no Next.js image optimization)

- [ ] **Step 5: Commit**

---

## Task 8: React SPA — Migrate Pages

**Files:**
- Create: `src/app/pages/Home.tsx` (from app/page.tsx)
- Create: `src/app/pages/Bookmarks.tsx` (from app/bookmarks/page.tsx)
- Create: `src/app/pages/Categories.tsx` (from app/categories/page.tsx)
- Create: `src/app/pages/CategoryDetail.tsx` (from app/categories/[slug]/page.tsx)
- Create: `src/app/pages/Import.tsx` (from app/import/page.tsx)
- Create: `src/app/pages/Categorize.tsx` (from app/categorize/page.tsx)
- Create: `src/app/pages/AiSearch.tsx` (from app/ai-search/page.tsx)
- Create: `src/app/pages/Mindmap.tsx` (from app/mindmap/page.tsx)
- Create: `src/app/pages/Settings.tsx` (from app/settings/page.tsx)

- [ ] **Step 1: Migrate each page**

Pages are already client-side React. Main changes:
- Remove `'use client'` directive
- Replace `next/link` with `react-router`'s `Link`
- Replace `next/navigation` hooks with `react-router` equivalents
- Replace `next/image` with `<img>`
- No server-side data fetching — pages already use `fetch()` + `useState`

- [ ] **Step 2: Commit**

---

## Task 9: Delete Next.js Files, Final Cleanup

**Files:**
- Delete: `app/` directory (entire)
- Delete: `next.config.ts`
- Delete: `open-next.config.ts`
- Delete: `next-env.d.ts`
- Delete: `.next/` (build artifacts)
- Delete: `.open-next/` (build artifacts)
- Modify: `tsconfig.json` (final cleanup)
- Modify: `package.json` (remove next scripts)

- [ ] **Step 1: Remove all Next.js files**
- [ ] **Step 2: Verify build**

```bash
npm run build:spa  # Vite builds SPA to public/
npx wrangler dev   # Start Hono + Workers
```

- [ ] **Step 3: Test all endpoints**

```bash
curl http://localhost:8787/api/health
curl http://localhost:8787/api/stats
curl http://localhost:8787/api/categories
curl http://localhost:8787/  # Should serve SPA
```

- [ ] **Step 4: Commit**

```bash
git -c commit.gpgsign=false add -A && git -c commit.gpgsign=false commit -m "feat: complete Hono + React SPA migration, remove Next.js"
```
