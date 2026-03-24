/**
 * In-process pipeline state manager (globalThis fallback).
 *
 * Manages pipeline state on globalThis within the Worker isolate.
 * Used when the PIPELINE_DO binding is not available (current default).
 * For a single-user self-hosted app, this works within one isolate's lifetime.
 */

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
