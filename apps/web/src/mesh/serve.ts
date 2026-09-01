import type { Mesh } from './mesh'
import {
  TOKEN_TOPIC,
  type GenerateParams, type GenerateReply, type InterruptParams,
} from './protocol'
import type { GenerateResult, RunStats } from '@/runtime/types'

/**
 * What this device is willing to do on behalf of another.
 *
 * Deliberately narrow: a peer can ask what we are capable of, and can ask us to
 * run a generation on a model *we* already have loaded. It cannot make us
 * download anything, load anything, or reach outside the tab.
 */

/** The half of the engine this needs, named so it can be driven by a test. */
export interface ServeEngine {
  readonly deviceLabel: string
  /** Whatever is loaded right now, or null. */
  readonly loadedModelId: string | null
  readonly loadedModelLabel: string | null
  readonly busy: boolean
  generate(
    params: GenerateParams,
    onToken: (delta: string) => void,
  ): Promise<GenerateResult | null>
  /** Why the last generate() gave back nothing. */
  lastError(): string | null
  interrupt(): void
  capability(): unknown
}

export function serveWork(mesh: Mesh, engine: () => ServeEngine): () => void {
  /**
   * The run we are currently doing for someone else. One at a time, because a
   * single engine holds one model and interleaving two conversations through it
   * would corrupt both.
   */
  let serving: { runId: string; from: string } | null = null

  const offs = [
    mesh.handle('capability', () => engine().capability()),

    mesh.handle('generate', async (params, from): Promise<GenerateReply> => {
      const p = params as GenerateParams
      const e = engine()
      const deviceLabel = e.deviceLabel

      if (!e.loadedModelId) throw new Error(`${deviceLabel} has no model loaded.`)
      if (e.loadedModelId !== p.modelId) {
        throw new Error(
          `${deviceLabel} has ${e.loadedModelLabel ?? 'something else'} loaded, not ${p.modelId}.`,
        )
      }
      // Without this the second request quietly resolves to nothing, because
      // the engine refuses to start while it is already generating.
      if (e.busy || serving) throw new Error(`${deviceLabel} is busy with another reply.`)

      serving = { runId: p.runId, from }
      try {
        const result = await e.generate(p, (delta) =>
          // To the requester alone, tagged with the run it belongs to. A
          // broadcast would hand everyone else in the room a copy of a reply
          // they never asked for.
          mesh.emit(from, TOKEN_TOPIC, { runId: p.runId, delta }),
        )

        // The engine reports failure by returning nothing and parking the
        // reason elsewhere; passing that back as an empty reply would show the
        // other device a blank answer instead of what went wrong.
        if (!result) {
          throw new Error(e.lastError() ?? `${deviceLabel} could not generate a reply.`)
        }
        return {
          text: result.text,
          stats: withDevice(result.stats, deviceLabel),
          interrupted: result.interrupted,
          deviceLabel,
        }
      } finally {
        serving = null
        mesh.emit(from, TOKEN_TOPIC, { runId: p.runId, done: true })
      }
    }),

    mesh.handle('interrupt', (params, from) => {
      const { runId } = (params ?? {}) as Partial<InterruptParams>
      // A stop that arrives after its own run finished must not cancel whatever
      // started next — including something the owner of this device typed.
      if (!serving || serving.from !== from || (runId && serving.runId !== runId)) return false
      engine().interrupt()
      return true
    }),

    mesh.handle('listCachedModels', async () => {
      // Which models this device already has on disk, so a peer can pull
      // weights from it instead of the internet.
      if (!('caches' in globalThis)) return []
      const names = await caches.keys()
      return names.filter((n) => /webllm|mlc|transformers/i.test(n))
    }),
  ]

  return () => {
    for (const off of offs) off()
  }
}

function withDevice(stats: RunStats, deviceLabel: string): RunStats {
  return { ...stats, deviceLabel }
}
