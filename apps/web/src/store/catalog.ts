import { create } from 'zustand'
import { allWebLlmModels, featuredModels } from '@/catalog/featured'
import type { CatalogEntry } from '@/catalog/types'
import { fetchConfig, modelInfo } from '@/catalog/hf'
import { resolveRepo, type Resolution } from '@/catalog/resolve'
import { specFromHfConfig, type ModelSpec } from '@/planner/modelSpec'
import type { LoadableModel } from '@/runtime/types'

interface CatalogState {
  featured: CatalogEntry[]
  all: CatalogEntry[]
  /** Exact architecture, fetched from each model's config.json. */
  specs: Record<string, ModelSpec>
  loadingSpecs: boolean

  query: string
  resolving: boolean
  resolution: Resolution | null
  resolveError: string | null

  init: () => Promise<void>
  resolve: (input: string) => Promise<void>
  clearResolution: () => void
}

export const useCatalog = create<CatalogState>((set, get) => ({
  featured: [],
  all: [],
  specs: {},
  loadingSpecs: false,
  query: '',
  resolving: false,
  resolution: null,
  resolveError: null,

  async init() {
    if (get().featured.length || get().loadingSpecs) return
    set({ loadingSpecs: true })
    const featured = await featuredModels()
    set({ featured, loadingSpecs: true })
    void allWebLlmModels().then((all) => set({ all }))

    // Every featured model is a real Hugging Face repo, so we read the actual
    // architecture rather than guessing from the parameter count. Layer count
    // and KV-head count change the answer a lot, and both are only in the config.
    Promise.all(
      featured.map(async (e) => {
        if (!e.hfRepo) return null
        try {
          const [cfg, info] = await Promise.all([fetchConfig(e.hfRepo), safeInfo(e.hfRepo)])
          if (!cfg) return null
          return [
            e.id,
            specFromHfConfig(e.id, cfg, e.quant, {
              label: e.label,
              params: info?.safetensors?.total ?? Math.round(e.paramsB * 1e9),
            }),
          ] as const
        } catch {
          return null
        }
      }),
    ).then((rows) => {
      const specs = { ...get().specs }
      for (const r of rows) if (r) specs[r[0]] = r[1]
      set({ specs, loadingSpecs: false })
    })
  },

  async resolve(input) {
    set({ resolving: true, resolveError: null, query: input })
    try {
      const resolution = await resolveRepo(input)
      set({ resolution, resolving: false })
      if (resolution.spec) {
        set({ specs: { ...get().specs, [resolution.repo]: resolution.spec } })
      }
    } catch (e) {
      set({
        resolving: false,
        resolveError: e instanceof Error ? e.message : String(e),
        resolution: null,
      })
    }
  },

  clearResolution() {
    set({ resolution: null, resolveError: null, query: '' })
  },
}))

async function safeInfo(repo: string) {
  try {
    return await modelInfo(repo)
  } catch {
    return null
  }
}

/** Turns a shelf entry into something the engine can load. */
export function toLoadable(entry: CatalogEntry, spec?: ModelSpec): LoadableModel {
  return {
    id: entry.id,
    label: entry.label,
    runtime: entry.runtime,
    quant: entry.quant,
    webllmModelId: entry.webllmModelId,
    onnxDtype: entry.onnxDtype,
    contextWindow: entry.contextWindow,
    downloadBytes: entry.vramMb ? entry.vramMb * 1024 ** 2 : undefined,
    spec,
  }
}
