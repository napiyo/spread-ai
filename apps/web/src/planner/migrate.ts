import type { Capability } from '@/capability/identify'
import { kvBytesPerToken, type ModelSpec } from './modelSpec'
import { estimate, fitsOnDevice } from './roofline'
import { profileFor, secondsFor, tokensIn, type ThermalProfile } from './thermal'

/**
 * Handing a reply over, mid-sentence, to a device that is still cool.
 *
 * The one thing a second device can do for a *single* long reply. Splitting the
 * model does not help — the stages run in sequence at batch size one. Drawing
 * more samples does not help — the first answer lands no earlier. But a phone
 * that starts at 30 tok/s and is down to 14 by token 400 can hand the rest of
 * the sentence to a tablet on a charger, carrying the KV cache across, and
 * finish sooner than it would have alone.
 *
 * What crosses the wire is the KV cache for everything generated so far, which
 * is why this is a real engineering question rather than an obvious win: the
 * handover gets more expensive exactly as the case for making it gets stronger.
 * The crossover is what this file computes.
 */

export interface MigrationCandidate {
  cap: Capability
  /** Only a device already holding this model can take the rest of a reply. */
  hasModelLoaded: boolean
  /** One-way hop, ms. Measured from the mesh when live. */
  hopMs?: number
  /** Throughput of the link to this device, GB/s. */
  linkGBs?: number
}

export interface MigrationInput {
  model: ModelSpec
  /** Where the reply is being written now. */
  start: Capability
  candidates: MigrationCandidate[]
  /** Tokens already in the context when generation begins. */
  ctx: number
  promptTokens: number
  /** How long the reply is expected to be. The whole decision turns on this. */
  outputTokens: number
  /**
   * Plan as if no device ever throttled. Used internally to tell a thermal
   * handover apart from one that is really just "that device is faster".
   */
  ignoreThermal?: boolean
}

/**
 * Why a handover is worth making. These are different decisions wearing the
 * same shape, and reporting them as one would be the sloppy kind of honesty:
 *
 *   'thermal'       — the devices are comparable, but this one is about to
 *                     throttle and the other is cool. The interesting case.
 *   'faster-device' — the other device would have been quicker from the first
 *                     token; thermals do not come into it. True, but it is a
 *                     routing decision, not a migration one, and it belongs in
 *                     the picker rather than mid-sentence.
 */
export type MigrationCause = 'thermal' | 'faster-device'

export interface MigrationPlan {
  migrate: boolean
  cause: MigrationCause | null
  /** Token index to hand over at. Only meaningful when `migrate`. */
  atToken: number
  to: Capability | null
  /** Cost of the handover itself: KV over the wire, plus resuming. */
  handoverMs: number
  /** Milliseconds saved against staying put. Never reported when negative. */
  savedMs: number
  /** What the whole reply costs if nothing moves. */
  stayMs: number
  moveMs: number
  why: string
  caveats: string[]
}

/**
 * Wi-Fi Direct between two devices in the same room, as a starting assumption.
 * Roughly 1 Gb/s of real throughput. Wired or 60 GHz would change the answer,
 * and that is exactly the point of making it a parameter.
 */
export const DEFAULT_LINK_GBS = 0.12
const DEFAULT_HOP_MS = 2.5

/**
 * Restarting a generation on another device is not free even with the model
 * already resident: the engine has to accept an imported KV cache, re-enter its
 * decode loop and warm its command buffers.
 */
const RESUME_MS = 120

/**
 * Below this a migration is not worth the risk of a device dropping mid-reply.
 * A plan that saves 40 ms is noise dressed as a decision.
 */
const MIN_SAVING_MS = 400
const MIN_SAVING_FRACTION = 0.05

/** A device that never throttles, for asking what the answer would be without it. */
const FLAT: ThermalProfile = {
  sustained: 1, holdS: Infinity, tauS: 1, recoveryTauS: 1, source: 'assumed',
}

export function planMigration(i: MigrationInput): MigrationPlan {
  const startProfile = i.ignoreThermal ? FLAT : profileFor(i.start)
  const startPeak = peakTokPerSec(i.model, i.start, i)
  const stayS = secondsFor(i.outputTokens, startPeak, startProfile)
  const stayMs = stayS * 1000

  const none = (why: string, caveats: string[] = []): MigrationPlan => ({
    migrate: false, cause: null, atToken: i.outputTokens, to: null,
    handoverMs: 0, savedMs: 0, stayMs, moveMs: stayMs, why, caveats,
  })

  const usable = i.candidates.filter(
    (c) =>
      c.hasModelLoaded &&
      c.cap.deviceId !== i.start.deviceId &&
      fitsOnDevice(i.model, c.cap, i.ctx + i.outputTokens).fits,
  )
  if (!usable.length) {
    return none(
      i.candidates.length
        ? 'No other device here is holding this model with room for the rest of the reply, so there is nowhere to hand it to.'
        : 'Nothing else is paired, so this reply finishes where it started.',
    )
  }

  let best: MigrationPlan | null = null

  for (const candidate of usable) {
    const targetProfile = i.ignoreThermal ? FLAT : profileFor(candidate.cap)
    const targetPeak = peakTokPerSec(i.model, candidate.cap, i)
    const hopMs = candidate.hopMs ?? DEFAULT_HOP_MS
    const linkBytesPerSec = (candidate.linkGBs ?? DEFAULT_LINK_GBS) * 1e9

    // Scanning token indices rather than solving analytically: the handover
    // cost grows with the token index while the throughput gap grows too, so
    // the objective is not convex in general and a closed form would be a
    // closed form for the wrong problem.
    for (let k = 0; k <= i.outputTokens; k += Math.max(1, Math.round(i.outputTokens / 200))) {
      const beforeS = secondsFor(k, startPeak, startProfile)

      // Everything generated so far, plus the prompt, has to cross the wire.
      const kvBytes = kvBytesPerToken(i.model) * (i.ctx + k)
      const handoverMs = (kvBytes / linkBytesPerSec) * 1000 + 2 * hopMs + RESUME_MS

      // The target starts cool, which is the entire reason this can win.
      const afterS = secondsFor(i.outputTokens - k, targetPeak, targetProfile)
      const moveMs = beforeS * 1000 + handoverMs + afterS * 1000
      const savedMs = stayMs - moveMs

      if (!best || savedMs > best.savedMs) {
        best = {
          migrate: true, cause: 'thermal', atToken: k, to: candidate.cap,
          handoverMs, savedMs, stayMs, moveMs,
          why: '', caveats: [],
        }
      }
    }
  }

  if (!best || best.savedMs < MIN_SAVING_MS) {
    const startsThrottling = i.outputTokens > tokensIn(startProfile.holdS, startPeak, startProfile)
    return none(
      startsThrottling
        ? `${i.start.label} will throttle before this reply ends, but moving it costs more in KV transfer than the slowdown costs in time. It finishes here.`
        : `This reply is short enough that ${i.start.label} never throttles, so there is nothing to gain by moving it.`,
      best && best.savedMs > 0
        ? [`The best handover found saves only ${Math.round(best.savedMs)} ms, which is inside the noise.`]
        : [],
    )
  }

  // A saving that is large in seconds but small against a very long reply is
  // inside this model's own error bars, and — more to the point — one handover
  // cannot rescue a reply long enough to cook both devices. Saying so is more
  // useful than a confident recommendation that barely beats doing nothing.
  if (best.savedMs < stayMs * MIN_SAVING_FRACTION) {
    return none(
      `Moving this reply would save about ${(best.savedMs / 1000).toFixed(0)}s, but that is under ${Math.round(MIN_SAVING_FRACTION * 100)}% of a reply this long — inside the error of the estimate itself.`,
      [
        'A reply this long throttles whichever device finishes it. One handover cannot fix that; alternating between devices as each one cools could, and is not built.',
      ],
    )
  }

  const target = best.to!
  const seconds = (best.savedMs / 1000).toFixed(1)

  // Would it still be worth moving if nothing ever got hot? If so, this is not
  // a thermal decision at all and must not be described as one.
  const cause: MigrationCause =
    !i.ignoreThermal && planMigration({ ...i, ignoreThermal: true }).migrate
      ? 'faster-device'
      : 'thermal'

  const floor = Math.round(profileFor(i.start).sustained * 100)
  const why =
    cause === 'faster-device'
      ? `${target.label} is simply quicker than ${i.start.label} for this model — it would have been from the first token, throttling or not — so the reply finishes about ${seconds}s sooner there. Worth starting it there next time rather than moving it mid-sentence.`
      : best.atToken === 0
        ? `${i.start.label} would throttle to about ${floor}% of its opening speed part-way through a reply this long, so the whole thing goes to ${target.label} up front and arrives about ${seconds}s sooner.`
        : `${i.start.label} writes the first ${best.atToken} tokens at full speed, then hands the rest to ${target.label} before it throttles. About ${seconds}s sooner than finishing here.`

  return {
    ...best,
    cause,
    why,
    caveats: [
      `The handover costs ${Math.round(best.handoverMs)} ms: the KV cache for ${(i.ctx + best.atToken).toLocaleString()} tokens has to cross the link.`,
      ...(cause === 'thermal'
        ? [`Rests on assumed thermal behaviour for ${describeProfileSource(profileFor(i.start), profileFor(target))}. Watch a long generation on each and these become measurements.`]
        : []),
      'If the reply turns out shorter than expected, the handover is wasted work.',
    ],
  }
}

function peakTokPerSec(model: ModelSpec, cap: Capability, i: MigrationInput): number {
  return estimate({
    model, cap, ctx: i.ctx,
    promptTokens: i.promptTokens,
    outputTokens: i.outputTokens,
  }).tokensPerSec
}

function describeProfileSource(a: ThermalProfile, b: ThermalProfile): string {
  const assumed = [a, b].filter((p) => p.source === 'assumed').length
  if (assumed === 2) return 'both devices'
  if (assumed === 1) return 'one of the two devices'
  return 'neither device — both were measured'
}
