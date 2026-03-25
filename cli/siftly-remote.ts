#!/usr/bin/env npx tsx
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const CONFIG_PATH = join(homedir(), '.siftly.json')
const isTTY = process.stdout.isTTY

// ─── Config ──────────────────────────────────────────────────────────────────

interface Config {
  url: string
  apiKey: string
}

function loadConfig(flags: Record<string, string>): Config {
  // Priority: 1. CLI flags  2. Env vars  3. Config file
  let url = flags.url || process.env.SIFTLY_URL || ''
  let apiKey = flags.key || process.env.SIFTLY_API_KEY || ''

  if ((!url || !apiKey) && existsSync(CONFIG_PATH)) {
    try {
      const file = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
      if (!url) url = file.url || ''
      if (!apiKey) apiKey = file.apiKey || ''
    } catch {
      // ignore invalid config file
    }
  }

  return { url: url.replace(/\/+$/, ''), apiKey }
}

function saveConfig(url: string, apiKey: string): void {
  const existing: Record<string, unknown> = {}
  if (existsSync(CONFIG_PATH)) {
    try {
      Object.assign(existing, JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')))
    } catch {
      // overwrite invalid file
    }
  }
  if (url) existing.url = url.replace(/\/+$/, '')
  if (apiKey) existing.apiKey = apiKey
  writeFileSync(CONFIG_PATH, JSON.stringify(existing, null, 2) + '\n', 'utf-8')
}

// ─── HTTP client ─────────────────────────────────────────────────────────────

async function api(config: Config, path: string, options?: RequestInit): Promise<Response> {
  if (!config.url) {
    die('No server URL configured. Run: siftly-remote config --url http://host:3000')
  }

  const url = `${config.url}${path}`
  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string> || {}),
  }
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`
  }
  if (options?.method === 'POST' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json'
  }

  let res: Response
  try {
    res = await fetch(url, { ...options, headers })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    die(`Connection failed: ${msg}\n  URL: ${url}`)
  }

  if (!res.ok) {
    const text = await res.text()
    let msg: string
    try {
      msg = JSON.parse(text).error || text
    } catch {
      msg = text
    }
    die(`API error ${res.status}: ${msg}`)
  }

  return res
}

// ─── Output helpers ──────────────────────────────────────────────────────────

function output(data: unknown): void {
  const json = isTTY ? JSON.stringify(data, null, 2) : JSON.stringify(data)
  process.stdout.write(json + '\n')
}

function die(message: string): never {
  process.stderr.write(JSON.stringify({ error: message }) + '\n')
  process.exit(1)
}

// ─── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = args[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = 'true'
      }
    } else if (arg === '-o') {
      // Handle short flag -o for output file
      const next = args[i + 1]
      if (next && !next.startsWith('-')) {
        flags['o'] = next
        i++
      }
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

// ─── Commands ────────────────────────────────────────────────────────────────

async function cmdConfig(args: string[]) {
  const { flags } = parseArgs(args)

  // If --url or --key provided, save them
  if (flags.url || flags.key) {
    saveConfig(flags.url || '', flags.key || '')
    const saved = loadConfig({})
    process.stderr.write('Config saved to ' + CONFIG_PATH + '\n')
    output({
      url: saved.url || '(not set)',
      apiKey: saved.apiKey ? saved.apiKey.slice(0, 8) + '...' : '(not set)',
      configPath: CONFIG_PATH,
    })
    return
  }

  // Otherwise show current config
  const config = loadConfig({})
  output({
    url: config.url || '(not set)',
    apiKey: config.apiKey ? config.apiKey.slice(0, 8) + '...' : '(not set)',
    configPath: CONFIG_PATH,
    sources: {
      SIFTLY_URL: process.env.SIFTLY_URL || '(not set)',
      SIFTLY_API_KEY: process.env.SIFTLY_API_KEY ? '(set)' : '(not set)',
      configFile: existsSync(CONFIG_PATH) ? CONFIG_PATH : '(not found)',
    },
  })
}

async function cmdStats(config: Config) {
  const res = await api(config, '/api/stats')
  output(await res.json())
}

async function cmdCategories(config: Config) {
  const res = await api(config, '/api/categories')
  output(await res.json())
}

async function cmdSearch(config: Config, args: string[]) {
  const { positional, flags } = parseArgs(args)
  const query = positional.join(' ')
  if (!query) die('Usage: siftly-remote search <query>')

  const limit = flags.limit || '20'
  const params = new URLSearchParams({ q: query, limit })
  const res = await api(config, `/api/bookmarks?${params}`)
  output(await res.json())
}

async function cmdAiSearch(config: Config, args: string[]) {
  const { positional, flags } = parseArgs(args)
  const query = positional.join(' ')
  if (!query) die('Usage: siftly-remote ai-search <query>')

  const body: Record<string, unknown> = { query }
  if (flags.limit) body.limit = parseInt(flags.limit, 10)
  if (flags.category) body.category = flags.category

  const res = await api(config, '/api/search/ai', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  output(await res.json())
}

async function cmdList(config: Config, args: string[]) {
  const { flags } = parseArgs(args)

  const params = new URLSearchParams()
  if (flags.category) params.set('category', flags.category)
  if (flags.author) params.set('q', flags.author) // author search via text query
  if (flags.source) params.set('source', flags.source)
  if (flags.media) params.set('mediaType', flags.media)
  if (flags.sort) params.set('sort', flags.sort)
  if (flags.limit) params.set('limit', flags.limit)
  if (flags.page) params.set('page', flags.page)
  if (flags.uncategorized === 'true') params.set('uncategorized', 'true')

  const qs = params.toString()
  const res = await api(config, `/api/bookmarks${qs ? '?' + qs : ''}`)
  output(await res.json())
}

async function cmdShow(config: Config, args: string[]) {
  const id = args[0]
  if (!id) die('Usage: siftly-remote show <id|tweetId>')

  // The /api/bookmarks endpoint doesn't support id lookup directly.
  // Try text search with the id/tweetId as query, then filter client-side.
  const params = new URLSearchParams({ q: id, limit: '50' })
  const res = await api(config, `/api/bookmarks?${params}`)
  const data = await res.json() as { bookmarks: Array<{ id: string; tweetId: string; [k: string]: unknown }> }

  const match = data.bookmarks?.find(
    (b: { id: string; tweetId: string }) => b.id === id || b.tweetId === id
  )

  if (match) {
    output(match)
    return
  }

  // Fallback: try without search query (in case id doesn't appear in text)
  // Fetch recent bookmarks and scan for id match
  const res2 = await api(config, `/api/bookmarks?limit=100`)
  const data2 = await res2.json() as { bookmarks: Array<{ id: string; tweetId: string; [k: string]: unknown }> }

  const match2 = data2.bookmarks?.find(
    (b: { id: string; tweetId: string }) => b.id === id || b.tweetId === id
  )

  if (match2) {
    output(match2)
    return
  }

  die(`Bookmark not found: ${id}`)
}

async function cmdSync(config: Config, args: string[]) {
  const { flags } = parseArgs(args)

  // --status: get current sync status
  if (flags.status === 'true') {
    const res = await api(config, '/api/import/live')
    output(await res.json())
    return
  }

  // Otherwise trigger a sync
  const mode = flags.full === 'true' ? 'full' : 'incremental'
  const res = await api(config, '/api/import/live/sync', {
    method: 'POST',
    body: JSON.stringify({ mode }),
  })
  output(await res.json())
}

async function cmdCategorize(config: Config, args: string[]) {
  const { flags } = parseArgs(args)

  // --status: get current pipeline status
  if (flags.status === 'true') {
    const res = await api(config, '/api/categorize')
    output(await res.json())
    return
  }

  // Otherwise trigger categorization
  const body: Record<string, unknown> = {}
  if (flags.force === 'true') body.force = true

  const res = await api(config, '/api/categorize', {
    method: 'POST',
    body: JSON.stringify(body),
  })
  output(await res.json())
}

async function cmdExport(config: Config, args: string[]) {
  const { flags } = parseArgs(args)

  const type = flags.type
  if (!type) die('Usage: siftly-remote export --type csv|json|zip [-o file]')

  if (!['csv', 'json', 'zip'].includes(type)) {
    die(`Unknown export type: ${type}. Use csv, json, or zip.`)
  }

  const outputFile = flags.o || flags.output
  if (type === 'zip' && !outputFile) {
    die('ZIP export requires an output file: --type zip -o file.zip')
  }

  const params = new URLSearchParams({ type })
  if (flags.category) params.set('category', flags.category)

  const res = await api(config, `/api/export?${params}`)

  if (type === 'zip') {
    // Binary: write to file
    const buffer = await res.arrayBuffer()
    writeFileSync(outputFile!, Buffer.from(buffer))
    const size = Buffer.from(buffer).length
    process.stderr.write(`Exported ${size} bytes to ${outputFile}\n`)
    output({ exported: true, file: outputFile, bytes: size })
    return
  }

  // csv / json: text-based
  const text = await res.text()

  if (outputFile) {
    writeFileSync(outputFile, text, 'utf-8')
    const lines = text.split('\n').length
    process.stderr.write(`Exported ${lines} lines to ${outputFile}\n`)
    output({ exported: true, file: outputFile, lines })
  } else {
    // Pipe raw content to stdout (not JSON-wrapped)
    process.stdout.write(text)
  }
}

// ─── Usage ───────────────────────────────────────────────────────────────────

const COMMANDS: Record<string, string> = {
  config:     'config [--url URL] [--key KEY]    Show or save configuration',
  stats:      'stats                             Server statistics',
  categories: 'categories                        List categories with counts',
  search:     'search <query> [--limit N]        Keyword search bookmarks',
  'ai-search':'ai-search <query> [--category X]  AI-powered semantic search',
  list:       'list [--category X] [--source bookmark|like] [--media photo|video] [--sort newest|oldest] [--limit N] [--page N]',
  show:       'show <id|tweetId>                 Show a single bookmark',
  sync:       'sync [--full] [--status]          Trigger or check X sync',
  categorize: 'categorize [--status] [--force]   Run or check AI pipeline',
  export:     'export --type csv|json|zip [-o file] [--category X]',
}

function showUsage(): void {
  output({
    usage: 'siftly-remote <command> [options]',
    globalFlags: {
      '--url URL': 'Server URL (overrides config)',
      '--key KEY': 'API key (overrides config)',
    },
    commands: COMMANDS,
  })
}

// ─── Router ──────────────────────────────────────────────────────────────────

async function main() {
  const raw = process.argv.slice(2)

  // Extract global flags (--url, --key) before the command
  const { positional, flags } = parseArgs(raw)
  const command = positional[0]
  const rest = positional.slice(1)

  // Re-parse rest args for per-command flags (include original flags minus global ones)
  // We need to pass the original tail args so per-command parsing works correctly
  const commandArgStart = raw.indexOf(command)
  const commandArgs = commandArgStart >= 0 ? raw.slice(commandArgStart + 1) : []
  // Filter out global --url and --key from command args
  const filteredArgs: string[] = []
  for (let i = 0; i < commandArgs.length; i++) {
    if (commandArgs[i] === '--url' || commandArgs[i] === '--key') {
      i++ // skip value
    } else {
      filteredArgs.push(commandArgs[i])
    }
  }

  if (!command || command === '--help' || command === '-h') {
    showUsage()
    process.exit(0)
  }

  // config doesn't need a server connection
  // Pass unfiltered args so --url and --key reach cmdConfig
  if (command === 'config') {
    await cmdConfig(commandArgs)
    return
  }

  const config = loadConfig(flags)

  try {
    switch (command) {
      case 'stats':
        await cmdStats(config)
        break
      case 'categories':
        await cmdCategories(config)
        break
      case 'search':
        await cmdSearch(config, filteredArgs)
        break
      case 'ai-search':
        await cmdAiSearch(config, filteredArgs)
        break
      case 'list':
        await cmdList(config, filteredArgs)
        break
      case 'show':
        await cmdShow(config, rest)
        break
      case 'sync':
        await cmdSync(config, filteredArgs)
        break
      case 'categorize':
        await cmdCategorize(config, filteredArgs)
        break
      case 'export':
        await cmdExport(config, filteredArgs)
        break
      default:
        die(`Unknown command: ${command}. Run 'siftly-remote --help' for usage.`)
    }
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
      die(`Cannot connect to ${config.url}. Is the server running?`)
    }
    throw err
  }
}

main()
