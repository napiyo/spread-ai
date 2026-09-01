import type { GenerateRequest, RunStats } from '@/runtime/types'

/**
 * Somewhere a generation can happen: this tab, or another device in the mesh.
 *
 * The strategies below are written against this interface and nothing else,
 * which is what lets them be tested without a GPU, a browser, or a network —
 * and what stops "run it here" and "run it there" from becoming two code paths
 * that drift apart.
 */
export interface Worker {
  id: string
  label: string
  local: boolean
  /** The model this worker has resident right now, or null when it has none. */
  modelId: string | null
  /** Display name for that model. */
  modelLabel: string | null
  /** Round-trip time to this worker in ms. Zero for the local one. */
  rttMs: number
  /**
   * Measured memory bandwidth, GB/s. Decode is bandwidth-bound, so this is the
   * best single number for guessing which device will finish first — a guess,
   * used only for ordering, never reported as a prediction.
   */
  bandwidthGBs: number
  /** Already doing something. Asking it anyway would just be refused. */
  busy: boolean
  run(req: GenerateRequest, onToken: (delta: string) => void): Promise<WorkerResult>
  interrupt(): Promise<void>
}

export interface WorkerResult {
  text: string
  stats: RunStats | null
  interrupted: boolean
}

export type StrategyKind = 'single' | 'best-of-n' | 'map-reduce'

/** A concrete arrangement of workers, and the honest account of what it buys. */
export interface Strategy {
  kind: StrategyKind
  workers: Worker[]
  /** What this arrangement does, in plain words. */
  why: string
  /** What it costs, or does not buy. Never empty when more than one device is used. */
  caveats: string[]
}

/** One sample from one device. Best-of-n produces several; everything else, one. */
export interface Candidate {
  workerId: string
  deviceLabel: string
  text: string
  stats: RunStats | null
  error?: string
}

export interface TurnOutcome {
  text: string
  stats: RunStats | null
  interrupted: boolean
  /** Which device the shown answer came from. */
  deviceLabel: string
  /** Every sample drawn, when more than one was. */
  candidates?: Candidate[]
  /**
   * Which of them `text` came from. Not always the one that was streamed: if
   * the device whose tokens were going to the transcript fails, the answer has
   * to come from one of the others.
   */
  shownIndex?: number
}

/** Progress for arrangements that take several visible steps. */
export interface StepReport {
  /** 0-based index of the step that just changed. */
  step: number
  steps: number
  label: string
  done: boolean
}
