import { describe, expect, it } from 'vitest'
import { capabilityFromSpec } from '@/capability/identify'
import { DEVICE_BY_ID } from '@/capability/deviceDb'
import type { Capability } from '@/capability/identify'
import type { ModelSpec } from './modelSpec'
import { planMigration } from './migrate'
import { planParallelPrefill, prefillRatio, prefillTransferBytes } from './prefill'
import {
  THERMAL_PRIORS, calibrateThermal, profileFor, secondsFor, sustainedTokPerSec,
  throttleFactor, tokensIn,
} from './thermal'

/**
 * The two arrangements that are supposed to make a *single* reply faster, and
 * the arithmetic that decides whether they do.
 *
 * These tests exist for the same reason the advisor's do: to fail if the model
 * ever starts claiming a win it cannot support.
 */

const LLAMA_8B: ModelSpec = {
  id: 'llama-3.1-8b', label: 'Llama 3.1 8B',
  params: 8.03e9, nLayers: 32, hiddenSize: 4096, nHeads: 32, nKvHeads: 8, headDim: 128,
  intermediateSize: 14336, vocabSize: 128256, maxContext: 131072,
  quant: 'q4f16_1', tiedEmbeddings: false,
}

/** Same size, but full multi-head attention: four times the KV cache. */
const MHA_8B: ModelSpec = { ...LLAMA_8B, id: 'mha-8b', label: 'MHA 8B', nKvHeads: 32 }

const device = (id: string, over: Partial<Capability> = {}): Capability => ({
  ...capabilityFromSpec(DEVICE_BY_ID.get(id)!),
  ...over,
})

const PHONE = device('sd-8-elite', { deviceId: 'phone' })
const TABLET = device('ipad-pro-m4', { deviceId: 'tablet' })
const DESKTOP = device('m3-ultra', { deviceId: 'desktop' })

describe('throttling', () => {
  it('holds peak, then falls to a floor and stays there', () => {
    const p = THERMAL_PRIORS.phone
    expect(throttleFactor(0, p)).toBe(1)
    expect(throttleFactor(p.holdS, p)).toBe(1)
    expect(throttleFactor(p.holdS + p.tauS, p)).toBeLessThan(1)
    expect(throttleFactor(3600, p)).toBeCloseTo(p.sustained, 3)
    // Monotonic: a device never speeds back up while it is still working.
    for (let t = 0; t < 600; t += 7) {
      expect(throttleFactor(t + 7, p)).toBeLessThanOrEqual(throttleFactor(t, p) + 1e-9)
    }
  })

  it('ranks a phone below a desktop only once the run is long enough', () => {
    // Same peak on both, so any difference here is thermal and nothing else.
    // This is the whole point: the ranking is a function of reply length.
    const ratio = (tokens: number) =>
      sustainedTokPerSec(tokens, 30, THERMAL_PRIORS.phone) /
      sustainedTokPerSec(tokens, 30, THERMAL_PRIORS.desktop)

    expect(ratio(20)).toBeCloseTo(1, 5)
    expect(ratio(2000)).toBeLessThan(0.9)
    expect(ratio(6000)).toBeLessThan(0.6)
    // Monotonically worse the longer you ask it to work.
    expect(ratio(6000)).toBeLessThan(ratio(2000))
  })

  it('inverts its own integral', () => {
    for (const p of Object.values(THERMAL_PRIORS)) {
      for (const tokens of [5, 100, 900, 5000]) {
        const s = secondsFor(tokens, 25, p)
        expect(tokensIn(s, 25, p)).toBeCloseTo(tokens, 3)
      }
    }
  })
})

describe('learning a device\'s thermal behaviour', () => {
  const curve = (p = THERMAL_PRIORS.phone, peak = 30, span = 240) =>
    Array.from({ length: 25 }, (_, i) => {
      const elapsedS = (i / 24) * span
      return { elapsedS, tokensPerSec: peak * throttleFactor(elapsedS, p) }
    })

  it('recovers roughly the profile it was generated from', () => {
    const fitted = calibrateThermal(curve())!
    expect(fitted.source).toBe('measured')
    expect(fitted.sustained).toBeGreaterThan(0.35)
    expect(fitted.sustained).toBeLessThan(0.65)
    expect(fitted.holdS).toBeGreaterThan(10)
    expect(fitted.holdS).toBeLessThan(60)
  })

  it('refuses to fit from a run too short to have throttled', () => {
    const previous = THERMAL_PRIORS.phone
    expect(calibrateThermal(curve(previous, 30, 8), previous)).toBe(previous)
    expect(calibrateThermal([], previous)).toBe(previous)
  })

  it('will not call a device cool just because we stopped watching early', () => {
    // A window that ends inside the hold learns a longer hold and nothing about
    // the floor — and must not be labelled a measurement of one.
    const fitted = calibrateThermal(curve(THERMAL_PRIORS.desktop, 30, 120))!
    expect(fitted.source).toBe('assumed')
    expect(fitted.sustained).toBeGreaterThan(0.9)
  })
})

describe('handing a reply over mid-sentence', () => {
  const base = { model: LLAMA_8B, ctx: 512, promptTokens: 256 }
  const to = (cap: Capability) => [{ cap, hasModelLoaded: true, linkGBs: 0.12, hopMs: 3 }]

  /**
   * A second phone of the same model, which has been sitting idle. Identical
   * peak speed, so nothing but heat can separate the two — which is the only
   * way to isolate a thermal decision from a routing one.
   */
  const TWIN = { ...PHONE, deviceId: 'twin', label: 'Second phone' }

  it('leaves a short reply where it started', () => {
    const plan = planMigration({ ...base, start: PHONE, candidates: to(TWIN), outputTokens: 40 })
    expect(plan.migrate).toBe(false)
    expect(plan.why).toMatch(/never throttles/i)
  })

  it('hands a long reply to an identical device that has not been working', () => {
    const plan = planMigration({ ...base, start: PHONE, candidates: to(TWIN), outputTokens: 3000 })
    expect(plan.migrate).toBe(true)
    expect(plan.cause).toBe('thermal')
    expect(plan.to?.deviceId).toBe('twin')
    expect(plan.savedMs).toBeGreaterThan(400)
    // The handover is priced, not waved away.
    expect(plan.handoverMs).toBeGreaterThan(0)
    expect(plan.caveats.join(' ')).toMatch(/KV cache for .* tokens has to cross the link/)
    expect(plan.caveats.join(' ')).toMatch(/thermal behaviour/i)
  })

  /**
   * The distinction that keeps this module honest, and a real finding in its
   * own right: a thermal handover only ever matters between devices of similar
   * speed. The moment the target is simply quicker, throttling was never what
   * decided it, and saying otherwise would attribute a routing choice to heat.
   */
  it('does not call a raw speed difference a thermal handover', () => {
    const plan = planMigration({ ...base, start: PHONE, candidates: to(DESKTOP), outputTokens: 40 })
    expect(plan.migrate).toBe(true)
    expect(plan.cause).toBe('faster-device')
    expect(plan.why).toMatch(/simply quicker/i)
    expect(plan.why).toMatch(/throttling or not/i)
    // And it does not dress that up in thermal caveats it cannot support.
    expect(plan.caveats.join(' ')).not.toMatch(/thermal behaviour/i)
  })

  /**
   * The limit of a single handover, stated rather than hidden. Past a certain
   * length both devices end up throttled and one move cannot rescue the reply;
   * the model says so instead of recommending a move that barely beats nothing.
   */
  it('stops recommending a move once one handover cannot fix the reply', () => {
    const plan = planMigration({ ...base, start: PHONE, candidates: to(TWIN), outputTokens: 6000 })
    expect(plan.migrate).toBe(false)
    expect(plan.why).toMatch(/inside the error of the estimate/i)
    expect(plan.caveats.join(' ')).toMatch(/alternating between devices .* is not built/i)
  })

  it('refuses when there is nowhere to hand it to', () => {
    expect(planMigration({ ...base, start: PHONE, candidates: [], outputTokens: 2000 }).migrate).toBe(false)
    const notLoaded = [{ cap: DESKTOP, hasModelLoaded: false }]
    expect(planMigration({ ...base, start: PHONE, candidates: notLoaded, outputTokens: 2000 }).why)
      .toMatch(/no other device here is holding this model/i)
  })

  it('will not move a reply onto something slower, however cool it is', () => {
    const plan = planMigration({ ...base, start: DESKTOP, candidates: to(PHONE), outputTokens: 2000 })
    expect(plan.migrate).toBe(false)
  })

  it('gets less willing as the link gets slower, because the KV has to cross it', () => {
    const at = (linkGBs: number) =>
      planMigration({
        ...base, start: PHONE, outputTokens: 1200,
        candidates: [{ cap: DESKTOP, hasModelLoaded: true, linkGBs, hopMs: 3 }],
      })
    const fast = at(1.0)
    const slow = at(0.002)
    expect(fast.savedMs).toBeGreaterThan(slow.savedMs)
    expect(slow.handoverMs).toBeGreaterThan(fast.handoverMs)
  })

  it('never reports a saving it cannot justify', () => {
    for (const outputTokens of [10, 50, 200, 600, 1500, 4000]) {
      const plan = planMigration({ ...base, start: PHONE, candidates: to(TWIN), outputTokens })
      if (plan.migrate) {
        expect(plan.savedMs).toBeGreaterThan(400)
        expect(plan.moveMs).toBeLessThan(plan.stayMs)
      } else {
        expect(plan.savedMs).toBe(0)
      }
    }
  })
})

describe('reading one long prompt on several devices', () => {
  const helper = (cap: Capability) => ({ cap, hasModelLoaded: true })

  it('costs less than it saves for a grouped-query model on a room-speed link', () => {
    expect(prefillRatio(LLAMA_8B, TABLET, 0.12)).toBeLessThan(1)
  })

  it('is never worth it for a model whose KV cache is too heavy', () => {
    expect(prefillRatio(MHA_8B, TABLET, 0.12)).toBeGreaterThan(prefillRatio(LLAMA_8B, TABLET, 0.12))
    const plan = planParallelPrefill({
      model: MHA_8B, decodeOn: TABLET, helpers: [helper(DESKTOP)],
      promptTokens: 8000, linkGBs: 0.01,
    })
    expect(plan.worthwhile).toBe(false)
    expect(plan.why).toMatch(/slower at any length/i)
    expect(plan.caveats.join(' ')).toMatch(/more devices makes it worse/i)
  })

  /**
   * The result worth having: transfer and compute both scale linearly with the
   * prompt, so their ratio is a property of the model and the link, not of the
   * input. Whether to split does not become true at some magic length.
   */
  it('has a cost ratio that does not depend on how long the prompt is', () => {
    const at = (tokens: number) =>
      prefillTransferBytes(LLAMA_8B, tokens, 2) / tokens
    expect(at(1000)).toBeCloseTo(at(100_000), 6)
  })

  it('splits the prompt in proportion to how fast each device is', () => {
    const plan = planParallelPrefill({
      model: LLAMA_8B, decodeOn: TABLET, helpers: [helper(DESKTOP), helper(PHONE)],
      promptTokens: 16_000, linkGBs: 0.12,
    })
    expect(plan.worthwhile).toBe(true)
    expect(plan.chunks).toHaveLength(3)
    expect(plan.chunks.reduce((a, b) => a + b, 0)).toBe(16_000)
    // The desktop is the fastest of the three, so it reads the most.
    const desktopIndex = plan.devices.findIndex((d) => d.deviceId === 'desktop')
    expect(Math.max(...plan.chunks)).toBe(plan.chunks[desktopIndex])
  })

  /**
   * The consequence of the ratio being length-invariant: once it is below 1,
   * splitting wins at essentially any prompt length, and the only thing left to
   * cover is a couple of round trips.
   */
  it('is worth doing at almost any length once the ratio is below one', () => {
    const plan = planParallelPrefill({
      model: LLAMA_8B, decodeOn: TABLET, helpers: [helper(DESKTOP)],
      promptTokens: 8000, linkGBs: 0.12,
    })
    expect(prefillRatio(LLAMA_8B, TABLET, 0.12)).toBeLessThan(1)
    expect(plan.crossoverTokens).toBeLessThan(100)

    // And a link slow enough to push the ratio over 1 has no crossover at all.
    const slow = planParallelPrefill({
      model: LLAMA_8B, decodeOn: TABLET, helpers: [helper(DESKTOP)],
      promptTokens: 8000, linkGBs: 0.005,
    })
    expect(slow.worthwhile).toBe(false)
    expect(slow.crossoverTokens).toBe(Infinity)
  })

  it('says what it does not do', () => {
    const plan = planParallelPrefill({
      model: LLAMA_8B, decodeOn: TABLET, helpers: [helper(DESKTOP)],
      promptTokens: 16_000, linkGBs: 0.12,
    })
    expect(plan.caveats.join(' ')).toMatch(/shortens the wait for the first token, not the speed of the rest/i)
    expect(plan.savedMs).toBeGreaterThan(0)
    expect(plan.parallelTtftMs).toBeLessThan(plan.baselineTtftMs)
  })

  it('refuses when it is the only device holding the model', () => {
    const plan = planParallelPrefill({
      model: LLAMA_8B, decodeOn: TABLET,
      helpers: [{ cap: DESKTOP, hasModelLoaded: false }],
      promptTokens: 16_000,
    })
    expect(plan.worthwhile).toBe(false)
    expect(plan.devices).toEqual([TABLET])
  })
})

describe('the fleet uses one thermal source of truth', () => {
  it('prefers a measured profile over the prior for its class', () => {
    const measured = { sustained: 0.8, holdS: 200, tauS: 40, recoveryTauS: 60, source: 'measured' as const }
    expect(profileFor(PHONE)).toEqual(THERMAL_PRIORS.phone)
    expect(profileFor({ ...PHONE, thermal: measured })).toEqual(measured)
  })
})
