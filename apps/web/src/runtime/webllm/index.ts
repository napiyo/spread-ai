import * as webllm from '@mlc-ai/web-llm'
import {
  RuntimeError,
  type GenerateRequest, type GenerateResult, type LoadableModel,
  type LoadProgress, type Runtime, type RunStats,
} from '../types'

/**
 * WebLLM runtime. Fastest path by a wide margin, but it only runs models that
 * have been compiled to MLC format, because each one needs a prebuilt WebAssembly
 * kernel library. `catalog/resolve` is what decides whether a repo qualifies.
 */
export class WebLlmRuntime implements Runtime {
  readonly kind = 'webllm' as const
  model: LoadableModel | null = null

  private engine: webllm.MLCEngineInterface | null = null
  private worker: Worker | null = null

  async load(model: LoadableModel, onProgress: (p: LoadProgress) => void): Promise<void> {
    if (!navigator.gpu) {
      throw new RuntimeError(
        'WebLLM needs WebGPU, which this browser does not have.',
        'Chrome, Edge, or Safari 26 and later can run it.',
      )
    }

    await this.unload()
    onProgress({ phase: 'resolving', text: 'Preparing the engine', progress: 0 })

    const modelId = model.webllmModelId ?? model.id
    const appConfig = buildAppConfig(model, modelId)

    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })

    // WebLLM reports one continuous 0-1 progress covering fetch *and* compile,
    // and only tells us which phase it is in through the text. Parsing it is
    // ugly but it is the difference between "34%" and "Compiling shaders, 34%".
    const initProgressCallback = (r: webllm.InitProgressReport) => {
      onProgress({
        phase: phaseFromText(r.text),
        text: tidy(r.text),
        progress: r.progress,
        fromCache: /cache/i.test(r.text),
      })
    }

    try {
      this.engine = await webllm.CreateWebWorkerMLCEngine(this.worker, modelId, {
        appConfig,
        initProgressCallback,
        logLevel: 'WARN',
      })
    } catch (err) {
      await this.unload()
      throw asRuntimeError(err, model)
    }

    this.model = model
    onProgress({ phase: 'ready', text: 'Ready', progress: 1 })
  }

  async generate(
    req: GenerateRequest,
    onToken: (delta: string) => void,
  ): Promise<GenerateResult> {
    const engine = this.engine
    if (!engine) throw new RuntimeError('No model is loaded.')

    const t0 = performance.now()
    let ttftMs = 0
    let text = ''
    let interrupted = false
    let usage: webllm.CompletionUsage | undefined

    const stream = await engine.chat.completions.create({
      stream: true,
      stream_options: { include_usage: true },
      messages: req.messages,
      temperature: req.temperature ?? 0.7,
      top_p: req.topP ?? 0.95,
      max_tokens: req.maxTokens ?? 1024,
      seed: req.seed,
      stop: req.stop,
    })

    try {
      for await (const chunk of stream) {
        if (chunk.usage) usage = chunk.usage
        const delta = chunk.choices[0]?.delta?.content ?? ''
        if (!delta) continue
        if (!ttftMs) ttftMs = performance.now() - t0
        text += delta
        onToken(delta)
      }
    } catch (err) {
      // `interrupt()` surfaces as a thrown abort rather than a clean end.
      if (String(err).match(/abort|interrupt/i)) interrupted = true
      else throw err
    }

    const totalMs = performance.now() - t0
    return { text, stats: statsFrom(usage, { ttftMs, totalMs, text }), interrupted }
  }

  async interrupt(): Promise<void> {
    await this.engine?.interruptGenerate()
  }

  async unload(): Promise<void> {
    try {
      await this.engine?.unload()
    } catch {
      /* engine may already be gone */
    }
    this.worker?.terminate()
    this.engine = null
    this.worker = null
    this.model = null
  }
}

/* ── helpers ──────────────────────────────────────────────────────────── */

/**
 * Models outside the prebuilt list need their weights *and* a matching compiled
 * kernel library. We can only offer that when the catalog found both.
 */
function buildAppConfig(model: LoadableModel, modelId: string): webllm.AppConfig {
  if (!model.webllmModelUrl) return webllm.prebuiltAppConfig

  if (!model.webllmModelLib) {
    throw new RuntimeError(
      `${model.label} has MLC weights but no compiled kernel library for the web.`,
      'MLC models must be compiled per architecture. Pick a model from the featured list, or one whose repo ships a .wasm library.',
    )
  }

  return {
    ...webllm.prebuiltAppConfig,
    model_list: [
      ...webllm.prebuiltAppConfig.model_list,
      {
        model: model.webllmModelUrl,
        model_id: modelId,
        model_lib: model.webllmModelLib,
        overrides: { context_window_size: model.contextWindow },
      },
    ],
  }
}

function phaseFromText(text: string): LoadProgress['phase'] {
  if (/finish|ready/i.test(text)) return 'ready'
  if (/shader|compil/i.test(text)) return 'compiling'
  if (/fetch|download|load.*param|cache/i.test(text)) return 'fetching'
  return 'resolving'
}

function tidy(text: string): string {
  // WebLLM's strings carry their own bracketed counters, which duplicate the
  // progress bar we already draw.
  return text.replace(/\[\d+\/\d+\]/g, '').replace(/\s+/g, ' ').trim()
}

function statsFrom(
  usage: webllm.CompletionUsage | undefined,
  fallback: { ttftMs: number; totalMs: number; text: string },
): RunStats {
  const extra = usage?.extra as
    | { prefill_tokens_per_s?: number; decode_tokens_per_s?: number; time_to_first_token_s?: number }
    | undefined

  const completionTokens = usage?.completion_tokens ?? Math.round(fallback.text.length / 4)
  const ttftMs = extra?.time_to_first_token_s != null
    ? extra.time_to_first_token_s * 1000
    : fallback.ttftMs

  const decodeMs = Math.max(1, fallback.totalMs - ttftMs)
  return {
    promptTokens: usage?.prompt_tokens ?? 0,
    completionTokens,
    ttftMs,
    prefillTokPerSec: extra?.prefill_tokens_per_s ?? 0,
    decodeTokPerSec: extra?.decode_tokens_per_s ?? (completionTokens / decodeMs) * 1000,
    totalMs: fallback.totalMs,
  }
}

function asRuntimeError(err: unknown, model: LoadableModel): RuntimeError {
  const msg = err instanceof Error ? err.message : String(err)

  if (/out of memory|OOM|allocat/i.test(msg)) {
    return new RuntimeError(
      `Ran out of GPU memory loading ${model.label}.`,
      'Close other tabs, or choose a smaller model. The advisor can tell you which ones fit.',
    )
  }
  if (/buffer size|exceeds|limit/i.test(msg)) {
    return new RuntimeError(
      `${model.label} needs a larger GPU buffer than this device allows.`,
      'This is the usual wall on iPhones, where a single WebGPU buffer is capped near 256 MB.',
    )
  }
  if (/fetch|network|Failed to fetch/i.test(msg)) {
    return new RuntimeError(
      `Could not download ${model.label}.`,
      'Check the connection. Weights already cached from a previous visit still work offline.',
    )
  }
  return new RuntimeError(`Could not load ${model.label}: ${msg}`)
}
