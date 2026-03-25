# Siftly MCP Server, Remote CLI & API Key Authentication

**Date:** 2026-03-25
**Status:** Approved

## Problem

Siftly runs as a Docker container. AI agents (Claude Code) and scripts have no structured way to interact with it programmatically. The existing CLI (`cli/siftly.ts`) directly accesses the local SQLite database and cannot reach a remote deployment. There is also no API authentication mechanism beyond optional Basic Auth, which is unsuitable for programmatic access.

## Solution

Three additions to Siftly:

1. **API Key authentication** — generate/revoke keys for programmatic access
2. **MCP server** — embedded as a Next.js API route, exposes Siftly tools to Claude Code
3. **Remote CLI** — HTTP-based CLI that works against any Siftly instance

## 1. API Key Authentication

### Data Model

New `ApiKey` model in `prisma/schema.prisma`:

```prisma
model ApiKey {
  id        String   @id @default(cuid())
  name      String
  keyHash   String   @unique
  prefix    String               // first 8 chars of key, for display
  lastUsedAt DateTime?
  createdAt DateTime @default(now())
}
```

### Key Format

`siftly_` + 32 hex characters (128-bit random). Example: `siftly_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4`

The full key is returned only once at creation time. The database stores a SHA-256 hash of the key.

### Authentication Priority

Requests are authenticated in this order:

1. `Authorization: Bearer siftly_xxx` header — hash the token, look up in `ApiKey` table
2. Basic Auth — compare against `SIFTLY_USERNAME` / `SIFTLY_PASSWORD` env vars (existing behavior)
3. No auth — allowed when neither API keys nor Basic Auth are configured

### API Endpoints

**`GET /api/settings/api-keys`** — List all keys (returns `id`, `name`, `prefix`, `lastUsedAt`, `createdAt`; never the full key).

**`POST /api/settings/api-keys`** — Generate a new key.
- Body: `{ "name": "claude-code" }`
- Response: `{ "id": "...", "name": "...", "key": "siftly_xxx...", "prefix": "siftly_a" }` (key is plaintext, shown only once)

**`DELETE /api/settings/api-keys/[id]`** — Revoke a key.

### Auth Middleware

`lib/api-auth.ts` exports a `verifyApiKey(request)` function:

1. Extract `Authorization: Bearer <token>` from headers
2. If token starts with `siftly_`, SHA-256 hash it, query `ApiKey` table by `keyHash`
3. If found, update `lastUsedAt` (debounced to avoid write-per-request), return authenticated
4. If not found, return 401

The existing `middleware.ts` is updated to:
- Skip auth for the API Key management endpoints themselves (they require Basic Auth or an existing API Key)
- Call `verifyApiKey()` for all `/api/*` routes when a Bearer token is present
- Fall through to existing Basic Auth logic when no Bearer token is present

### Settings UI

A new section on the Settings page below the existing cards:

- Lists existing API keys with name, prefix, last used date
- "Generate API Key" button with a name input
- Shows the full key once after creation with a copy button and a warning that it won't be shown again
- Delete button per key with confirmation

## 2. MCP Server

### Architecture

The MCP server is a Next.js API route at `app/api/mcp/route.ts` using `@modelcontextprotocol/sdk` with Streamable HTTP transport. It handles both GET (SSE session) and POST (tool calls) on the same route.

MCP tools call internal business logic directly (importing the same functions used by other API routes) rather than making HTTP requests to itself. This shares the Prisma connection and avoids network overhead.

Authentication: the MCP endpoint requires a valid API Key in the `Authorization` header. The MCP client (Claude Code) configures this in its MCP server settings.

### Tools

#### `search_bookmarks`
- **Input:** `{ query: string, limit?: number }`
- **Behavior:** FTS5 keyword search
- **Returns:** `{ count, bookmarks: [{ id, tweetId, text, author, categories }] }`

#### `list_bookmarks`
- **Input:** `{ category?: string, author?: string, source?: "bookmark"|"like", media?: "photo"|"video", sort?: "newest"|"oldest", limit?: number, page?: number }`
- **Behavior:** Filtered listing with pagination
- **Returns:** `{ total, page, pages, bookmarks: [...] }`

#### `show_bookmark`
- **Input:** `{ id: string }` (accepts bookmark ID or tweet ID)
- **Behavior:** Full detail of a single bookmark
- **Returns:** Full bookmark object with media, categories, semantic tags, entities

#### `get_stats`
- **Input:** none
- **Returns:** `{ totalBookmarks, enrichedBookmarks, unenrichedBookmarks, totalCategories, totalMediaItems, sources }`

#### `list_categories`
- **Input:** none
- **Returns:** `{ count, categories: [{ id, name, slug, color, bookmarkCount }] }`

#### `sync_bookmarks`
- **Input:** `{ mode?: "incremental"|"full" }`
- **Behavior:** Triggers cookie-based sync using stored credentials
- **Returns:** `{ imported, skipped, pages, mode }`

#### `get_sync_status`
- **Input:** none
- **Returns:** `{ hasCredentials, syncInterval, lastSync, schedulerRunning }`

#### `start_categorize`
- **Input:** `{ force?: boolean }`
- **Behavior:** Starts the AI categorization pipeline
- **Returns:** `{ status: "started", total }` or `{ status: "already_running" }`

#### `get_categorize_status`
- **Input:** none
- **Returns:** `{ status, stage, done, total, stageCounts, lastError }`

#### `export_bookmarks`
- **Input:** `{ type: "csv"|"json"|"zip", category?: string }`
- **Behavior:** Exports bookmarks in the requested format
- **Returns:** For csv/json: `{ content: string, filename: string }`. For zip: `{ base64: string, filename: string }`

#### `ai_search`
- **Input:** `{ query: string, limit?: number }`
- **Behavior:** Natural language semantic search via Claude
- **Returns:** `{ results: [{ id, tweetId, text, relevance, explanation }] }`

### Claude Code Configuration

Users add to their Claude Code MCP config:

```json
{
  "mcpServers": {
    "siftly": {
      "type": "streamable-http",
      "url": "http://localhost:3000/api/mcp",
      "headers": {
        "Authorization": "Bearer siftly_xxx..."
      }
    }
  }
}
```

## 3. Remote CLI

### File

`cli/siftly-remote.ts` — a standalone script with zero dependencies beyond Node.js built-ins and the project's existing deps. Does not import Prisma or any server-side code.

### Configuration Loading

Priority (highest first):

1. CLI flags: `--url`, `--key`
2. Environment variables: `SIFTLY_URL`, `SIFTLY_API_KEY`
3. Config file: `~/.siftly.json` (`{ "url": "...", "apiKey": "..." }`)

### Commands

```
siftly-remote config                                    # Show current config
siftly-remote config --url http://host:3000 --key siftly_xxx  # Save config

siftly-remote stats                                     # Library stats
siftly-remote categories                                # Category list
siftly-remote search "query"                            # FTS5 search
siftly-remote ai-search "natural language query"        # Semantic search
siftly-remote list [--category X] [--author X] [--source bookmark|like]
                   [--media photo|video] [--sort newest|oldest]
                   [--limit N] [--page N]
siftly-remote show <id|tweetId>                         # Bookmark detail

siftly-remote sync                                      # Incremental sync
siftly-remote sync --full                               # Full sync
siftly-remote sync --status                             # Sync config/status

siftly-remote categorize                                # Start categorization
siftly-remote categorize --status                       # Check progress

siftly-remote export --type csv [-o file.csv]           # CSV (stdout or file)
siftly-remote export --type json [-o file.json]         # JSON (stdout or file)
siftly-remote export --type zip -o file.zip             # ZIP (file required)
```

### Output

- TTY: pretty-printed JSON
- Piped: compact JSON (one line)
- Export without `-o`: raw content to stdout (allows `siftly-remote export --type csv | head`)
- Export with `-o`: writes file, prints summary to stderr

### HTTP Client

Uses Node.js built-in `fetch`. All responses are JSON except export downloads. Errors print to stderr and exit with code 1.

### npm Script

Added to `package.json`:

```json
"siftly-remote": "tsx cli/siftly-remote.ts"
```

Usage: `npm run siftly-remote -- stats`

## New Dependencies

- `@modelcontextprotocol/sdk` — MCP server library

## Files Changed/Added

| File | Change |
|------|--------|
| `prisma/schema.prisma` | Add `ApiKey` model |
| `lib/api-auth.ts` | New — API Key verification |
| `middleware.ts` | Update — Bearer token auth support |
| `app/api/settings/api-keys/route.ts` | New — list + generate |
| `app/api/settings/api-keys/[id]/route.ts` | New — delete |
| `app/api/mcp/route.ts` | New — MCP Streamable HTTP server |
| `cli/siftly-remote.ts` | New — remote CLI |
| `app/settings/page.tsx` | Update — API Key management UI |
| `package.json` | Add dependency + npm script |

## Testing

- Generate API Key via Settings UI, verify it appears in list
- Use the key with curl against `/api/stats` to verify auth works
- Connect Claude Code to MCP endpoint, verify tool discovery and execution
- Run CLI commands against the Docker instance
- Export CSV/JSON/ZIP via both MCP and CLI
- Verify invalid/revoked keys return 401
