import { describe, expect, it } from 'vitest'
import { byteBudget, kvBytesPerToken, specFromHfConfig, type ModelSpec } from './modelSpec'
import {
  calibrate, DEFAULT_PREFILL_EFF, DISPATCH_MS_PER_LAYER, estimate, fitsOnDevice,
} from './roofline'
import { partition } from './partition'
import { capabilityFromSpec, identify } from '@/capability/identify'
import { DEVICE_BY_ID } from '@/capability/deviceDb'

/** Real Qwen3-8B config values, 4-bit MLC quantisation. */
const QWEN3_8B: ModelSpec = {
  id: 'Qwen/Qwen3-8B', label: 'Qwen3 8B', params: 8.19e9,
  nLayers: 36, hiddenSize: 4096, nHeads: 32, nKvHeads: 8, headDim: 128,
  intermediateSize: 12288, vocabSize: 151936, maxContext: 40960,
  quant: 'q4f16_1', tiedEmbeddings: false,
}

/** Real Qwen3-0.6B config values — the model we shard first. */
const QWEN3_06B: ModelSpec = {
  id: 'Qwen/Qwen3-0.6B', label: 'Qwen3 0.6B', params: 0.6e9,
  nLayers: 28, hiddenSize: 1024, nHeads: 16, nKvHeads: 8, headDim: 128,
  intermediateSize: 3072, vocabSize: 151936, maxContext: 40960,
  quant: 'q4f16_1', tiedEmbeddings: true,
}

const m4pro = capabilityFromSpec(DEVICE_BY_ID.get('m4-pro')!)
const iphone17pro = capabilityFromSpec(DEVICE_BY_ID.get('iphone-17-pro')!)

describe('byteBudget', () => {
  it('accounts for every byte of the model', () => {
    const b = byteBudget(QWEN3_8B)
    // 8.19e9 params at 0.5625 B/param
    expect(b.totalWeightBytes / 1024 ** 3).toBeCloseTo(4.29, 1)
    // Untied: embedding and lm_head are separate matrices of the same shape.
    expect(b.lmHeadBytes).toBe(b.embeddingBytes)
    expect(b.bodyBytes).toBeCloseTo(b.totalWeightBytes - 2 * b.embeddingBytes, 0)
    // The output projection is the largest single tensor, by a wide margin.
    expect(b.largestTensorBytes).toBe(b.lmHeadBytes)
  })

  it('reads less per token than it stores, because embeddings are gathered', () => {
    const b = byteBudget(QWEN3_8B)
    expect(b.activeWeightBytes).toBeLessThan(b.totalWeightBytes)
    expect(b.activeWeightBytes).toBeCloseTo(b.bodyBytes + b.lmHeadBytes, 0)
  })

  it('counts only routed experts as active for MoE', () => {
    const moe: ModelSpec = { ...QWEN3_8B, moe: { experts: 8, active: 2 } }
    expect(byteBudget(moe).activeWeightBytes).toBeLessThan(byteBudget(QWEN3_8B).activeWeightBytes)
  })
})

describe('kvBytesPerToken', () => {
  it('uses KV heads, not attention heads', () => {
    // 2 (K+V) * 36 layers * 8 kv heads * 128 head dim * 2 bytes
    expect(kvBytesPerToken(QWEN3_8B)).toBe(147456)
    // Grouped-query attention is the whole reason this is affordable.
    const mqa = { ...QWEN3_8B, nKvHeads: 32 }
    expect(kvBytesPerToken(mqa)).toBe(4 * kvBytesPerToken(QWEN3_8B))
  })
})

describe('estimate', () => {
  it('lands in the real observed range for 8B 4-bit on an M4 Pro', () => {
    const e = estimate({ model: QWEN3_8B, cap: m4pro, ctx: 2048, promptTokens: 512, outputTokens: 256 })
    // Published WebLLM figures for this class of machine sit around 20-40 tok/s.
    expect(e.tokensPerSec).toBeGreaterThan(15)
    expect(e.tokensPerSec).toBeLessThan(50)
    expect(e.ttftMs).toBeGreaterThan(0)
    expect(e.calibrated).toBe(false)
  })

  it('gets slower as context grows, because the KV cache is re-read', () => {
    const short = estimate({ model: QWEN3_8B, cap: m4pro, ctx: 512, promptTokens: 64, outputTokens: 64 })
    const long = estimate({ model: QWEN3_8B, cap: m4pro, ctx: 32768, promptTokens: 64, outputTokens: 64 })
    expect(long.tokensPerSec).toBeLessThan(short.tokensPerSec)
  })

  it('scales with bandwidth, but sub-linearly because of the dispatch floor', () => {
    const fast = { ...m4pro, bandwidthGBs: m4pro.bandwidthGBs * 2 }
    const a = estimate({ model: QWEN3_8B, cap: m4pro, ctx: 1024, promptTokens: 1, outputTokens: 1 })
    const b = estimate({ model: QWEN3_8B, cap: fast, ctx: 1024, promptTokens: 1, outputTokens: 1 })
    const ratio = b.tokensPerSec / a.tokensPerSec
    // Twice the bandwidth buys most of, but never all of, twice the speed:
    // the per-layer dispatch cost is unchanged.
    expect(ratio).toBeGreaterThan(1.5)
    expect(ratio).toBeLessThan(2)
  })

  it('is latency-bound, not bandwidth-bound, for tiny models', () => {
    // 28 layers x 0.12 ms is ~3.4 ms of pure overhead per token, which caps a
    // 0.6B model near 200 tok/s no matter how fast the memory is.
    const absurd = { ...m4pro, bandwidthGBs: 100_000 }
    const e = estimate({ model: QWEN3_06B, cap: absurd, ctx: 1024, promptTokens: 8, outputTokens: 64 })
    expect(e.tokensPerSec).toBeLessThan(1000 / (DISPATCH_MS_PER_LAYER * QWEN3_06B.nLayers) + 1)
  })

  it('reproduces published in-browser speeds for small models', () => {
    // WebLLM on Apple Silicon runs 4-bit models in these ranges. If a change to
    // the model pushes these out of band, the model is wrong, not the range.
    const small = estimate({ model: QWEN3_06B, cap: m4pro, ctx: 1024, promptTokens: 128, outputTokens: 128 })
    expect(small.tokensPerSec).toBeGreaterThan(60)
    expect(small.tokensPerSec).toBeLessThan(200)

    const big = estimate({ model: QWEN3_8B, cap: m4pro, ctx: 2048, promptTokens: 512, outputTokens: 256 })
    expect(big.tokensPerSec).toBeGreaterThan(10)
    expect(big.tokensPerSec).toBeLessThan(35)
  })
})

describe('calibrate', () => {
  it('recovers the efficiency constant that produced an observation', () => {
    const cal = calibrate(QWEN3_8B, m4pro, {
      tokensPerSec: 30, ttftMs: 400, promptTokens: 512, ctx: 2048,
    })!
    const calibrated = { ...m4pro, calibration: cal }
    const e = estimate({ model: QWEN3_8B, cap: calibrated, ctx: 2048, promptTokens: 512, outputTokens: 0 })
    expect(e.tokensPerSec).toBeCloseTo(30, 0)
    expect(e.ttftMs).toBeCloseTo(400, -1)
    expect(e.calibrated).toBe(true)
  })

  it('discards an absurd reading rather than clamping it into range', () => {
    // No prior calibration and nothing believable in the sample, so the honest
    // answer is to stay uncalibrated and keep using the default constants.
    const cal = calibrate(QWEN3_8B, m4pro, {
      tokensPerSec: 100000, ttftMs: 0.001, promptTokens: 512, ctx: 2048,
    })
    expect(cal).toBeNull()
    expect(estimate({ model: QWEN3_8B, cap: m4pro, ctx: 2048, promptTokens: 512, outputTokens: 64 }).calibrated).toBe(false)
  })
})

describe('fitsOnDevice', () => {
  it('lets an 8B 4-bit model onto an M4 Pro', () => {
    expect(fitsOnDevice(QWEN3_8B, m4pro, 4096).fits).toBe(true)
  })

  it('keeps an 8B model off an iPhone, and says why', () => {
    const fit = fitsOnDevice(QWEN3_8B, iphone17pro, 4096)
    expect(fit.fits).toBe(false)
    expect(fit.blockers.join(' ')).toMatch(/available to a browser tab|buffer limit/)
  })

  it('flags the WebGPU buffer cap rather than only total memory', () => {
    // Plenty of memory, tiny per-allocation cap: the iOS Safari shape exactly.
    const oddball = { ...m4pro, maxBufferBytes: 64 * 1024 ** 2 }
    const fit = fitsOnDevice(QWEN3_8B, oddball, 2048)
    expect([...fit.blockers, ...fit.warnings].join(' ')).toMatch(/buffer limit/)
  })
})

describe('partition', () => {
  it('keeps a model on one device when it already fits there', () => {
    const p = partition(QWEN3_8B, [m4pro, iphone17pro], { ctx: 2048 })
    expect(p.feasible).toBe(true)
    expect(p.stages).toHaveLength(1)
    expect(p.networkOverheadMs).toBe(0)
  })

  it('covers all layers exactly once when it does split', () => {
    const p = partition(QWEN3_06B, [iphone17pro, iphone17pro], { ctx: 1024 })
    if (p.stages.length) {
      expect(p.stages[0].layerStart).toBe(0)
      for (let i = 1; i < p.stages.length; i++) {
        expect(p.stages[i].layerStart).toBe(p.stages[i - 1].layerEnd)
      }
      expect(p.stages.at(-1)!.layerEnd + p.unplacedLayers).toBe(QWEN3_06B.nLayers)
    }
  })

  it('places the embedding first and the output projection last', () => {
    const p = partition(QWEN3_8B, [m4pro], { ctx: 2048 })
    expect(p.stages[0].hasEmbedding).toBe(true)
    expect(p.stages.at(-1)!.hasLmHead).toBe(true)
  })

  it('is slower spread out than concentrated — the honest result', () => {
    // 3 GB each: enough for two of them to hold a 4.3 GB model, not one.
    const half = { ...m4pro, weightBudgetBytes: 3 * 1024 ** 3, deviceId: 'a' }
    const other = { ...m4pro, weightBudgetBytes: 3 * 1024 ** 3, deviceId: 'b' }
    const split = partition(QWEN3_8B, [half, other], { ctx: 2048 })
    const whole = partition(QWEN3_8B, [m4pro], { ctx: 2048 })
    expect(split.stages.length).toBeGreaterThan(1)
    expect(split.tokensPerSec).toBeLessThan(whole.tokensPerSec)
    expect(split.notes.join(' ')).toMatch(/slower per token/)
  })

  it('reports layers it could not place instead of pretending', () => {
    const tiny = { ...iphone17pro, weightBudgetBytes: 200 * 1024 ** 2 }
    const p = partition(QWEN3_8B, [tiny], { ctx: 1024 })
    expect(p.feasible).toBe(false)
    expect(p.unplacedLayers).toBeGreaterThan(0)
  })
})

describe('specFromHfConfig', () => {
  it('reads a modern grouped-query config', () => {
    const s = specFromHfConfig('Qwen/Qwen3-8B', {
      hidden_size: 4096, num_hidden_layers: 36, num_attention_heads: 32,
      num_key_value_heads: 8, head_dim: 128, intermediate_size: 12288,
      vocab_size: 151936, max_position_embeddings: 40960, tie_word_embeddings: false,
    }, 'q4f16_1')
    expect(s.nKvHeads).toBe(8)
    expect(s.tiedEmbeddings).toBe(false)
    // Structural parameter count should land near the published 8.19B.
    expect(s.params / 1e9).toBeGreaterThan(7)
    expect(s.params / 1e9).toBeLessThan(9.5)
  })

  it('falls back when fields are named differently or missing', () => {
    const s = specFromHfConfig('gpt2', { n_embd: 768, n_layer: 12, n_head: 12, vocab_size: 50257 }, 'fp16')
    expect(s.hiddenSize).toBe(768)
    expect(s.nLayers).toBe(12)
    expect(s.nKvHeads).toBe(12) // no GQA field: falls back to full attention
  })
})

describe('identify', () => {
  /** The reading this project's own MacBook actually produces. */
  const measured = {
    bandwidthGBs: 253.8, gflopsF32: 2016, gflopsF16: 2478,
    allocatedBytes: 268435456, elapsedMs: 723, matmulSize: 1024, warnings: [],
  }
  const macProbe = {
    id: 'x', createdAt: 0,
    webgpu: {
      vendor: 'apple', architecture: 'metal-3', device: '', description: '',
      maxBufferSize: 4294967292, maxStorageBufferBindingSize: 4294967292,
      maxComputeWorkgroupStorageSize: 32768, maxComputeInvocationsPerWorkgroup: 1024,
      hasF16: true, features: ['shader-f16'], isFallbackAdapter: false,
    },
    webgpuUnavailableReason: null,
    platform: {
      deviceMemoryGb: 16, cores: 12, os: 'macOS', osVersion: '26.2.0',
      browser: 'Chromium', browserVersion: '148', model: null, arch: 'arm',
      mobile: false, appleFamily: 'mac' as const, screen: { w: 1512, h: 982, dpr: 2 },
    },
    storage: { quotaBytes: 4.68e9, usageBytes: 0, persisted: false, hasOpfs: true, hasCacheApi: true },
    network: { online: true, effectiveType: '4g', downlinkMbps: 0.05, rttMs: 250, saveData: false },
  }

  it('names the machine this was built on from its measurements alone', () => {
    const m = identify(macProbe, measured)
    expect(m?.spec.id).toBe('m4-pro')
    expect(m!.confidence).toBeGreaterThan(0.6)
  })

  it('never picks a device whose nominal bandwidth is below what we measured', () => {
    // 253 GB/s is above an M1 Pro's 200 GB/s ceiling, so it cannot be one.
    const m = identify(macProbe, measured)
    expect(DEVICE_BY_ID.get(m!.spec.id)!.bandwidthGBs).toBeGreaterThanOrEqual(measured.bandwidthGBs)
  })

  it('does not claim to recognise a Mac from platform hints alone', () => {
    const m = identify(macProbe, null)
    // Without a benchmark every Apple laptop looks alike, so confidence must
    // stay low enough that the UI hedges rather than asserts.
    expect(m === null || m.confidence < 0.75).toBe(true)
  })
})

describe('calibrate — rejecting bad samples', () => {
  /** Shape of a real measured turn: a normal reply at a normal context. */
  const warm = { tokensPerSec: 95, ttftMs: 60, promptTokens: 12, ctx: 220 }

  it('ignores a prefill reading from a prompt too short to measure', () => {
    // 12 prompt tokens is dominated by fixed overhead, not by compute, so the
    // decode constant updates and the prefill constant is left alone.
    const cal = calibrate(QWEN3_06B, m4pro, warm)!
    expect(cal.prefillEff).toBe(DEFAULT_PREFILL_EFF)
    expect(cal.decodeEff).not.toBe(DEFAULT_PREFILL_EFF)
    expect(cal.samples).toBe(1)
  })

  it('rejects a sample faster than the dispatch floor allows', () => {
    // 151 tok/s is 6.6 ms per token, under this model's 28 x 0.22 ms of pure
    // per-layer overhead. Something measured it wrong; believing it would imply
    // an efficiency above 1 and corrupt every later estimate.
    expect(calibrate(QWEN3_06B, m4pro, { ...warm, tokensPerSec: 151, ctx: 40 })).toBeNull()
  })

  it('keeps the previous constant rather than clamping an absurd reading in', () => {
    const good = { ...m4pro, calibration: { decodeEff: 0.3, prefillEff: 2, samples: 3 } }
    // A throttled or backgrounded tab reporting a fraction of a token per second.
    const cal = calibrate(QWEN3_06B, good, { tokensPerSec: 0.02, ttftMs: 90_000, promptTokens: 512, ctx: 40 })!
    expect(cal.decodeEff).toBe(0.3)
    expect(cal.samples).toBe(3)
  })

  it('discards an absurd reading rather than clamping it into range', () => {
    // No prior calibration and nothing believable in the sample, so the honest
    // answer is to stay uncalibrated and keep using the default constants.
    expect(
      calibrate(QWEN3_8B, m4pro, { tokensPerSec: 100000, ttftMs: 0.001, promptTokens: 512, ctx: 2048 }),
    ).toBeNull()
    expect(
      estimate({ model: QWEN3_8B, cap: m4pro, ctx: 2048, promptTokens: 512, outputTokens: 64 }).calibrated,
    ).toBe(false)
  })

  it('accepts a prefill reading once the prompt is long enough', () => {
    const cal = calibrate(QWEN3_8B, m4pro, {
      tokensPerSec: 20, ttftMs: 600, promptTokens: 512, ctx: 1024,
    })!
    expect(cal.prefillEff).not.toBe(DEFAULT_PREFILL_EFF)
    expect(cal.prefillEff).toBeGreaterThan(0.2)
  })

  it('converges on what was actually observed', () => {
    let cap = { ...m4pro }
    for (const tokensPerSec of [92, 98, 95]) {
      cap = { ...cap, calibration: calibrate(QWEN3_06B, cap, { ...warm, tokensPerSec }) }
    }
    expect(cap.calibration!.samples).toBe(3)
    const e = estimate({ model: QWEN3_06B, cap, ctx: 220, promptTokens: 12, outputTokens: 0 })
    expect(e.calibrated).toBe(true)
    expect(e.tokensPerSec).toBeGreaterThan(88)
    expect(e.tokensPerSec).toBeLessThan(102)
  })
})

describe('partition and estimate agree', () => {
  /**
   * The invariant that keeps the advisor honest. If a one-stage partition
   * predicted a different speed from `estimate`, a "spread across devices" plan
   * could be reported as faster than the single device it actually runs on —
   * which is exactly the false claim this project exists to avoid making.
   */
  it('gives the same speed for a single device by either route', () => {
    const p = partition(QWEN3_8B, [m4pro], { ctx: 2048 })
    const e = estimate({ model: QWEN3_8B, cap: m4pro, ctx: 2048, promptTokens: 1, outputTokens: 0 })
    expect(p.stages).toHaveLength(1)
    expect(p.tokensPerSec).toBeCloseTo(e.tokensPerSec, 0)
  })

  it('charges the dispatch floor once per layer however the layers are split', () => {
    const half = { ...m4pro, weightBudgetBytes: 3 * 1024 ** 3, deviceId: 'a' }
    const other = { ...m4pro, weightBudgetBytes: 3 * 1024 ** 3, deviceId: 'b' }
    const split = partition(QWEN3_8B, [half, other], { ctx: 2048 })
    const placed = split.stages.reduce((n, s) => n + (s.layerEnd - s.layerStart), 0)
    expect(placed).toBe(QWEN3_8B.nLayers)
    // Sum of stage times must exceed the whole-model dispatch floor.
    const floor = DISPATCH_MS_PER_LAYER * QWEN3_8B.nLayers
    expect(split.stages.reduce((a, s) => a + s.msPerToken, 0)).toBeGreaterThan(floor)
  })
})

describe('storage quota as a distinct constraint', () => {
  it('blocks on the storage quota with its own explanation, not a memory one', () => {
    // Plenty of RAM, small disk allowance — the shape of a laptop that is
    // nearly full. Reporting this as "not enough memory" would send the user
    // off closing tabs, which would not help at all.
    const cramped = { ...m4pro, storageBudgetBytes: 2 * 1024 ** 3 }
    const fit = fitsOnDevice(QWEN3_8B, cramped, 2048)
    expect(fit.fits).toBe(false)
    expect(fit.blockers.join(' ')).toMatch(/storage quota/i)
    expect(fit.blockers.join(' ')).not.toMatch(/of memory but only/i)
  })

  it('does not invent a storage limit for devices we are only projecting', () => {
    const projected = capabilityFromSpec(DEVICE_BY_ID.get('m4-max')!)
    expect(projected.storageBudgetBytes).toBe(Infinity)
    expect(fitsOnDevice(QWEN3_8B, projected, 2048).fits).toBe(true)
  })
})
