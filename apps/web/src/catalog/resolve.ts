import { specFromHfConfig, type ModelSpec, type Quant } from '@/planner/modelSpec'
import type { LoadableModel } from '@/runtime/types'
import { loadWebLlmCatalogue } from './featured'
import { fetchConfig, modelInfo, parseRepoId, sizeOf, tree, HfError, type HfModelInfo } from './hf'

/**
 * Decides what, if anything, we can do with an arbitrary Hugging Face repo.
 *
 * The contract is that this never fails silently. Every repo comes back either
 * runnable with a concrete plan, or refused with a reason a person can act on —
 * because "paste any model link" is only a real feature if the no is as clear
 * as the yes.
 */

export type Verdict = 'mlc' | 'onnx' | 'shardable' | 'unsupported'

export interface OnnxVariant {
  /** transformers.js dtype string. */
  dtype: string
  file: string
  bytes: number
  quant: Quant
  label: string
}

export interface Resolution {
  repo: string
  verdict: Verdict
  /** One line, always present, always specific. */
  reason: string
  /** What to do about a refusal, when there is something. */
  hint?: string
  label: string
  spec: ModelSpec | null
  /** Total download in bytes for the chosen variant. */
  downloadBytes: number | null
  loadable: LoadableModel | null
  variants: OnnxVariant[]
  info: HfModelInfo | null
}

/* ── ONNX variant naming, as used across onnx-community ───────────────── */

const ONNX_VARIANTS: { match: RegExp; dtype: string; quant: Quant; label: string; rank: number }[] = [
  { match: /model_q4f16\.onnx$/, dtype: 'q4f16', quant: 'q4f16_1', label: '4-bit, fp16 activations', rank: 0 },
  { match: /model_q4\.onnx$/, dtype: 'q4', quant: 'q4', label: '4-bit', rank: 1 },
  { match: /model_bnb4\.onnx$/, dtype: 'bnb4', quant: 'q4', label: '4-bit (bitsandbytes)', rank: 2 },
  { match: /model_int8\.onnx$/, dtype: 'int8', quant: 'int8', label: '8-bit', rank: 3 },
  { match: /model_quantized\.onnx$/, dtype: 'quantized', quant: 'int8', label: '8-bit', rank: 4 },
  { match: /model_uint8\.onnx$/, dtype: 'uint8', quant: 'int8', label: '8-bit (unsigned)', rank: 5 },
  { match: /model_fp16\.onnx$/, dtype: 'fp16', quant: 'fp16', label: 'fp16', rank: 6 },
  { match: /model\.onnx$/, dtype: 'fp32', quant: 'fp32', label: 'fp32 (full precision)', rank: 7 },
]

/** Architectures we know how to slice for pipeline sharding. */
const SHARDABLE_ARCHITECTURES = /qwen[23]|llama|mistral|phi[34]?|gemma[23]?|smollm/i

export async function resolveRepo(input: string): Promise<Resolution> {
  const repo = parseRepoId(input)
  if (!repo) {
    return refusal(
      input,
      "That doesn't look like a Hugging Face model.",
      'Paste a link like https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX, or just `owner/name`.',
    )
  }

  let info: HfModelInfo
  try {
    info = await modelInfo(repo)
  } catch (e) {
    const msg = e instanceof HfError ? e.message : 'Could not reach Hugging Face.'
    return refusal(
      repo,
      msg,
      e instanceof HfError && e.status === 403
        ? 'Gated repos need a token and an accepted licence, neither of which a browser tab can supply.'
        : undefined,
    )
  }

  const files = (info.siblings ?? []).map((s) => s.rfilename)
  const label = repo.split('/').pop() ?? repo

  // 1. Already compiled for WebLLM? Fastest path by far, so check it first.
  const prebuilt = (await loadWebLlmCatalogue()).find(
    (m) => m.model?.includes(`/${repo}`) || m.model?.endsWith(repo),
  )
  if (prebuilt) {
    const spec = await specFor(repo, quantFromMlcId(prebuilt.model_id), info)
    return {
      repo,
      verdict: 'mlc',
      reason: 'Already compiled for WebLLM. This is the fastest way to run it here.',
      label,
      spec,
      downloadBytes: prebuilt.vram_required_MB ? prebuilt.vram_required_MB * 1024 ** 2 : null,
      variants: [],
      info,
      loadable: {
        id: repo,
        label,
        runtime: 'webllm',
        quant: quantFromMlcId(prebuilt.model_id),
        webllmModelId: prebuilt.model_id,
        contextWindow: prebuilt.overrides?.context_window_size ?? 4096,
        downloadBytes: prebuilt.vram_required_MB ? prebuilt.vram_required_MB * 1024 ** 2 : undefined,
        spec: spec ?? undefined,
      },
    }
  }

  // 2. MLC weights without a compiled library. Worth being precise about: the
  // weights are fine, what's missing is the WebAssembly kernel library, and
  // that cannot be produced in a browser.
  if (files.includes('mlc-chat-config.json')) {
    const wasm = files.find((f) => f.endsWith('.wasm'))
    if (!wasm) {
      return refusal(
        repo,
        'These are MLC weights, but the repo has no compiled WebGPU kernel library.',
        'MLC models need a .wasm library built per architecture and quantisation. Pick one from the featured list, which are all pre-compiled.',
        info,
      )
    }
  }

  // 3. ONNX, which is the path that makes arbitrary repos actually work.
  const onnxFiles = files.filter((f) => /^onnx\/.*\.onnx$/.test(f))
  if (onnxFiles.length) {
    const entries = await tree(repo, 'onnx')
    const bySize = new Map(entries.map((e) => [e.path, sizeOf(e)]))
    // External-data blobs sit beside the graph and must be counted.
    const externalData = entries
      .filter((e) => e.path.endsWith('.onnx_data'))
      .reduce((a, e) => a + sizeOf(e), 0)

    const variants: OnnxVariant[] = ONNX_VARIANTS.flatMap((v) => {
      const file = onnxFiles.find((f) => v.match.test(f))
      if (!file) return []
      const own = bySize.get(file) ?? 0
      // Only the unquantised graph uses the shared external-data file.
      const bytes = own + (file.endsWith('/model.onnx') ? externalData : 0)
      return [{ dtype: v.dtype, file, bytes, quant: v.quant, label: v.label }]
    })

    if (!variants.length) {
      return refusal(repo, 'It has ONNX files, but none in the layout transformers.js expects.', undefined, info)
    }

    const best = variants[0]
    const spec = await specFor(repo, best.quant, info)
    return {
      repo,
      verdict: 'onnx',
      reason: `Runs through transformers.js on WebGPU. ${variants.length} precision${variants.length > 1 ? 's' : ''} available.`,
      label,
      spec,
      downloadBytes: best.bytes,
      variants,
      info,
      loadable: {
        id: repo,
        label,
        runtime: 'onnx',
        quant: best.quant,
        onnxDtype: best.dtype,
        contextWindow: spec?.maxContext ?? 4096,
        downloadBytes: best.bytes,
        spec: spec ?? undefined,
      },
    }
  }

  // 4. Raw weights. Not runnable as-is, but this is exactly the input the
  // pipeline splitter takes, so it is a "not yet" rather than a "no".
  const hasSafetensors = files.some((f) => f.endsWith('.safetensors'))
  if (hasSafetensors) {
    const arch = String((info.tags ?? []).find((t) => SHARDABLE_ARCHITECTURES.test(t)) ?? '')
    const spec = await specFor(repo, 'fp16', info)
    if (arch || (spec && SHARDABLE_ARCHITECTURES.test(spec.id))) {
      return {
        repo,
        verdict: 'shardable',
        reason: 'PyTorch weights in a supported architecture. No browser runtime can load these directly.',
        hint: 'These can be split into per-layer ONNX shards offline and then run across your devices. Nothing in the browser can do that conversion itself.',
        label,
        spec,
        downloadBytes: info.safetensors?.total ? info.safetensors.total * 2 : null,
        variants: [],
        info,
        loadable: null,
      }
    }
    return refusal(
      repo,
      'PyTorch weights in an architecture we have no browser runtime for.',
      'Look for an ONNX conversion — searching for the same model with "-ONNX" often finds one.',
      info,
    )
  }

  if (files.some((f) => f.toLowerCase().endsWith('.gguf'))) {
    return refusal(
      repo,
      'This repo is GGUF, which is llama.cpp\'s format.',
      'Nothing in the browser reads GGUF today. An ONNX or MLC build of the same model will work.',
      info,
    )
  }

  return refusal(repo, 'No weights here that any browser runtime can read.', undefined, info)
}

/* ── helpers ──────────────────────────────────────────────────────────── */

function refusal(repo: string, reason: string, hint?: string, info: HfModelInfo | null = null): Resolution {
  return {
    repo,
    verdict: 'unsupported',
    reason,
    hint,
    label: repo.split('/').pop() ?? repo,
    spec: null,
    downloadBytes: null,
    loadable: null,
    variants: [],
    info,
  }
}

function quantFromMlcId(id: string): Quant {
  if (id.includes('q4f16')) return 'q4f16_1'
  if (id.includes('q4f32')) return 'q4f32_1'
  if (id.includes('q0f16')) return 'fp16'
  if (id.includes('q0f32')) return 'fp32'
  return 'q4f16_1'
}

async function specFor(repo: string, quant: Quant, info: HfModelInfo): Promise<ModelSpec | null> {
  const cfg = await fetchConfig(repo)
  if (!cfg) return null
  // The safetensors index is an exact count; our structural estimate is not.
  const params = info.safetensors?.total
  return specFromHfConfig(repo, cfg, quant, { params })
}
