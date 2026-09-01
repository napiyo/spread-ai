import type { ModelSpec, Quant } from '@/planner/modelSpec'

export type RuntimeKind = 'webllm' | 'onnx' | 'pipeline'

/** A model resolved to something we can actually load. */
export interface LoadableModel {
  /** Hugging Face repo id, or a WebLLM prebuilt model_id. */
  id: string
  label: string
  runtime: RuntimeKind
  quant: Quant
  /** WebLLM's own model identifier, when the runtime is webllm. */
  webllmModelId?: string
  /** Custom weights + compiled library, for models outside the prebuilt list. */
  webllmModelUrl?: string
  webllmModelLib?: string
  /** transformers.js: the dtype string it expects, e.g. 'q4f16'. */
  onnxDtype?: string
  /** Bytes to download. Best-effort; used for progress and for warnings. */
  downloadBytes?: number
  contextWindow: number
  spec?: ModelSpec
}

export type LoadPhase = 'resolving' | 'fetching' | 'compiling' | 'warming' | 'ready'

export interface LoadProgress {
  phase: LoadPhase
  text: string
  /** 0-1, or -1 when the runtime won't tell us. */
  progress: number
  loadedBytes?: number
  totalBytes?: number
  /** True once weights came from cache rather than the network. */
  fromCache?: boolean
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface GenerateRequest {
  messages: ChatMessage[]
  temperature?: number
  topP?: number
  maxTokens?: number
  seed?: number
  stop?: string[]
}

/** Measured, never estimated. These are what recalibrate the planner. */
export interface RunStats {
  promptTokens: number
  completionTokens: number
  ttftMs: number
  prefillTokPerSec: number
  decodeTokPerSec: number
  totalMs: number
  /** Which device did the work — set by the mesh strategies, not locally. */
  deviceLabel?: string
}

export interface GenerateResult {
  text: string
  stats: RunStats
  /** True when generation was cut short by interrupt(). */
  interrupted: boolean
}

export interface Runtime {
  readonly kind: RuntimeKind
  readonly model: LoadableModel | null
  load(model: LoadableModel, onProgress: (p: LoadProgress) => void): Promise<void>
  generate(req: GenerateRequest, onToken: (delta: string) => void): Promise<GenerateResult>
  interrupt(): Promise<void>
  unload(): Promise<void>
}

/** Thrown when a model cannot run here, with a reason worth showing a user. */
export class RuntimeError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message)
    this.name = 'RuntimeError'
  }
}
