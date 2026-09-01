import { capabilityFromSpec, type Capability } from '@/capability/identify'
import { DEVICE_DB, type DeviceSpec } from '@/capability/deviceDb'
import { byteBudget, type ModelSpec } from './modelSpec'
import { estimate, fitsOnDevice } from './roofline'
import { partition, type Partition } from './partition'

/**
 * Turns a model plus a set of devices into concrete, honest advice.
 *
 * The two questions people actually ask are different and must not be blurred:
 *
 *   "What can my devices run?"  — a capacity question. More devices genuinely
 *   help, because layers can be spread until the model fits.
 *
 *   "How do I get X tokens per second?" — a speed question. Here more devices
 *   mostly do NOT help. Pipeline stages run in sequence at batch size one, so
 *   splitting a model that already fits makes it slower. The honest answers are
 *   a faster single device, a smaller model, or speculative decoding.
 *
 * Every option below therefore carries its own `why`, and options that add
 * devices without adding speed say so in plain words.
 */

export type OptionKind = 'single' | 'pipeline' | 'speculative'

export interface FleetOption {
  id: string
  kind: OptionKind
  /** What to actually go and do. */
  headline: string
  why: string
  caveats: string[]
  devices: { spec: DeviceSpec; count: number; owned: boolean }[]
  tokensPerSec: number
  ttftMs: number
  feasible: boolean
  /** True when every device in the option is one you already have. */
  usesOnlyOwned: boolean
  partition?: Partition
}

export interface RecommendOptions {
  ctx: number
  promptTokens?: number
  outputTokens?: number
  hopMs?: number
  /** Draft model for speculative decoding, when one is available. */
  draft?: ModelSpec
}

/* ── Speculative decoding ─────────────────────────────────────────────── */

/** Share of draft tokens the target model accepts. Conservative on purpose. */
export const DEFAULT_ACCEPT_RATE = 0.75

/**
 * Expected speed-up from speculative decoding.
 *
 * The draft model proposes `k` tokens; the target verifies all of them in a
 * single forward pass and keeps the longest prefix it agrees with. The win is
 * real and is the one trick here that genuinely makes a *single* response
 * faster using two devices.
 */
export function speculativeTokensPerSec(
  targetTokPerSec: number,
  draftTokPerSec: number,
  opts: { k?: number; acceptRate?: number; hopMs?: number } = {},
): number {
  const k = opts.k ?? 4
  const a = opts.acceptRate ?? DEFAULT_ACCEPT_RATE
  const hopMs = opts.hopMs ?? 0

  const targetMs = 1000 / Math.max(0.01, targetTokPerSec)
  const draftMs = 1000 / Math.max(0.01, draftTokPerSec)

  // Expected accepted tokens per cycle for a geometric acceptance process,
  // plus the one token the target always contributes itself.
  const expected = (1 - a ** (k + 1)) / (1 - a)

  // One round trip per cycle when the draft lives on another device — not per
  // token, which is what makes this viable over a network at all.
  const cycleMs = k * draftMs + targetMs + 2 * hopMs
  return (expected / cycleMs) * 1000
}

/* ── Options for one model ────────────────────────────────────────────── */

function label(count: number, spec: DeviceSpec) {
  return `${count}× ${spec.label}`
}

/** The calibrated efficiency, when every device in the fleet agrees on one. */
function fleetCalibration(fleet: Capability[]): number | undefined {
  const values = fleet.map((c) => c.calibration?.decodeEff).filter((v): v is number => v != null)
  if (values.length !== fleet.length || !values.length) return undefined
  return values.reduce((a, b) => a + b, 0) / values.length
}

function optionForFleet(
  id: string,
  model: ModelSpec,
  fleet: Capability[],
  devices: FleetOption['devices'],
  o: RecommendOptions,
): FleetOption | null {
  if (!fleet.length) return null

  const promptTokens = o.promptTokens ?? 256
  const outputTokens = o.outputTokens ?? 256
  const usesOnlyOwned = devices.every((d) => d.owned)
  const headline = devices.map((d) => label(d.count, d.spec)).join(' + ')

  // One device that can hold the whole thing is always the fastest arrangement.
  if (fleet.length === 1) {
    const cap = fleet[0]
    const fit = fitsOnDevice(model, cap, o.ctx)
    const est = estimate({ model, cap, ctx: o.ctx, promptTokens, outputTokens })
    return {
      id,
      kind: 'single',
      headline,
      why: fit.fits
        ? 'Runs entirely on one device, which is always the fastest way to run it.'
        : fit.blockers[0],
      caveats: fit.warnings,
      devices,
      tokensPerSec: fit.fits ? est.tokensPerSec : 0,
      ttftMs: est.ttftMs,
      feasible: fit.fits,
      usesOnlyOwned,
    }
  }

  // Use the same efficiency the single-device estimate would, so the two are
  // directly comparable and a split can never look faster than it is.
  const decodeEff = fleetCalibration(fleet)
  const p = partition(model, fleet, { ctx: o.ctx, hopMs: o.hopMs, decodeEff })
  const fastest = [...fleet].sort((a, b) => b.bandwidthGBs - a.bandwidthGBs)[0]
  const est = estimate({ model, cap: fastest, ctx: o.ctx, promptTokens, outputTokens })

  // The partition collapsed onto one device: the others contribute nothing.
  // Reporting this as a multi-device plan would imply the extra hardware is
  // doing work, and would quietly attach a second device's name to a number it
  // had no part in producing.
  if (p.stages.length <= 1) {
    const spare = fleet.length - 1
    return {
      id,
      kind: 'single',
      headline: fastest.label,
      why: p.feasible
        ? `${fastest.label} holds the whole model by itself, which is the fastest way to run it. Your other ${spare === 1 ? 'device is' : `${spare} devices are`} not needed here and would only add hops.`
        : (fitsOnDevice(model, fastest, o.ctx).blockers[0] ?? 'No device here can hold this model.'),
      caveats: p.notes,
      devices,
      tokensPerSec: p.feasible ? est.tokensPerSec : 0,
      ttftMs: est.ttftMs,
      feasible: p.feasible,
      usesOnlyOwned,
      partition: p,
    }
  }

  const caveats = [...p.notes]
  if (fitsOnDevice(model, fastest, o.ctx).fits) {
    caveats.unshift(
      `${fastest.label} can already hold this model on its own, and doing so is faster. Splitting it only makes sense if you need that device free.`,
    )
  }

  return {
    id,
    kind: 'pipeline',
    headline,
    why: p.feasible
      ? `Layers are spread across ${p.stages.length} devices so the model fits at all. Each token walks the whole chain, so this buys capacity rather than speed.`
      : `Even together these can't hold the model — ${p.unplacedLayers} of ${model.nLayers} layers have nowhere to go.`,
    caveats,
    devices,
    tokensPerSec: p.tokensPerSec,
    ttftMs: est.ttftMs,
    feasible: p.feasible,
    usesOnlyOwned,
    partition: p,
  }
}

/**
 * Every sensible way to run `model`, ranked. Owned devices first, then
 * combinations that add at most a couple of pieces of hardware.
 */
export function optionsForModel(
  model: ModelSpec,
  owned: Capability[],
  o: RecommendOptions,
): FleetOption[] {
  const options: FleetOption[] = []
  const ownedUsable = owned.filter((c) => c.hasWebGpu)

  const ownedDevices = (caps: Capability[]): FleetOption['devices'] =>
    caps.map((c) => ({
      spec: c.match?.spec ?? DEVICE_DB[0],
      count: 1,
      owned: true,
    }))

  /* 1. Each device you already have, on its own. */
  for (const cap of ownedUsable) {
    const opt = optionForFleet(`owned:${cap.deviceId}`, model, [cap], ownedDevices([cap]), o)
    if (opt) {
      opt.headline = cap.label
      options.push(opt)
    }
  }

  /* 2. Everything you have, pooled. Only interesting when nothing alone fits. */
  if (ownedUsable.length > 1) {
    const opt = optionForFleet('owned:all', model, ownedUsable, ownedDevices(ownedUsable), o)
    if (opt) {
      opt.headline = `Your ${ownedUsable.length} devices together`
      options.push(opt)
    }
  }

  /* 3. Buy or borrow one kind of device. Capped at three of a kind: past that
        the network cost dominates and the advice stops being useful. */
  for (const spec of DEVICE_DB) {
    for (const count of [1, 2, 3]) {
      const caps = Array.from({ length: count }, (_, i) => capabilityFromSpec(spec, i))
      const opt = optionForFleet(
        `spec:${spec.id}:${count}`,
        model,
        caps,
        [{ spec, count, owned: false }],
        o,
      )
      if (opt?.feasible) {
        options.push(opt)
        break // the smallest count that works is the honest recommendation
      }
    }
  }

  /* 4. Speculative decoding: the one arrangement where a second device really
        does make a single reply arrive faster. */
  if (o.draft && ownedUsable.length) {
    const target = [...ownedUsable].sort((a, b) => b.bandwidthGBs - a.bandwidthGBs)[0]
    if (fitsOnDevice(model, target, o.ctx).fits) {
      const targetTps = estimate({
        model, cap: target, ctx: o.ctx,
        promptTokens: o.promptTokens ?? 256, outputTokens: o.outputTokens ?? 256,
      }).tokensPerSec

      // A phone is the natural home for the draft model; it barely has to fit.
      const phone = DEVICE_DB.find((d) => d.id === 'iphone-17-pro')!
      const draftCap = ownedUsable[1] ?? capabilityFromSpec(phone)
      const draftTps = estimate({
        model: o.draft, cap: draftCap, ctx: o.ctx, promptTokens: 8, outputTokens: 64,
      }).tokensPerSec

      const spec = speculativeTokensPerSec(targetTps, draftTps, { hopMs: o.hopMs ?? 2.5 })
      if (spec > targetTps * 1.05) {
        options.push({
          id: 'speculative',
          kind: 'speculative',
          headline: `${target.label} + ${draftCap.label}, speculating`,
          why: `${o.draft.label} drafts a few tokens ahead on the second device and ${model.label} checks them in one pass. Unlike splitting layers, this genuinely makes a single reply arrive sooner.`,
          caveats: [
            `Assumes ${Math.round(DEFAULT_ACCEPT_RATE * 100)}% of drafted tokens are accepted. A draft model that disagrees more often gives back most of the gain.`,
            'Both models must be resident at once, so the memory cost is the sum of the two.',
          ],
          devices: [
            { spec: target.match?.spec ?? DEVICE_DB[0], count: 1, owned: true },
            { spec: draftCap.match?.spec ?? phone, count: 1, owned: Boolean(ownedUsable[1]) },
          ],
          tokensPerSec: spec,
          ttftMs: estimate({
            model, cap: target, ctx: o.ctx,
            promptTokens: o.promptTokens ?? 256, outputTokens: o.outputTokens ?? 256,
          }).ttftMs,
          feasible: true,
          usesOnlyOwned: Boolean(ownedUsable[1]),
        })
      }
    }
  }

  return rank(options)
}

/**
 * Feasible before infeasible, then what you already own, then speed. Preferring
 * owned hardware matters: a recommendation to go and buy something is only
 * useful once nothing you have will do.
 */
function rank(options: FleetOption[]): FleetOption[] {
  return [...options].sort((a, b) => {
    if (a.feasible !== b.feasible) return a.feasible ? -1 : 1
    if (a.usesOnlyOwned !== b.usesOnlyOwned) return a.usesOnlyOwned ? -1 : 1
    return b.tokensPerSec - a.tokensPerSec
  })
}

/* ── The "what can I run?" direction ──────────────────────────────────── */

export interface ModelRecommendation {
  model: ModelSpec
  /** Fastest arrangement that works. */
  best: FleetOption | null
  /** Smallest change that would make it work — what to actually go and do. */
  cheapest: FleetOption | null
  /** Why the hardware you already have can't manage it. */
  ownedBlockers: string[]
  tokensPerSec: number
  fitsOnOneOwnedDevice: boolean
  requiredBytes: number
}

/**
 * Slowest speed worth recommending. Below roughly this, a reply arrives more
 * slowly than most people will read it, and suggesting the hardware to achieve
 * it is not useful advice however cheap it is.
 */
const USABLE_TOK_PER_SEC = 8

/**
 * "What is the least I would have to change?" — a different question from "what
 * is fastest", and the one worth answering when nothing you own works. Fewest
 * devices first, then the most modest device that still does the job, so the
 * answer is never a flagship GPU when a laptop would do.
 */
function byModesty(a: FleetOption, b: FleetOption): number {
  const count = (o: FleetOption) => o.devices.reduce((n, d) => n + d.count, 0)
  if (count(a) !== count(b)) return count(a) - count(b)
  const power = (o: FleetOption) => Math.max(...o.devices.map((d) => d.spec.bandwidthGBs))
  return power(a) - power(b)
}

/** The most modest option that is also worth having. */
function cheapestUsable(feasible: FleetOption[]): FleetOption | null {
  const usable = feasible.filter((o) => o.tokensPerSec >= USABLE_TOK_PER_SEC)
  return [...(usable.length ? usable : feasible)].sort(byModesty)[0] ?? null
}

export function recommendModels(
  models: ModelSpec[],
  owned: Capability[],
  o: RecommendOptions,
): ModelRecommendation[] {
  return models
    .map((model) => {
      const options = optionsForModel(model, owned, o)
      const ownedOptions = options.filter((x) => x.usesOnlyOwned && x.feasible)
      const feasible = options.filter((x) => x.feasible)
      const best = ownedOptions[0] ?? feasible[0] ?? null

      // Deduplicated so the same blocker from three devices reads once.
      const ownedBlockers = [
        ...new Set(
          options
            .filter((x) => x.usesOnlyOwned && !x.feasible)
            .map((x) => x.why)
            .filter(Boolean),
        ),
      ]

      return {
        model,
        best,
        cheapest: ownedOptions[0] ?? cheapestUsable(feasible),
        ownedBlockers,
        tokensPerSec: best?.tokensPerSec ?? 0,
        fitsOnOneOwnedDevice: ownedOptions.some((x) => x.kind === 'single'),
        requiredBytes: byteBudget(model).totalWeightBytes,
      }
    })
    .sort((a, b) => {
      // Biggest model that still runs well is usually what someone wants, so
      // rank by capability first and speed only as a tie-break.
      if (a.fitsOnOneOwnedDevice !== b.fitsOnOneOwnedDevice) return a.fitsOnOneOwnedDevice ? -1 : 1
      return b.requiredBytes - a.requiredBytes
    })
}

/**
 * Fleets that reach a target speed for a model.
 *
 * Ordered by *cost of the change*, not by speed. Once an option clears the bar
 * you asked for, being further above it is not a reason to prefer it — so the
 * first row is the least you would have to do, and anything you already own
 * comes before anything you would have to acquire.
 */
export function optionsMeetingTarget(
  model: ModelSpec,
  targetTokPerSec: number,
  owned: Capability[],
  o: RecommendOptions,
): { meeting: FleetOption[]; closest: FleetOption | null } {
  const all = optionsForModel(model, owned, o).filter((x) => x.feasible)
  const meeting = all
    .filter((x) => x.tokensPerSec >= targetTokPerSec)
    .sort((a, b) => {
      if (a.usesOnlyOwned !== b.usesOnlyOwned) return a.usesOnlyOwned ? -1 : 1
      return byModesty(a, b)
    })
  const closest = meeting.length
    ? null
    : ([...all].sort((a, b) => b.tokensPerSec - a.tokensPerSec)[0] ?? null)
  return { meeting, closest }
}
