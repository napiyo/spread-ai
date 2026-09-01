/**
 * Structural facts about a model, derived from its HF `config.json` plus the
 * quantisation it ships in. Everything the advisor claims is computed from
 * here, so this file is deliberately explicit about where each byte goes.
 */

export type Quant =
  | 'q4f16_1' | 'q4f32_1' | 'q4' | 'q8' | 'int8' | 'int4' | 'fp16' | 'bf16' | 'fp32'

/**
 * Effective bytes per parameter, including the per-group scales and zero-points
 * that quantised formats carry. A "4-bit" model is never actually 0.5 B/param.
 */
export const BYTES_PER_PARAM: Record<Quant, number> = {
  q4f16_1: 0.5625, // 4-bit weights, fp16 scale+zero per group of 32
  q4f32_1: 0.625,
  q4: 0.5625,
  int4: 0.5625,
  q8: 1.0625,
  int8: 1.0625,
  fp16: 2,
  bf16: 2,
  fp32: 4,
}

export const QUANT_LABEL: Record<Quant, string> = {
  q4f16_1: '4-bit', q4f32_1: '4-bit', q4: '4-bit', int4: '4-bit',
  q8: '8-bit', int8: '8-bit',
  fp16: 'fp16', bf16: 'bf16', fp32: 'fp32',
}

export interface ModelSpec {
  id: string
  label: string
  /** Total parameter count, including embeddings. */
  params: number
  nLayers: number
  hiddenSize: number
  nHeads: number
  /** Grouped-query attention: usually far smaller than nHeads. */
  nKvHeads: number
  headDim: number
  intermediateSize: number
  vocabSize: number
  maxContext: number
  quant: Quant
  /** Weight tying removes a whole vocab x hidden matrix. */
  tiedEmbeddings: boolean
  /** Mixture-of-experts, when present. */
  moe?: { experts: number; active: number }
}

/** Bytes the KV cache occupies for one token, across all layers. */
export function kvBytesPerToken(m: ModelSpec, kvBytes = 2): number {
  return 2 * m.nLayers * m.nKvHeads * m.headDim * kvBytes
}

export interface ByteBudget {
  /** Every weight the model has, on disk and in memory. */
  totalWeightBytes: number
  /** The token-embedding table: stored, but only one row is read per token. */
  embeddingBytes: number
  /** The output projection: read in full on every single token. */
  lmHeadBytes: number
  /** Transformer blocks. */
  bodyBytes: number
  /** Bytes actually streamed from memory to produce one token. */
  activeWeightBytes: number
  /** Weight bytes in one transformer layer — the unit of pipeline sharding. */
  bytesPerLayer: number
  /**
   * The largest single tensor. This is what collides with a WebGPU per-buffer
   * cap, and it is usually the output projection rather than anything in the
   * body. Runtimes often split it; we flag it rather than assume either way.
   */
  largestTensorBytes: number
}

export function byteBudget(m: ModelSpec): ByteBudget {
  const bpp = BYTES_PER_PARAM[m.quant] ?? 2
  const totalWeightBytes = m.params * bpp

  const embedParams = m.vocabSize * m.hiddenSize
  const embeddingBytes = embedParams * bpp
  const lmHeadBytes = embeddingBytes // same shape, tied or not

  // `params` already counts the lm_head when embeddings are untied.
  const nonBodyBytes = embeddingBytes + (m.tiedEmbeddings ? 0 : lmHeadBytes)
  const bodyBytes = Math.max(0, totalWeightBytes - nonBodyBytes)

  // For MoE only the routed experts are read per token; attention and the
  // shared parts are read in full. Approximating the body as MLP-dominated is
  // close enough at these ratios and errs toward pessimism.
  const activeBody = m.moe ? bodyBytes * (0.25 + 0.75 * (m.moe.active / m.moe.experts)) : bodyBytes

  return {
    totalWeightBytes,
    embeddingBytes,
    lmHeadBytes,
    bodyBytes,
    activeWeightBytes: activeBody + lmHeadBytes,
    bytesPerLayer: bodyBytes / Math.max(1, m.nLayers),
    largestTensorBytes: Math.max(lmHeadBytes, bodyBytes / Math.max(1, m.nLayers)),
  }
}

/** Total memory to run at a given context length. */
export function footprintBytes(m: ModelSpec, ctx: number): number {
  return byteBudget(m).totalWeightBytes + kvBytesPerToken(m) * ctx
}

/** Parameters that participate in the matmuls of a forward pass. */
export function activeParams(m: ModelSpec): number {
  const embed = m.vocabSize * m.hiddenSize
  const body = m.params - embed * (m.tiedEmbeddings ? 1 : 2)
  const activeBody = m.moe ? body * (0.25 + 0.75 * (m.moe.active / m.moe.experts)) : body
  return activeBody + embed // + lm_head
}

/**
 * Builds a spec from a raw HF `config.json`. Falls back sensibly for the many
 * architectures that name the same field differently.
 */
export function specFromHfConfig(
  id: string,
  cfg: Record<string, unknown>,
  quant: Quant,
  opts: { label?: string; params?: number } = {},
): ModelSpec {
  const num = (k: string, d: number) => {
    const v = cfg[k]
    return typeof v === 'number' && Number.isFinite(v) ? v : d
  }

  const hiddenSize = num('hidden_size', num('n_embd', num('d_model', 2048)))
  const nLayers = num('num_hidden_layers', num('n_layer', num('num_layers', 24)))
  const nHeads = num('num_attention_heads', num('n_head', 16))
  const nKvHeads = num('num_key_value_heads', nHeads)
  const headDim = num('head_dim', Math.floor(hiddenSize / Math.max(1, nHeads)))
  const vocabSize = num('vocab_size', 32000)
  const intermediateSize = num('intermediate_size', hiddenSize * 4)
  const maxContext = num(
    'max_position_embeddings',
    // `context_window_size` is what MLC calls it.
    num('context_window_size', num('n_positions', num('max_sequence_length', 4096))),
  )

  const experts = num('num_local_experts', num('num_experts', 0))
  const active = num('num_experts_per_tok', 0)

  return {
    id,
    label: opts.label ?? id.split('/').pop() ?? id,
    params: opts.params ?? estimateParams({ hiddenSize, nLayers, nKvHeads, nHeads, headDim, intermediateSize, vocabSize, experts, active }),
    nLayers,
    hiddenSize,
    nHeads,
    nKvHeads,
    headDim,
    intermediateSize,
    vocabSize,
    maxContext,
    quant,
    tiedEmbeddings: cfg['tie_word_embeddings'] !== false,
    moe: experts > 0 && active > 0 ? { experts, active } : undefined,
  }
}

/** Counts parameters from shape alone, for repos that don't publish a total. */
function estimateParams(s: {
  hiddenSize: number; nLayers: number; nKvHeads: number; nHeads: number
  headDim: number; intermediateSize: number; vocabSize: number
  experts: number; active: number
}): number {
  const qkvo =
    s.hiddenSize * s.nHeads * s.headDim + // q
    2 * s.hiddenSize * s.nKvHeads * s.headDim + // k, v
    s.nHeads * s.headDim * s.hiddenSize // o
  // Gated MLP (SwiGLU): gate, up, down.
  const mlpOne = 3 * s.hiddenSize * s.intermediateSize
  const mlp = s.experts > 0 ? mlpOne * s.experts : mlpOne
  return s.nLayers * (qkvo + mlp) + s.vocabSize * s.hiddenSize
}
