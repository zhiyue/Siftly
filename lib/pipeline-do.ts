/**
 * PipelineDO — Durable Object for the AI categorization pipeline.
 *
 * This class is prepared for future deployment when OpenNext supports
 * exporting custom DOs from the main worker. Currently unused at runtime;
 * the app uses PipelineStateManager from pipeline-state.ts instead.
 */
import { DurableObject } from 'cloudflare:workers'
import type { PipelineState } from './pipeline-state'
import { DEFAULT_STATE } from './pipeline-state'

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
