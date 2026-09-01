import type { Quant } from '@/planner/modelSpec'
import type { CatalogEntry } from './types'

/**
 * The featured shelf is a *curation over WebLLM's own prebuilt list*, not a
 * copy of it. Sizes, context windows and VRAM figures are read from the library
 * at runtime so they can never drift out of date; only the ordering and the
 * plain-English blurb live here.
 */
interface Curation {
  modelId: string
  blurb: string
  tags: string[]
  paramsB: number
  family: string
  label?: string
}

const CURATED: Curation[] = [
  {
    modelId: 'Qwen3-0.6B-q4f16_1-MLC',
    label: 'Qwen3 0.6B',
    family: 'Qwen',
    paramsB: 0.6,
    blurb: 'The one that runs anywhere, phones included. Fast, and small enough to be the draft model when two devices work together.',
    tags: ['tiny', 'phone-friendly', 'draft model'],
  },
  {
    modelId: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
    label: 'Llama 3.2 1B',
    family: 'Llama',
    paramsB: 1.24,
    blurb: 'A capable small assistant. A good first download — under a gigabyte, and quick on almost any laptop.',
    tags: ['small', 'general'],
  },
  {
    modelId: 'Qwen3-1.7B-q4f16_1-MLC',
    label: 'Qwen3 1.7B',
    family: 'Qwen',
    paramsB: 1.7,
    blurb: 'Noticeably sharper than the 0.6B at reasoning and code, still light enough for a mid-range laptop.',
    tags: ['small', 'reasoning'],
  },
  {
    modelId: 'gemma-2-2b-it-q4f16_1-MLC',
    label: 'Gemma 2 2B',
    family: 'Gemma',
    paramsB: 2.6,
    blurb: "Google's small instruction model. Even-tempered and good at following a format.",
    tags: ['small', 'general'],
  },
  {
    modelId: 'Llama-3.2-3B-Instruct-q4f16_1-MLC',
    label: 'Llama 3.2 3B',
    family: 'Llama',
    paramsB: 3.2,
    blurb: 'The sweet spot on a modern laptop: real conversational quality without a long download.',
    tags: ['balanced', 'general'],
  },
  {
    modelId: 'Qwen3-4B-q4f16_1-MLC',
    label: 'Qwen3 4B',
    family: 'Qwen',
    paramsB: 4.0,
    blurb: 'Strong at code and structured output for its size. A good default if your laptop has memory to spare.',
    tags: ['balanced', 'code'],
  },
  {
    modelId: 'Phi-4-mini-instruct-q4f16_1-MLC',
    label: 'Phi-4 mini',
    family: 'Phi',
    paramsB: 3.8,
    blurb: "Microsoft's small reasoner. Punches above its parameter count on maths and logic.",
    tags: ['balanced', 'reasoning'],
  },
  {
    modelId: 'Qwen3-8B-q4f16_1-MLC',
    label: 'Qwen3 8B',
    family: 'Qwen',
    paramsB: 8.2,
    blurb: 'About as large as a browser tab can comfortably hold. Wants a recent laptop with headroom, and a patient first download.',
    tags: ['large', 'reasoning'],
  },
  {
    modelId: 'Llama-3.1-8B-Instruct-q4f16_1-MLC',
    label: 'Llama 3.1 8B',
    family: 'Llama',
    paramsB: 8.03,
    blurb: 'The familiar 8B workhorse. Broad general knowledge; the heaviest thing here that still runs on one device.',
    tags: ['large', 'general'],
  },
  {
    modelId: 'DeepSeek-R1-Distill-Qwen-7B-q4f16_1-MLC',
    label: 'DeepSeek-R1 Distill 7B',
    family: 'DeepSeek',
    paramsB: 7.6,
    blurb: 'Thinks out loud before answering. Slower per answer, but much better on problems that need working through.',
    tags: ['large', 'reasoning', 'thinks aloud'],
  },
  {
    modelId: 'SmolLM2-360M-Instruct-q4f16_1-MLC',
    label: 'SmolLM2 360M',
    family: 'SmolLM',
    paramsB: 0.36,
    blurb: 'Barely a model, and that is the point — it loads in seconds and proves a device works before you commit to a real download.',
    tags: ['tiny', 'phone-friendly', 'smoke test'],
  },
]

function quantOf(modelId: string): Quant {
  if (modelId.includes('q4f16')) return 'q4f16_1'
  if (modelId.includes('q4f32')) return 'q4f32_1'
  if (modelId.includes('q0f16')) return 'fp16'
  if (modelId.includes('q0f32')) return 'fp32'
  return 'q4f16_1'
}

let cache: CatalogEntry[] | null = null

/**
 * WebLLM is several megabytes. Importing it at module scope to read a list of
 * model ids dragged the whole engine into the initial bundle, so the landing
 * page could not paint until it had downloaded. It is loaded on demand instead;
 * the engine itself only ever runs inside a worker.
 */
export async function loadWebLlmCatalogue() {
  const webllm = await import('@mlc-ai/web-llm')
  return webllm.prebuiltAppConfig.model_list
}

export async function featuredModels(): Promise<CatalogEntry[]> {
  if (cache) return cache

  const list = await loadWebLlmCatalogue()
  const byId = new Map(list.map((m) => [m.model_id, m]))

  cache = CURATED.flatMap((c) => {
    const rec = byId.get(c.modelId)
    // A curated id that WebLLM has dropped is a bug on our side, but silently
    // shipping a broken card would be worse than quietly omitting it.
    if (!rec) {
      console.warn(`[catalog] curated model ${c.modelId} is not in WebLLM's prebuilt list`)
      return []
    }
    return [
      {
        id: c.modelId,
        label: c.label ?? c.modelId,
        family: c.family,
        paramsB: c.paramsB,
        runtime: 'webllm' as const,
        quant: quantOf(c.modelId),
        vramMb: rec.vram_required_MB ?? null,
        contextWindow: rec.overrides?.context_window_size ?? 4096,
        blurb: c.blurb,
        tags: c.tags,
        hfRepo: repoFromUrl(rec.model),
        webllmModelId: c.modelId,
        featured: true,
      },
    ]
  })

  return cache
}

/** Every MLC model WebLLM can run, for the "show me everything" view. */
export async function allWebLlmModels(): Promise<CatalogEntry[]> {
  const featured = new Set((await featuredModels()).map((f) => f.id))
  return (await loadWebLlmCatalogue())
    .filter((m) => !featured.has(m.model_id))
    .map((m) => ({
      id: m.model_id,
      label: m.model_id.replace(/-MLC.*$/, '').replace(/-q[04]f(16|32)(_1)?/, ''),
      family: m.model_id.split('-')[0],
      paramsB: paramsFromId(m.model_id),
      runtime: 'webllm' as const,
      quant: quantOf(m.model_id),
      vramMb: m.vram_required_MB ?? null,
      contextWindow: m.overrides?.context_window_size ?? 4096,
      blurb: '',
      tags: m.low_resource_required ? ['phone-friendly'] : [],
      hfRepo: repoFromUrl(m.model),
      webllmModelId: m.model_id,
      featured: false,
    }))
}

function repoFromUrl(url: string | undefined): string | null {
  if (!url) return null
  const m = /huggingface\.co\/([^/]+\/[^/?#]+)/.exec(url)
  return m ? m[1] : null
}

/** "Qwen3-8B-q4f16_1-MLC" -> 8. Best effort, for sorting only. */
function paramsFromId(id: string): number {
  const m = /(\d+(?:\.\d+)?)\s*([BbMm])(?![a-z])/.exec(id)
  if (!m) return 0
  const n = parseFloat(m[1])
  return m[2].toLowerCase() === 'm' ? n / 1000 : n
}
