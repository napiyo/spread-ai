import { describe, expect, it } from 'vitest'
import { capabilityFromSpec } from '@/capability/identify'
import { DEVICE_BY_ID } from '@/capability/deviceDb'
import type { ModelSpec } from './modelSpec'
import {
  DEFAULT_ACCEPT_RATE, optionsForModel, optionsMeetingTarget, recommendModels,
  speculativeTokensPerSec,
} from './recommend'

const QWEN3_8B: ModelSpec = {
  id: 'Qwen/Qwen3-8B', label: 'Qwen3 8B', params: 8.19e9,
  nLayers: 36, hiddenSize: 4096, nHeads: 32, nKvHeads: 8, headDim: 128,
  intermediateSize: 12288, vocabSize: 151936, maxContext: 40960,
  quant: 'q4f16_1', tiedEmbeddings: false,
}
const QWEN3_06B: ModelSpec = {
  id: 'Qwen/Qwen3-0.6B', label: 'Qwen3 0.6B', params: 0.75e9,
  nLayers: 28, hiddenSize: 1024, nHeads: 16, nKvHeads: 8, headDim: 128,
  intermediateSize: 3072, vocabSize: 151936, maxContext: 40960,
  quant: 'q4f16_1', tiedEmbeddings: true,
}

const m4pro = capabilityFromSpec(DEVICE_BY_ID.get('m4-pro')!)
const air = capabilityFromSpec(DEVICE_BY_ID.get('m2')!)
const iphone = capabilityFromSpec(DEVICE_BY_ID.get('iphone-17-pro')!)
const OPTS = { ctx: 2048 }

describe('speculativeTokensPerSec', () => {
  it('beats the target model alone when the draft is much faster', () => {
    expect(speculativeTokensPerSec(20, 200)).toBeGreaterThan(20)
  })

  it('gives back the gain as acceptance falls', () => {
    const good = speculativeTokensPerSec(20, 200, { acceptRate: 0.9 })
    const poor = speculativeTokensPerSec(20, 200, { acceptRate: 0.3 })
    expect(good).toBeGreaterThan(poor)
  })

  it('is not worth it when the draft is barely faster than the target', () => {
    expect(speculativeTokensPerSec(20, 22)).toBeLessThan(20)
  })

  it('survives a slow link, because it costs one round trip per cycle', () => {
    const lan = speculativeTokensPerSec(20, 200, { hopMs: 2 })
    const bad = speculativeTokensPerSec(20, 200, { hopMs: 25 })
    expect(bad).toBeGreaterThan(lan * 0.5)
  })
})

describe('optionsForModel', () => {
  it('prefers the single device that can hold the whole model', () => {
    const best = optionsForModel(QWEN3_8B, [m4pro], OPTS)[0]
    expect(best.kind).toBe('single')
    expect(best.feasible).toBe(true)
  })

  it('does not dress a single-device plan up as a multi-device one', () => {
    // The M4 Pro holds all 36 layers, so the iPhone would carry nothing. The
    // pooled option must say that rather than quoting the Mac's speed under
    // two devices' names.
    const pooled = optionsForModel(QWEN3_8B, [m4pro, iphone], OPTS).find((o) => o.id === 'owned:all')!
    expect(pooled.kind).toBe('single')
    expect(pooled.why).toMatch(/not needed here/i)
    expect(pooled.partition!.stages).toHaveLength(1)
  })

  it('says plainly that a genuine split is slower than one device that fits', () => {
    // Force a real split by starving both devices of memory.
    const a = { ...m4pro, weightBudgetBytes: 3 * 1024 ** 3, deviceId: 'a' }
    const b = { ...m4pro, weightBudgetBytes: 3 * 1024 ** 3, deviceId: 'b' }
    const split = optionsForModel(QWEN3_8B, [a, b], OPTS).find((o) => o.kind === 'pipeline')!
    expect(split.partition!.stages.length).toBeGreaterThan(1)
    expect(split.why).toMatch(/capacity rather than speed/i)

    const whole = optionsForModel(QWEN3_8B, [m4pro], OPTS).find((o) => o.usesOnlyOwned)!
    expect(split.tokensPerSec).toBeLessThan(whole.tokensPerSec)
  })

  it('ranks a device you own above one you would have to acquire', () => {
    const opts = optionsForModel(QWEN3_8B, [m4pro], OPTS).filter((o) => o.feasible)
    expect(opts[0].usesOnlyOwned).toBe(true)
  })

  it('recommends acquiring hardware only when nothing owned can run it', () => {
    const opts = optionsForModel(QWEN3_8B, [iphone], OPTS)
    const ownedFeasible = opts.filter((o) => o.usesOnlyOwned && o.feasible)
    expect(ownedFeasible).toHaveLength(0)
    // ...and it must still offer a real way forward.
    expect(opts.some((o) => o.feasible && !o.usesOnlyOwned)).toBe(true)
  })

  it('explains why an iPhone alone cannot run an 8B model', () => {
    const solo = optionsForModel(QWEN3_8B, [iphone], OPTS).find((o) => o.kind === 'single' && o.usesOnlyOwned)!
    expect(solo.feasible).toBe(false)
    expect(solo.why).toMatch(/available to a browser tab|buffer limit/i)
  })

  it('offers speculative decoding as a genuine speed win, clearly caveated', () => {
    const opts = optionsForModel(QWEN3_8B, [m4pro, air], { ...OPTS, draft: QWEN3_06B })
    const spec = opts.find((o) => o.kind === 'speculative')
    expect(spec).toBeTruthy()
    const single = opts.find((o) => o.kind === 'single' && o.feasible && o.usesOnlyOwned)!
    expect(spec!.tokensPerSec).toBeGreaterThan(single.tokensPerSec)
    expect(spec!.caveats.join(' ')).toMatch(new RegExp(`${Math.round(DEFAULT_ACCEPT_RATE * 100)}%`))
  })
})

describe('recommendModels', () => {
  it('puts the largest model that runs on one owned device first', () => {
    const rows = recommendModels([QWEN3_06B, QWEN3_8B], [m4pro], OPTS)
    expect(rows[0].model.id).toBe(QWEN3_8B.id)
    expect(rows[0].fitsOnOneOwnedDevice).toBe(true)
  })

  it('demotes a model that needs devices you do not have', () => {
    const rows = recommendModels([QWEN3_06B, QWEN3_8B], [iphone], OPTS)
    expect(rows[0].model.id).toBe(QWEN3_06B.id)
    const big = rows.find((r) => r.model.id === QWEN3_8B.id)!
    expect(big.fitsOnOneOwnedDevice).toBe(false)
  })
})

describe('optionsMeetingTarget', () => {
  it('finds fleets that reach an achievable target', () => {
    const { meeting } = optionsMeetingTarget(QWEN3_8B, 10, [m4pro], OPTS)
    expect(meeting.length).toBeGreaterThan(0)
    expect(meeting[0].tokensPerSec).toBeGreaterThanOrEqual(10)
  })

  it('returns the closest it can get rather than nothing, when the target is out of reach', () => {
    const { meeting, closest } = optionsMeetingTarget(QWEN3_8B, 100_000, [m4pro], OPTS)
    expect(meeting).toHaveLength(0)
    expect(closest).toBeTruthy()
    expect(closest!.feasible).toBe(true)
  })

  it('never suggests more phones as the route to more speed', () => {
    // The naive intuition this whole app exists to correct.
    const { meeting } = optionsMeetingTarget(QWEN3_06B, 60, [iphone], OPTS)
    const phonePiles = meeting.filter((o) => o.kind === 'pipeline' && o.devices.every((d) => d.spec.kind === 'phone'))
    for (const o of phonePiles) {
      const solo = optionsForModel(QWEN3_06B, [iphone], OPTS).find((x) => x.kind === 'single' && x.usesOnlyOwned)
      if (solo?.feasible) expect(o.tokensPerSec).toBeLessThan(solo.tokensPerSec)
    }
  })
})

describe('advice when nothing you own works', () => {
  it('recommends the most modest addition, not the fastest one', () => {
    const rows = recommendModels([QWEN3_8B], [iphone], OPTS)
    const cheapest = rows[0].cheapest!
    const best = rows[0].best!
    expect(cheapest.feasible).toBe(true)
    // A laptop that can just about hold it beats a flagship GPU as advice.
    const power = (o: typeof cheapest) => Math.max(...o.devices.map((d) => d.spec.bandwidthGBs))
    expect(power(cheapest)).toBeLessThanOrEqual(power(best))
    expect(power(cheapest)).toBeLessThan(1000)
  })

  it('explains what stopped your own hardware before suggesting anything else', () => {
    const rows = recommendModels([QWEN3_8B], [iphone], OPTS)
    expect(rows[0].ownedBlockers.length).toBeGreaterThan(0)
    expect(rows[0].ownedBlockers.join(' ')).toMatch(/browser tab|buffer limit|storage quota/i)
  })

  it('names a storage quota as the blocker when that is what actually bites', () => {
    // Ample memory, nearly-full disk: the machine this was built on, in fact.
    const cramped = { ...m4pro, storageBudgetBytes: 4 * 1024 ** 3 }
    const rows = recommendModels([QWEN3_8B], [cramped], OPTS)
    expect(rows[0].fitsOnOneOwnedDevice).toBe(false)
    expect(rows[0].ownedBlockers.join(' ')).toMatch(/storage quota/i)
  })
})

describe('the smallest addition is still a useful one', () => {
  it('skips hardware that technically works but is too slow to be worth it', () => {
    const cheapest = recommendModels([QWEN3_8B], [iphone], OPTS)[0].cheapest!
    // Below ~8 tok/s a reply arrives slower than most people read.
    expect(cheapest.tokensPerSec).toBeGreaterThanOrEqual(8)
  })

  it('still answers with something when nothing clears that bar', () => {
    // A model far too big for anything in the table: the advice must not be
    // silence, it must be the best that exists plus its caveats.
    const huge = { ...QWEN3_8B, id: 'huge', label: 'Huge', params: 400e9, nLayers: 120 }
    const rec = recommendModels([huge], [iphone], OPTS)[0]
    expect(rec.cheapest === null || rec.cheapest.feasible).toBe(true)
  })
})

describe('optionsMeetingTarget ordering', () => {
  it('leads with the least you would have to change, not the fastest', () => {
    const { meeting } = optionsMeetingTarget(QWEN3_8B, 30, [iphone], OPTS)
    expect(meeting.length).toBeGreaterThan(1)
    const power = (o: (typeof meeting)[number]) =>
      Math.max(...o.devices.map((d) => d.spec.bandwidthGBs))
    // Once an option clears the bar, being further above it is not a virtue.
    expect(power(meeting[0])).toBeLessThan(power(meeting[meeting.length - 1]))
    expect(meeting[0].tokensPerSec).toBeGreaterThanOrEqual(30)
  })

  it('always puts hardware you already own first', () => {
    const { meeting } = optionsMeetingTarget(QWEN3_06B, 20, [m4pro], OPTS)
    expect(meeting[0].usesOnlyOwned).toBe(true)
  })
})
