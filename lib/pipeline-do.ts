/**
 * PipelineDO — Durable Object for the AI categorization pipeline.
 *
 * Manages pipeline state (progress, stage, abort flag) via DO transactional storage.
 * The actual pipeline work runs in the Workers request context (via ctx.waitUntil)
 * because the lib functions depend on getCloudflareContext().
 *
 * NOTE: OpenNext/Cloudflare does not currently support exporting custom DOs from the
 * main worker bundle. This class is used in two ways:
 *
 * 1. **Production (PIPELINE_DO binding available):** The API route proxies state
 *    operations to the DO via fetch(), giving durable cross-request state.
 *
 * 2. **Fallback (no DO binding):** The API route uses the in-process PipelineStateManager
 *    exported below, which stores state on globalThis within the Worker isolate.
 *    This works for a single-user self-hosted app where the pipeline runs within
 *    one isolate's lifetime.
 *
 * The DO provides:
 * - POST /start   — mark pipeline as running, store config
 * - POST /stop    — set abort flag
 * - GET  /status  — return current state
 * - POST /update  — accept progress updates from the running pipeline
 * - POST /finish  — mark pipeline as complete
 */
import { DurableObject } from 'cloudflare:workers'

export interface PipelineState {
  status: 'idle' | 'running' | 'stopping'
  stage: 'entities' | 'parallel' | 'fts' | null
  done: number
  total: number
  stageCounts: {
    visionTagged: number
    entitiesExtracted: number
    enriched: number
    categorized: number
  }
  lastError: string | null
  error: string | null
}

export const DEFAULT_STATE: PipelineState = {
  status: 'idle',
  stage: null,
  done: 0,
  total: 0,
  stageCounts: { visionTagged: 0, entitiesExtracted: 0, enriched: 0, categorized: 0 },
  lastError: null,
  error: null,
}

// ── Durable Object class (for future separate-worker deployment) ─────

export class PipelineDO extends DurableObject<CloudflareEnv> {
  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    try {
      if (request.method === 'GET' && path === '/status') {
        return this.handleStatus()
      }
      if (request.method === 'POST' && path === '/start') {
        return this.handleStart(request)
      }
      if (request.method === 'POST' && path === '/stop') {
        return this.handleStop()
      }
      if (request.method === 'POST' && path === '/update') {
        return this.handleUpdate(request)
      }
      if (request.method === 'POST' && path === '/finish') {
        return this.handleFinish(request)
      }
      return new Response('Not found', { status: 404 })
    } catch (err) {
      console.error('[PipelineDO] error:', err)
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      )
    }
  }

  private async getState(): Promise<PipelineState> {
    const stored = await this.ctx.storage.get<PipelineState>('state')
    return stored ?? { ...DEFAULT_STATE }
  }

  private async setState(update: Partial<PipelineState>): Promise<PipelineState> {
    const current = await this.getState()
    const next = { ...current, ...update }
    await this.ctx.storage.put('state', next)
    return next
  }

  private async handleStatus(): Promise<Response> {
    const state = await this.getState()
    return Response.json(state)
  }

  private async handleStart(request: Request): Promise<Response> {
    const state = await this.getState()
    if (state.status === 'running' || state.status === 'stopping') {
      return Response.json({ error: 'Pipeline is already running' }, { status: 409 })
    }

    const body = (await request.json()) as { total: number }

    await this.setState({
      status: 'running',
      stage: 'entities',
      done: 0,
      total: body.total,
      stageCounts: { visionTagged: 0, entitiesExtracted: 0, enriched: 0, categorized: 0 },
      lastError: null,
      error: null,
    })

    return Response.json({ status: 'started', total: body.total })
  }

  private async handleStop(): Promise<Response> {
    const state = await this.getState()
    if (state.status !== 'running') {
      return Response.json({ error: 'No pipeline running' }, { status: 409 })
    }
    await this.setState({ status: 'stopping' })
    return Response.json({ stopped: true })
  }

  private async handleUpdate(request: Request): Promise<Response> {
    const update = (await request.json()) as Partial<PipelineState>
    const next = await this.setState(update)
    return Response.json(next)
  }

  private async handleFinish(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      error?: string | null
      wasStopped?: boolean
    }

    const state = await this.getState()
    await this.setState({
      status: 'idle',
      stage: null,
      done: body.wasStopped ? state.done : state.total,
      error: body.wasStopped ? 'Stopped by user' : (body.error ?? null),
    })

    return Response.json({ finished: true })
  }
}

// ── In-process state manager (globalThis fallback) ───────────────────

/**
 * Manages pipeline state on globalThis within the Worker isolate.
 * Provides the same interface as the DO but synchronously in-process.
 * Used when the PIPELINE_DO binding is not available.
 */
export interface IPipelineStateManager {
  getState(): PipelineState
  setState(update: Partial<PipelineState>): void
  shouldAbort(): boolean
  start(total: number): void
  stop(): boolean
  finish(opts: { wasStopped?: boolean; error?: string | null }): void
}

const _global = globalThis as unknown as {
  __pipelineState?: PipelineState
}

export function getPipelineStateManager(): IPipelineStateManager {
  if (!_global.__pipelineState) {
    _global.__pipelineState = { ...DEFAULT_STATE }
  }

  return {
    getState() {
      return { ..._global.__pipelineState! }
    },

    setState(update: Partial<PipelineState>) {
      _global.__pipelineState = { ..._global.__pipelineState!, ...update }
    },

    shouldAbort() {
      return _global.__pipelineState!.status === 'stopping'
    },

    start(total: number) {
      _global.__pipelineState = {
        status: 'running',
        stage: 'entities',
        done: 0,
        total,
        stageCounts: { visionTagged: 0, entitiesExtracted: 0, enriched: 0, categorized: 0 },
        lastError: null,
        error: null,
      }
    },

    stop(): boolean {
      if (_global.__pipelineState!.status !== 'running') return false
      _global.__pipelineState!.status = 'stopping'
      return true
    },

    finish(opts: { wasStopped?: boolean; error?: string | null }) {
      const state = _global.__pipelineState!
      _global.__pipelineState = {
        ...state,
        status: 'idle',
        stage: null,
        done: opts.wasStopped ? state.done : state.total,
        error: opts.wasStopped ? 'Stopped by user' : (opts.error ?? null),
      }
    },
  }
}
