import type { Capability } from '@/capability/identify'

/**
 * How fast a device *stays*, as opposed to how fast it starts.
 *
 * Every number elsewhere in this planner is a peak: bandwidth measured over a
 * one-second sweep, a decode rate measured over a few hundred tokens. That is
 * the right number for a short reply and the wrong one for a long one. A phone
 * holds full clocks for well under a minute of sustained GPU or NPU load and
 * then falls to roughly half; a desktop barely moves. So the same fleet that
 * ranks one way at token 20 ranks differently at token 600, and a planner that
 * only knows peak throughput cannot see that.
 *
 * This is the axis nobody schedules on. Datacenter inference research assumes
 * actively cooled, homogeneous nodes, so throttling never enters the model. A
 * fleet of personal devices is the opposite: heterogeneous, passively cooled,
 * and each one on its own thermal budget.
 */

export interface ThermalProfile {
  /** Throughput under indefinite load, as a fraction of peak. */
  sustained: number
  /** Seconds of full-speed work before throttling starts. */
  holdS: number
  /** Time constant of the fall from peak to sustained, seconds. */
  tauS: number
  /** Time constant of recovery once the device goes idle, seconds. */
  recoveryTauS: number
  /**
   * Where these numbers came from. Never 'measured' until a device has been
   * watched running long enough to fit them — see `calibrateThermal`.
   */
  source: 'assumed' | 'measured'
}

/**
 * Priors by device class, in the same spirit as `deviceDb`: good enough to plan
 * with, explicitly labelled as assumptions, and replaced the moment a real
 * generation gives us something better.
 *
 * The ordering is the part that matters and is not controversial — a phone in
 * a hand throttles sooner and harder than a tablet, which throttles sooner and
 * harder than a fan-cooled desktop. The exact constants are guesses.
 */
export const THERMAL_PRIORS: Record<Capability['kind'], ThermalProfile> = {
  phone: { sustained: 0.45, holdS: 25, tauS: 35, recoveryTauS: 90, source: 'assumed' },
  tablet: { sustained: 0.6, holdS: 55, tauS: 50, recoveryTauS: 90, source: 'assumed' },
  laptop: { sustained: 0.75, holdS: 90, tauS: 60, recoveryTauS: 60, source: 'assumed' },
  desktop: { sustained: 0.95, holdS: 600, tauS: 120, recoveryTauS: 30, source: 'assumed' },
}

export function profileFor(cap: Capability): ThermalProfile {
  return cap.thermal ?? THERMAL_PRIORS[cap.kind] ?? THERMAL_PRIORS.laptop
}

/**
 * Throughput at time `t` into a sustained run, as a fraction of peak.
 *
 * Flat through the hold, then exponential decay to the sustained floor. Real
 * throttling is a staircase of clock states rather than a smooth curve, but the
 * area under it — which is what decides when to hand work over — is close, and
 * a smooth curve is differentiable and invertible, which the staircase is not.
 */
export function throttleFactor(elapsedS: number, p: ThermalProfile): number {
  if (elapsedS <= p.holdS) return 1
  const over = elapsedS - p.holdS
  return p.sustained + (1 - p.sustained) * Math.exp(-over / Math.max(0.01, p.tauS))
}

/**
 * Tokens produced in `seconds` of continuous work, starting cool.
 *
 * The closed form of the integral under `throttleFactor`, so a migration
 * planner can scan a few hundred candidate handover points without simulating
 * each one token by token.
 */
export function tokensIn(seconds: number, peakTokPerSec: number, p: ThermalProfile): number {
  if (seconds <= 0) return 0
  if (seconds <= p.holdS) return peakTokPerSec * seconds

  const over = seconds - p.holdS
  const tau = Math.max(0.01, p.tauS)
  const area =
    p.holdS + p.sustained * over + (1 - p.sustained) * tau * (1 - Math.exp(-over / tau))
  return peakTokPerSec * area
}

/** Seconds to produce `tokens`, starting cool. The inverse of `tokensIn`. */
export function secondsFor(tokens: number, peakTokPerSec: number, p: ThermalProfile): number {
  if (tokens <= 0 || peakTokPerSec <= 0) return 0

  const unthrottled = tokens / peakTokPerSec
  if (unthrottled <= p.holdS) return unthrottled

  // Monotonic, so bisection is exact enough and cannot diverge the way
  // Newton's method can near the flat part of the curve. The upper bound is the
  // time it would take entirely at the sustained floor, which is a hard ceiling.
  let lo = p.holdS
  let hi = p.holdS + tokens / (peakTokPerSec * Math.max(0.01, p.sustained))
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (tokensIn(mid, peakTokPerSec, p) < tokens) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/** Average throughput over a whole run of `tokens`, starting cool. */
export function sustainedTokPerSec(
  tokens: number,
  peakTokPerSec: number,
  p: ThermalProfile,
): number {
  const s = secondsFor(tokens, peakTokPerSec, p)
  return s > 0 ? tokens / s : peakTokPerSec
}

/* ── Calibration ──────────────────────────────────────────────────────── */

export interface ThermalSample {
  /** Seconds since this run of continuous work began. */
  elapsedS: number
  tokensPerSec: number
}

/**
 * Fits a profile to a device we have watched work.
 *
 * Same discipline as `roofline.calibrate`: a sample set that cannot support a
 * fit returns the previous profile untouched rather than a clamped guess, and
 * the result is only ever labelled 'measured' when it really was. A run that
 * never got hot enough to throttle tells us nothing about the floor, and
 * pretending otherwise would make a phone look like a desktop.
 */
export function calibrateThermal(
  samples: ThermalSample[],
  previous?: ThermalProfile,
): ThermalProfile | null {
  const prev = previous ?? null
  const sorted = [...samples].sort((a, b) => a.elapsedS - b.elapsedS)
  if (sorted.length < 6) return prev

  const peak = Math.max(...sorted.slice(0, 3).map((s) => s.tokensPerSec))
  if (!(peak > 0)) return prev

  const span = sorted[sorted.length - 1].elapsedS - sorted[0].elapsedS
  if (span < 20) return prev

  // The floor is the tail, not the minimum: one scheduling hiccup is not a
  // thermal state.
  const tail = sorted.slice(Math.floor(sorted.length * 0.7))
  const floor = tail.reduce((a, s) => a + s.tokensPerSec, 0) / tail.length / peak

  // Never throttled within the window we watched, so we learnt where the hold
  // extends to and nothing at all about the floor.
  if (floor > 0.95) {
    return {
      sustained: prev?.sustained ?? 0.95,
      holdS: Math.max(prev?.holdS ?? 0, sorted[sorted.length - 1].elapsedS),
      tauS: prev?.tauS ?? 60,
      recoveryTauS: prev?.recoveryTauS ?? 60,
      source: prev?.source ?? 'assumed',
    }
  }

  const onset = sorted.find((s) => s.tokensPerSec < peak * 0.95)
  const holdS = onset ? onset.elapsedS : span / 2

  // Time from the onset of throttling to within 1/e of the floor.
  const target = peak * (floor + (1 - floor) / Math.E)
  const settled = sorted.find((s) => s.elapsedS > holdS && s.tokensPerSec <= target)
  const tauS = settled ? Math.max(1, settled.elapsedS - holdS) : Math.max(1, (span - holdS) / 2)

  return {
    sustained: Math.min(1, Math.max(0.05, floor)),
    holdS,
    tauS,
    recoveryTauS: prev?.recoveryTauS ?? 60,
    source: 'measured',
  }
}
