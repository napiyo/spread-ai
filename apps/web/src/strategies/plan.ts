import { MAP_MIN_CHARS, partsFor, splitTask } from './split'
import type { Strategy, StrategyKind, Worker } from './types'

/**
 * Choosing how to run one turn.
 *
 * The rule this file exists to enforce is the same one the advisor is built
 * around: adding devices buys capacity and throughput, not latency. So every
 * arrangement here carries what it actually does, arrangements that would only
 * add hops are refused with a reason rather than offered, and no `why` string
 * anywhere claims a second device makes one reply arrive sooner unless the work
 * really was independent.
 */

export type Choice =
  | { kind: 'auto' }
  | { kind: 'single'; workerId?: string }
  | { kind: 'best-of-n'; samples?: number }
  | { kind: 'map-reduce' }

export type PlanResult =
  | { ok: true; strategy: Strategy }
  | { ok: false; reason: string }

/** Default number of samples for best-of-n, capped by how many devices there are. */
export const DEFAULT_SAMPLES = 3

/** Workers that could take this turn right now. */
export function usableWorkers(workers: Worker[], modelId: string | null): Worker[] {
  return workers
    .filter((w) => !w.busy && w.modelId && (!modelId || w.modelId === modelId))
    .sort(rankBySpeed)
}

/**
 * Fastest first. Decode is bandwidth-bound, so bandwidth decides; a link that
 * costs more to reach breaks the tie, and this device wins an exact one because
 * it is the only worker that cannot go away mid-sentence.
 */
function rankBySpeed(a: Worker, b: Worker): number {
  if (a.bandwidthGBs !== b.bandwidthGBs) return b.bandwidthGBs - a.bandwidthGBs
  if (a.rttMs !== b.rttMs) return a.rttMs - b.rttMs
  return Number(b.local) - Number(a.local)
}

export function planTurn(input: {
  workers: Worker[]
  modelId: string | null
  /** The message about to be sent. Its length decides whether splitting helps. */
  content: string
  choice: Choice
}): PlanResult {
  const { modelId, content, choice } = input
  const usable = usableWorkers(input.workers, modelId)

  if (!usable.length) {
    const idle = input.workers.filter((w) => w.modelId)
    return {
      ok: false,
      reason: idle.length
        ? 'Every device that has this model loaded is busy with another reply.'
        : 'No device in this fleet has this model loaded.',
    }
  }

  switch (choice.kind) {
    case 'single':
      return planSingle(usable, choice.workerId)
    case 'best-of-n':
      return planBestOfN(usable, choice.samples ?? DEFAULT_SAMPLES)
    case 'map-reduce':
      return planMapReduce(usable, content)
    case 'auto':
      return planAuto(usable, content)
  }
}

function planSingle(usable: Worker[], workerId?: string): PlanResult {
  const worker = workerId ? usable.find((w) => w.id === workerId) : usable[0]
  if (!worker) {
    return { ok: false, reason: 'That device is no longer able to take this turn.' }
  }

  if (worker.local) {
    return {
      ok: true,
      strategy: {
        kind: 'single',
        workers: [worker],
        why: 'Runs entirely on this device, which is always the fastest way to run one reply.',
        caveats: [],
      },
    }
  }

  const here = usable.find((w) => w.local)
  return {
    ok: true,
    strategy: {
      kind: 'single',
      workers: [worker],
      why: `${worker.label} does the work and sends the tokens back as they are written.`,
      caveats: here
        ? [
            // Saying this out loud is the point. Handing the turn to another
            // device is a way to keep this one free, not a way to go faster.
            `This device could run it too, and running it here would be faster by about the ${Math.round(worker.rttMs)} ms round trip. Sending it away is worth it when you want this device left alone, not when you want the answer sooner.`,
          ]
        : ['Nothing is loaded here, so the reply arrives over the link rather than being generated in this tab.'],
    },
  }
}

function planBestOfN(usable: Worker[], samples: number): PlanResult {
  if (usable.length < 2) {
    return {
      ok: false,
      reason:
        'Best-of-n needs a second device with the same model loaded. On one device the samples would run one after another, which is just pressing regenerate.',
    }
  }
  const workers = usable.slice(0, Math.max(2, Math.min(samples, usable.length)))
  return {
    ok: true,
    strategy: {
      kind: 'best-of-n',
      workers,
      why: `${workers.length} devices each draw their own sample at the same time, so you get ${workers.length} answers to choose between in the time one takes.`,
      caveats: [
        // The honest half. Parallel sampling is throughput, not latency.
        'This does not make a reply arrive any sooner — the first answer lands no earlier than it would have on its own.',
        'The samples differ only by their seed, so a question with one right answer will get the same one several times.',
      ],
    },
  }
}

function planMapReduce(usable: Worker[], content: string): PlanResult {
  const { document } = splitTask(content)

  if (document.length < MAP_MIN_CHARS) {
    return {
      ok: false,
      reason: `Splitting only pays off past about ${MAP_MIN_CHARS.toLocaleString()} characters of input; this is ${document.length.toLocaleString()}. Below that the round trips cost more than the reading saves.`,
    }
  }
  if (usable.length < 2) {
    return {
      ok: false,
      reason:
        'Splitting the input needs a second device with the same model loaded — otherwise the parts are read one after another on this one, which is slower than reading it whole.',
    }
  }

  const workers = usable.slice(0, Math.min(usable.length, 4))
  // The same count the run will actually use. A long document becomes more
  // parts than there are devices, and saying "one each" when a laptop is about
  // to take four of them is the kind of small lie this project is against.
  const parts = partsFor(document.length, workers.length)
  const each = parts === workers.length ? 'one each' : `taking the next one as they finish`

  return {
    ok: true,
    strategy: {
      kind: 'map-reduce',
      workers,
      why: `The input is cut into ${parts} parts and read by ${workers.length} devices at the same time, ${each}; ${workers[0].label} then writes the single answer from their notes. The parts really are independent, so this genuinely makes a long input finish sooner.`,
      caveats: [
        'Each device sees only its own part, so a question whose answer spans the whole document is answered from notes rather than from the text.',
        'The final pass costs one extra generation on top of the parts.',
      ],
    },
  }
}

/**
 * What to do when nobody said.
 *
 * Only ever picks an arrangement that is at least as good as running it here:
 * splitting a genuinely long input, otherwise the fastest single device. It
 * never reaches for best-of-n on its own — more samples is a thing to ask for,
 * not something to spend three devices on unprompted.
 */
function planAuto(usable: Worker[], content: string): PlanResult {
  const split = planMapReduce(usable, content)
  if (split.ok) return split
  return planSingle(usable)
}

/** Short label for a strategy, for the transcript and the picker. */
export function strategyLabel(kind: StrategyKind, workers: number): string {
  switch (kind) {
    case 'single':
      return 'one device'
    case 'best-of-n':
      return `best of ${workers}`
    case 'map-reduce':
      return `split across ${workers} devices`
  }
}
