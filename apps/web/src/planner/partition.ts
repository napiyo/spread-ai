import type { Capability } from '@/capability/identify'
import { byteBudget, kvBytesPerToken, type ModelSpec } from './modelSpec'
import { DEFAULT_DECODE_EFF, DISPATCH_MS_PER_LAYER } from './roofline'

/**
 * Assigns contiguous layer ranges to devices for pipeline-parallel inference.
 *
 * The counter-intuitive part, and the thing the UI must not hide: at batch size
 * one the stages run *sequentially*. Per-token time is the SUM of the stage
 * times plus a network hop between each, not the max. So splitting a model that
 * already fits on your fastest device always makes it slower.
 *
 * That makes the optimal assignment simple: fill the fastest device first, then
 * spill. Pipelining is a way to run a model you otherwise could not run at all.
 */

export interface Stage {
  deviceId: string
  label: string
  /** Inclusive start, exclusive end. */
  layerStart: number
  layerEnd: number
  hasEmbedding: boolean
  hasLmHead: boolean
  weightBytes: number
  kvBytes: number
  /** Time this stage contributes to each token, ms. */
  msPerToken: number
}

export interface Partition {
  feasible: boolean
  stages: Stage[]
  /** Layers nobody could take. */
  unplacedLayers: number
  /** Sum of stage times plus hops — the real per-token cost. */
  msPerToken: number
  tokensPerSec: number
  /** Cost paid purely for being spread out. */
  networkOverheadMs: number
  notes: string[]
}

export interface PartitionOptions {
  ctx: number
  /** One-way hop over the data channel, ms. Measured from the mesh when live. */
  hopMs?: number
  /**
   * Must be the same constant `roofline.estimate` would use for these devices,
   * including any calibration. If the two disagree, a split plan can be
   * reported as faster than running on one device — which is never true.
   */
  decodeEff?: number
}

const DEFAULT_HOP_MS = 2.5

export function partition(
  model: ModelSpec,
  fleet: Capability[],
  opts: PartitionOptions,
): Partition {
  const b = byteBudget(model)
  const hopMs = opts.hopMs ?? DEFAULT_HOP_MS
  const eff = opts.decodeEff ?? DEFAULT_DECODE_EFF
  const kvPerLayerPerToken = kvBytesPerToken(model) / Math.max(1, model.nLayers)
  const kvPerLayer = kvPerLayerPerToken * opts.ctx
  const notes: string[] = []

  const usable = fleet.filter((c) => c.hasWebGpu)
  if (usable.length < fleet.length) {
    notes.push(`${fleet.length - usable.length} device(s) skipped: no WebGPU.`)
  }

  // Fastest first, because every layer is cheaper there.
  const ordered = [...usable].sort((a, b2) => b2.bandwidthGBs - a.bandwidthGBs)

  const stages: Stage[] = []
  let layer = 0

  for (let i = 0; i < ordered.length && layer < model.nLayers; i++) {
    const cap = ordered[i]
    const isFirst = stages.length === 0
    // The output projection has to live with the final layer, so we only know
    // it is this device's problem after the loop. Reserve for it optimistically
    // on the last device we might use.
    const isPotentialLast = i === ordered.length - 1

    let budget = cap.weightBudgetBytes
    if (isFirst) budget -= b.embeddingBytes
    if (isPotentialLast) budget -= b.lmHeadBytes

    const perLayer = b.bytesPerLayer + kvPerLayer
    let take = Math.floor(budget / Math.max(1, perLayer))

    // A device whose per-buffer cap can't hold one layer is useless here, and
    // saying so is more helpful than silently giving it zero layers.
    if (b.bytesPerLayer > cap.maxBufferBytes) {
      notes.push(`${cap.label} can't hold even one layer within its ${mb(cap.maxBufferBytes)} buffer limit.`)
      take = 0
    }

    take = Math.max(0, Math.min(take, model.nLayers - layer))
    if (take === 0) continue

    stages.push({
      deviceId: cap.deviceId,
      label: cap.label,
      layerStart: layer,
      layerEnd: layer + take,
      hasEmbedding: isFirst,
      hasLmHead: false,
      weightBytes: take * b.bytesPerLayer + (isFirst ? b.embeddingBytes : 0),
      kvBytes: take * kvPerLayer,
      msPerToken: 0,
    })
    layer += take
  }

  const unplacedLayers = model.nLayers - layer

  // The output projection rides with the final stage, and is read in full on
  // every token, so it is a real cost — not bookkeeping.
  if (stages.length) {
    const last = stages[stages.length - 1]
    last.hasLmHead = true
    last.weightBytes += b.lmHeadBytes
  }

  for (const s of stages) {
    const cap = ordered.find((c) => c.deviceId === s.deviceId)!
    // Embedding is a gather of one row per token, not a streamed matrix.
    const streamed = s.weightBytes - (s.hasEmbedding ? b.embeddingBytes : 0) + s.kvBytes
    // Same two terms as roofline.estimate: bandwidth, plus the fixed per-layer
    // dispatch cost, charged to whichever device holds those layers.
    s.msPerToken =
      (streamed / (cap.bandwidthGBs * 1e9 * eff)) * 1000 +
      DISPATCH_MS_PER_LAYER * (s.layerEnd - s.layerStart)
  }

  // Hops: forward through each boundary, then the logits return to whoever is
  // driving. A single-device plan pays nothing.
  const hops = stages.length > 1 ? stages.length : 0
  const networkOverheadMs = hops * hopMs
  const msPerToken = stages.reduce((a, s) => a + s.msPerToken, 0) + networkOverheadMs

  if (stages.length > 1) {
    notes.push(
      `Split across ${stages.length} devices. Stages run one after another, so this is slower per token than one device that could hold the whole model — it is what makes the model runnable at all.`,
    )
  }
  if (unplacedLayers > 0) {
    notes.push(`${unplacedLayers} of ${model.nLayers} layers have nowhere to go. Add a device or pick a smaller model.`)
  }

  return {
    feasible: unplacedLayers === 0 && stages.length > 0,
    stages,
    unplacedLayers,
    msPerToken,
    tokensPerSec: msPerToken > 0 ? 1000 / msPerToken : 0,
    networkOverheadMs,
    notes,
  }
}

function mb(n: number) {
  return `${Math.round(n / 1024 ** 2)} MB`
}
