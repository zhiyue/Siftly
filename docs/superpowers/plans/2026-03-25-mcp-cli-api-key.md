# MCP Server, Remote CLI & API Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add API Key authentication, an MCP server (embedded Next.js route), and a remote HTTP CLI to Siftly so AI agents and scripts can interact with the Docker-deployed instance.

**Architecture:** MCP server is a Next.js API route at `/api/mcp` using Streamable HTTP transport from `@modelcontextprotocol/sdk`. CLI is a standalone script using `fetch` against the HTTP API. Both authenticate via API Keys stored as SHA-256 hashes in an `ApiKey` table.

**Tech Stack:** Next.js 16 App Router, Prisma 7 + SQLite, `@modelcontextprotocol/sdk`, Node.js built-in `crypto`

**Spec:** `docs/superpowers/specs/2026-03-25-mcp-cli-api-key-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `prisma/schema.prisma` | Add `ApiKey` model |
| `lib/api-auth.ts` | API Key hashing, verification, generation |
| `middleware.ts` | Bearer token + Basic Auth dispatch |
| `app/api/settings/api-keys/route.ts` | `GET` list keys, `POST` generate key |
| `app/api/settings/api-keys/[id]/route.ts` | `DELETE` revoke key |
| `app/api/mcp/route.ts` | MCP Streamable HTTP server with all tools |
| `cli/siftly-remote.ts` | Remote HTTP CLI |
| `app/settings/page.tsx` | API Key management UI section |
| `package.json` | Add `@modelcontextprotocol/sdk`, `siftly-remote` script |

---

### Task 1: Install dependency and add ApiKey schema

**Files:**
- Modify: `package.json`
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Install MCP SDK**

```bash
npm install @modelcontextprotocol/sdk
```

- [ ] **Step 2: Add ApiKey model to schema**

Add to `prisma/schema.prisma` after the `Setting` model:

```prisma
model ApiKey {
  id         String    @id @default(cuid())
  name       String
  keyHash    String    @unique
  prefix     String
  lastUsedAt DateTime?
  createdAt  DateTime  @default(now())
}
```

- [ ] **Step 3: Apply schema to database**

```bash
npx prisma migrate dev --name add-api-keys
```

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/ package.json package-lock.json
git commit -m "feat: add ApiKey model and install MCP SDK"
```

---

### Task 2: API Key utility library

**Files:**
- Create: `lib/api-auth.ts`

- [ ] **Step 1: Create lib/api-auth.ts**

```typescript
import { createHash, randomBytes } from 'crypto'
import prisma from '@/lib/db'

const KEY_PREFIX = 'siftly_'

export function generateApiKey(): { key: string; keyHash: string; prefix: string } {
  const raw = randomBytes(16).toString('hex') // 32 hex chars
  const key = `${KEY_PREFIX}${raw}`
  const keyHash = hashKey(key)
  const prefix = key.slice(0, 12) // "siftly_a1b2c"
  return { key, keyHash, prefix }
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

/**
 * Verify a Bearer token against stored API keys.
 * Returns the ApiKey id if valid, null otherwise.
 */
export async function verifyApiKey(token: string): Promise<string | null> {
  if (!token.startsWith(KEY_PREFIX)) return null

  const keyHash = hashKey(token)
  const apiKey = await prisma.apiKey.findUnique({ where: { keyHash } })
  if (!apiKey) return null

  // Debounced lastUsedAt update (skip if updated within last 5 minutes)
  const now = new Date()
  if (!apiKey.lastUsedAt || now.getTime() - apiKey.lastUsedAt.getTime() > 5 * 60 * 1000) {
    prisma.apiKey.update({
      where: { id: apiKey.id },
      data: { lastUsedAt: now },
    }).catch(() => {}) // fire-and-forget
  }

  return apiKey.id
}

/**
 * Extract Bearer token from Authorization header.
 */
export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader?.startsWith('Bearer ')) return null
  return authHeader.slice(7).trim()
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/api-auth.ts
git commit -m "feat: add API Key utility library"
```

---

### Task 3: Update middleware for Bearer token auth

**Files:**
- Modify: `middleware.ts`

- [ ] **Step 1: Update middleware.ts**

Replace the entire content of `middleware.ts` with:

```typescript
import { NextRequest, NextResponse } from 'next/server'

/**
 * Auth middleware supporting:
 * 1. Bearer token (API Key) — validated at the API route level (middleware
 *    can't do async DB lookups in Edge runtime, so we let Bearer through
 *    and validate in the route handlers / MCP endpoint).
 * 2. Basic Auth — validated here against env vars.
 * 3. No auth — when neither is configured.
 *
 * Excluded paths:
 * - /api/import/bookmarklet — cross-origin from x.com, can't carry auth
 */
export function middleware(request: NextRequest): NextResponse {
  const username = process.env.SIFTLY_USERNAME?.trim()
  const password = process.env.SIFTLY_PASSWORD?.trim()

  // No credentials configured → pass through
  if (!username || !password) return NextResponse.next()

  // Bookmarklet is always open (cross-origin)
  if (request.nextUrl.pathname === '/api/import/bookmarklet') {
    return NextResponse.next()
  }

  const authHeader = request.headers.get('Authorization')

  // Bearer tokens pass through middleware — validated at route level
  if (authHeader?.startsWith('Bearer ')) {
    return NextResponse.next()
  }

  // Basic Auth check
  if (authHeader?.startsWith('Basic ')) {
    try {
      const decoded = atob(authHeader.slice(6))
      const colonIdx = decoded.indexOf(':')
      if (colonIdx !== -1) {
        const user = decoded.slice(0, colonIdx)
        const pass = decoded.slice(colonIdx + 1)
        if (user === username && pass === password) {
          return NextResponse.next()
        }
      }
    } catch {
      // malformed base64 → fall through to 401
    }
  }

  return new NextResponse('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Siftly"' },
  })
}

export const config = {
  matcher: [
    '/((?!_next/|favicon.ico|icon.svg).*)',
  ],
}
```

- [ ] **Step 2: Commit**

```bash
git add middleware.ts
git commit -m "feat: update middleware to pass Bearer tokens through"
```

---

### Task 4: API Key management endpoints

**Files:**
- Create: `app/api/settings/api-keys/route.ts`
- Create: `app/api/settings/api-keys/[id]/route.ts`

- [ ] **Step 1: Create list + generate endpoint**

Create `app/api/settings/api-keys/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { generateApiKey, extractBearerToken, verifyApiKey } from '@/lib/api-auth'

/** GET — list all API keys (no secrets) */
export async function GET(request: NextRequest) {
  const authResult = await checkAuth(request)
  if (authResult) return authResult

  const keys = await prisma.apiKey.findMany({
    select: { id: true, name: true, prefix: true, lastUsedAt: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  })
  return NextResponse.json({ keys })
}

/** POST — generate a new API key */
export async function POST(request: NextRequest) {
  const authResult = await checkAuth(request)
  if (authResult) return authResult

  let body: { name?: string } = {}
  try { body = await request.json() } catch {}

  const name = body.name?.trim() || 'Unnamed Key'
  const { key, keyHash, prefix } = generateApiKey()

  const created = await prisma.apiKey.create({
    data: { name, keyHash, prefix },
  })

  return NextResponse.json({
    id: created.id,
    name: created.name,
    key, // plaintext — shown only once
    prefix,
    createdAt: created.createdAt,
  })
}

/** Auth check: require Basic Auth or valid API Key */
async function checkAuth(request: NextRequest): Promise<NextResponse | null> {
  // If Bearer token present, verify it
  const token = extractBearerToken(request.headers.get('Authorization'))
  if (token) {
    const id = await verifyApiKey(token)
    if (id) return null // authenticated
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 })
  }

  // If Basic Auth is configured and we got past middleware, we're authenticated
  const username = process.env.SIFTLY_USERNAME?.trim()
  const password = process.env.SIFTLY_PASSWORD?.trim()
  if (username && password) {
    // Middleware already validated Basic Auth if we reach here
    return null
  }

  // No auth configured — open access
  return null
}
```

- [ ] **Step 2: Create delete endpoint**

Create `app/api/settings/api-keys/[id]/route.ts`:

```typescript
import { NextRequest, NextResponse } from 'next/server'
import prisma from '@/lib/db'
import { extractBearerToken, verifyApiKey } from '@/lib/api-auth'

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Auth check (same logic as list endpoint)
  const token = extractBearerToken(request.headers.get('Authorization'))
  if (token) {
    const keyId = await verifyApiKey(token)
    if (!keyId) return NextResponse.json({ error: 'Invalid API key' }, { status: 401 })
  }

  const { id } = await params
  try {
    await prisma.apiKey.delete({ where: { id } })
    return NextResponse.json({ deleted: true })
  } catch {
    return NextResponse.json({ error: 'API key not found' }, { status: 404 })
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add app/api/settings/api-keys/
git commit -m "feat: add API Key management endpoints"
```

---

### Task 5: API Key management UI

**Files:**
- Modify: `app/settings/page.tsx`

- [ ] **Step 1: Add API Key section to Settings page**

Add a new component `ApiKeySection` to `app/settings/page.tsx`. Place it after the existing sections. The component should:

1. Fetch `GET /api/settings/api-keys` on mount to list existing keys
2. Show a table with columns: Name, Prefix, Last Used, Created, Delete button
3. "Generate API Key" button with a name input field
4. After creation, show the full key in a highlighted box with a copy button and warning "This key won't be shown again"
5. Delete button with inline confirmation

Use the existing design patterns from the page (zinc colors, rounded-xl, lucide-react icons — `KeyRound`, `Copy`, `Check`, `Trash2`, `Plus`, `Loader2`).

- [ ] **Step 2: Commit**

```bash
git add app/settings/page.tsx
git commit -m "feat: add API Key management UI to Settings page"
```

---

### Task 6: MCP Server route

**Files:**
- Create: `app/api/mcp/route.ts`

- [ ] **Step 1: Create MCP server**

Create `app/api/mcp/route.ts` implementing all 11 tools from the spec. Key implementation notes:

- Use `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js` and `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js`
- Verify API Key from `Authorization` header before handling requests using `extractBearerToken` + `verifyApiKey` from `lib/api-auth.ts`
- Import business logic directly from existing libs:
  - `prisma` from `@/lib/db`
  - `ftsSearch` from `@/lib/fts`
  - `extractKeywords` from `@/lib/search-utils`
  - `syncBookmarks`, `isSyncing` from `@/lib/x-sync`
  - `exportAllBookmarksCsv`, `exportBookmarksJson`, `exportCategoryAsZip` from `@/lib/exporter`
- For `export_bookmarks` with type `zip`: base64-encode the buffer and return `{ base64, filename }`
- For `ai_search`: call the same logic as `app/api/search/ai/route.ts` (import shared functions)
- Export `GET` and `POST` handlers for Next.js App Router
- Create a new `McpServer` + `StreamableHTTPServerTransport` per request (stateless Streamable HTTP)

Tool definitions use `z` from `zod` (bundled with MCP SDK) for input schemas.

- [ ] **Step 2: Verify MCP endpoint responds**

```bash
curl -s -X POST http://localhost:3000/api/mcp \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <your-api-key>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{},"clientInfo":{"name":"test","version":"1.0"},"protocolVersion":"2025-03-26"}}'
```

Expected: JSON-RPC response with server capabilities and tool list.

- [ ] **Step 3: Commit**

```bash
git add app/api/mcp/route.ts
git commit -m "feat: add MCP server with 11 tools as Next.js API route"
```

---

### Task 7: Remote CLI

**Files:**
- Create: `cli/siftly-remote.ts`
- Modify: `package.json` (add `siftly-remote` script)

- [ ] **Step 1: Create cli/siftly-remote.ts**

Implement all commands from the spec. Structure:

```
cli/siftly-remote.ts
├── Config loading (flags → env → ~/.siftly.json)
├── HTTP client (fetch wrapper with auth header + error handling)
├── Commands:
│   ├── config          — show/save config
│   ├── stats           — GET /api/stats
│   ├── categories      — GET /api/categories
│   ├── search          — GET /api/bookmarks?q=...
│   ├── ai-search       — POST /api/search/ai
│   ├── list            — GET /api/bookmarks with query params
│   ├── show            — GET /api/bookmarks?id=...
│   ├── sync            — POST /api/import/live/sync or GET /api/import/live
│   ├── categorize      — POST /api/categorize or GET /api/categorize
│   └── export          — GET /api/export?type=... (write to file or stdout)
└── Router (arg parsing → command dispatch)
```

Key details:
- Config file path: `~/.siftly.json` (use `os.homedir()`)
- `config` command with `--url` and `--key` flags writes to `~/.siftly.json`
- TTY detection: `process.stdout.isTTY` for pretty vs compact JSON
- Export with `-o`: write binary/text to file, print summary to stderr
- Export without `-o`: pipe raw content to stdout (csv/json only; zip requires `-o`)
- All errors go to stderr and exit code 1

- [ ] **Step 2: Add npm script to package.json**

Add to `scripts` in `package.json`:

```json
"siftly-remote": "tsx cli/siftly-remote.ts"
```

- [ ] **Step 3: Test CLI locally**

```bash
# Save config
npx tsx cli/siftly-remote.ts config --url http://localhost:3000 --key siftly_<your-key>

# Test stats
npx tsx cli/siftly-remote.ts stats

# Test export
npx tsx cli/siftly-remote.ts export --type csv -o /tmp/bookmarks.csv
```

- [ ] **Step 4: Commit**

```bash
git add cli/siftly-remote.ts package.json
git commit -m "feat: add remote HTTP CLI with all commands"
```

---

### Task 8: Docker rebuild and end-to-end test

**Files:**
- Modify: `docker/Dockerfile` (no changes needed — `npm ci` picks up new dep)

- [ ] **Step 1: Rebuild Docker image**

```bash
cd docker && docker compose up -d --build
```

Wait for startup, then apply the new migration:

```bash
docker exec siftly-app-1 node_modules/.bin/prisma migrate deploy
```

- [ ] **Step 2: Generate an API Key**

```bash
curl -s -X POST http://localhost:3000/api/settings/api-keys \
  -H 'Content-Type: application/json' \
  -d '{"name":"test-key"}'
```

Save the returned `key` value.

- [ ] **Step 3: Test MCP endpoint**

```bash
curl -s -X POST http://localhost:3000/api/mcp \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <key>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{},"clientInfo":{"name":"test","version":"1.0"},"protocolVersion":"2025-03-26"}}'
```

- [ ] **Step 4: Test CLI against Docker**

```bash
npx tsx cli/siftly-remote.ts config --url http://localhost:3000 --key <key>
npx tsx cli/siftly-remote.ts stats
npx tsx cli/siftly-remote.ts categories
npx tsx cli/siftly-remote.ts search "AI"
npx tsx cli/siftly-remote.ts export --type json -o /tmp/test.json
```

- [ ] **Step 5: Commit all remaining changes and push**

```bash
git add -A
git commit -m "feat: complete MCP + CLI + API Key integration"
git push origin main
```
