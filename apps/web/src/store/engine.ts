import { create } from 'zustand'
import { createRuntime } from '@/runtime'
import {
  RuntimeError,
  type GenerateRequest, type GenerateResult, type LoadableModel,
  type LoadProgress, type Runtime, type RunStats,
} from '@/runtime/types'
import { calibrate } from '@/planner/roofline'
import { useDevice } from './device'

interface EngineState {
  model: LoadableModel | null
  status: 'idle' | 'loading' | 'ready' | 'error'
  progress: LoadProgress | null
  error: { message: string; hint?: string } | null
  generating: boolean
  lastStats: RunStats | null

  load: (model: LoadableModel) => Promise<void>
  unload: () => Promise<void>
  generate: (req: GenerateRequest, onToken: (d: string) => void) => Promise<GenerateResult | null>
  interrupt: () => Promise<void>
}

let runtime: Runtime | null = null
/**
 * Generations completed since the current model was loaded. The first one pays
 * for lazy shader compilation and runs roughly half speed, so it is a fact
 * about start-up rather than about this device and must never calibrate.
 */
let runsSinceLoad = 0

export const useEngine = create<EngineState>((set, get) => ({
  model: null,
  status: 'idle',
  progress: null,
  error: null,
  generating: false,
  lastStats: null,

  async load(model) {
    if (get().status === 'loading') return
    // Reloading the model that is already live would throw away a warm engine
    // and several seconds of shader compilation for nothing.
    if (get().status === 'ready' && get().model?.id === model.id) return

    set({ status: 'loading', model, progress: null, error: null })
    try {
      await runtime?.unload()
      runtime = await createRuntime(model)
      await runtime.load(model, (progress) => set({ progress }))
      runsSinceLoad = 0
      set({ status: 'ready', progress: { phase: 'ready', text: 'Ready', progress: 1 } })
    } catch (e) {
      runtime = null
      const err =
        e instanceof RuntimeError
          ? { message: e.message, hint: e.hint }
          : { message: e instanceof Error ? e.message : String(e) }
      set({ status: 'error', error: err, progress: null })
    }
  },

  async unload() {
    await runtime?.unload()
    runtime = null
    set({ status: 'idle', model: null, progress: null, error: null, lastStats: null })
  },

  async generate(req, onToken) {
    if (!runtime || get().status !== 'ready' || get().generating) return null
    set({ generating: true, error: null })
    try {
      const result = await runtime.generate(req, onToken)
      runsSinceLoad++
      set({ generating: false, lastStats: result.stats })
      if (runsSinceLoad > 1 && !result.interrupted) recalibrate(result.stats)
      return result
    } catch (e) {
      set({
        generating: false,
        error: { message: e instanceof Error ? e.message : String(e) },
      })
      return null
    }
  },

  async interrupt() {
    await runtime?.interrupt()
  },
}))

/**
 * Every real generation is a measurement. Feeding it back into the planner is
 * what turns the advisor's projections from spec-sheet arithmetic into numbers
 * anchored to hardware we have actually watched work.
 */
function recalibrate(stats: RunStats) {
  const { model } = useEngine.getState()
  const { capability, setCalibration } = useDevice.getState()
  const spec = model?.spec
  if (!spec || !capability) return

  // Very short replies give a decode rate measured over a few milliseconds.
  if (stats.completionTokens < 8 || !stats.decodeTokPerSec || !Number.isFinite(stats.decodeTokPerSec)) return

  setCalibration(
    calibrate(spec, capability, {
      tokensPerSec: stats.decodeTokPerSec,
      ttftMs: Math.max(1, stats.ttftMs),
      promptTokens: Math.max(1, stats.promptTokens),
      ctx: stats.promptTokens + stats.completionTokens,
    }),
  )
}
