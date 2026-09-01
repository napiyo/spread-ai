import {
  RuntimeError,
  type GenerateRequest, type GenerateResult, type LoadableModel,
  type LoadProgress, type Runtime, type RunStats,
} from '../types'

interface FileProgress {
  status: string
  file?: string
  name?: string
  loaded?: number
  total?: number
  progress?: number
}

/**
 * Main-thread half of the transformers.js runtime.
 *
 * The worker reports progress per file; a model is a dozen files of wildly
 * different sizes, so a naive per-file bar jumps around. We aggregate by bytes
 * across every file we have been told about, which produces a bar that moves
 * monotonically and means something.
 */
export class OnnxRuntime implements Runtime {
  readonly kind = 'onnx' as const
  model: LoadableModel | null = null

  private worker: Worker | null = null
  private seq = 0

  async load(model: LoadableModel, onProgress: (p: LoadProgress) => void): Promise<void> {
    if (!navigator.gpu) {
      throw new RuntimeError(
        'This model needs WebGPU, which this browser does not have.',
        'Chrome, Edge, or Safari 26 and later can run it.',
      )
    }

    await this.unload()
    onProgress({ phase: 'resolving', text: 'Reading the repository', progress: 0 })

    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    this.worker = worker

    const files = new Map<string, { loaded: number; total: number }>()

    await new Promise<void>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent) => {
        const m = e.data
        switch (m.type) {
          case 'progress': {
            const p = m.payload as FileProgress
            const name = p.file ?? p.name ?? ''
            if (p.status === 'progress' && name && p.total) {
              files.set(name, { loaded: p.loaded ?? 0, total: p.total })
            }
            let loaded = 0
            let total = 0
            for (const f of files.values()) {
              loaded += f.loaded
              total += f.total
            }
            onProgress({
              phase: 'fetching',
              text: shortName(name) || 'Downloading weights',
              progress: total ? loaded / total : -1,
              loadedBytes: loaded,
              totalBytes: total,
            })
            break
          }
          case 'phase':
            onProgress({ phase: 'warming', text: 'Compiling shaders', progress: 0.98 })
            break
          case 'ready':
            onProgress({ phase: 'ready', text: 'Ready', progress: 1 })
            resolve()
            break
          case 'error':
            reject(asRuntimeError(m.error, model))
            break
        }
      }
      worker.onerror = (e) => reject(new RuntimeError(e.message || 'The model worker crashed.'))

      worker.postMessage({
        type: 'load',
        repo: model.id,
        dtype: model.onnxDtype ?? 'q4f16',
        contextWindow: model.contextWindow,
      })
    }).catch(async (err) => {
      await this.unload()
      throw err
    })

    this.model = model
  }

  generate(req: GenerateRequest, onToken: (delta: string) => void): Promise<GenerateResult> {
    const worker = this.worker
    if (!worker) return Promise.reject(new RuntimeError('No model is loaded.'))

    const id = ++this.seq
    let text = ''

    return new Promise<GenerateResult>((resolve, reject) => {
      const onMessage = (e: MessageEvent) => {
        const m = e.data
        if (m.id !== undefined && m.id !== id) return
        switch (m.type) {
          case 'token':
            text += m.delta
            onToken(m.delta)
            break
          case 'done':
            worker.removeEventListener('message', onMessage)
            resolve({ text, stats: m.stats as RunStats, interrupted: Boolean(m.interrupted) })
            break
          case 'error':
            worker.removeEventListener('message', onMessage)
            reject(new RuntimeError(String(m.error)))
            break
        }
      }
      worker.addEventListener('message', onMessage)

      worker.postMessage({
        type: 'generate',
        id,
        messages: req.messages,
        options: {
          max_new_tokens: req.maxTokens ?? 1024,
          do_sample: (req.temperature ?? 0.7) > 0,
          temperature: req.temperature ?? 0.7,
          top_p: req.topP ?? 0.95,
        },
      })
    })
  }

  async interrupt(): Promise<void> {
    this.worker?.postMessage({ type: 'interrupt' })
  }

  async unload(): Promise<void> {
    this.worker?.postMessage({ type: 'unload' })
    this.worker?.terminate()
    this.worker = null
    this.model = null
  }
}

function shortName(file: string): string {
  const base = file.split('/').pop() ?? file
  return base.length > 34 ? `${base.slice(0, 31)}…` : base
}

function asRuntimeError(message: string, model: LoadableModel): RuntimeError {
  if (/out of memory|OOM/i.test(message)) {
    return new RuntimeError(
      `Ran out of GPU memory loading ${model.label}.`,
      'Try a lower precision, or a smaller model.',
    )
  }
  if (/Unsupported model type|not supported/i.test(message)) {
    return new RuntimeError(
      `transformers.js has no implementation for ${model.label}'s architecture.`,
      'The ONNX files are there, but the runtime does not know this model family yet.',
    )
  }
  if (/buffer|exceeds|limit/i.test(message)) {
    return new RuntimeError(
      `${model.label} needs a bigger GPU buffer than this device allows.`,
      'Common on phones, where a single WebGPU allocation is capped low.',
    )
  }
  return new RuntimeError(`Could not load ${model.label}: ${message}`)
}
