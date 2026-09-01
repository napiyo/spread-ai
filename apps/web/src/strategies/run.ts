import type { ChatMessage, GenerateRequest, RunStats } from '@/runtime/types'
import { chunk, partsFor, splitTask } from './split'
import type { Candidate, StepReport, Strategy, TurnOutcome, Worker } from './types'

export interface RunOptions {
  /** History to send, excluding the reply being written. */
  messages: ChatMessage[]
  /** The new message on its own, which map-reduce needs to cut up. */
  content: string
  temperature?: number
  maxTokens?: number
  /** Tokens of the answer that will be shown, as they are written. */
  onToken: (delta: string) => void
  /** Progress for arrangements with more than one visible step. */
  onStep?: (report: StepReport) => void
  signal?: AbortSignal
}

/** Runs one turn under a strategy. Throws only when nothing usable came back. */
export function runStrategy(strategy: Strategy, o: RunOptions): Promise<TurnOutcome> {
  switch (strategy.kind) {
    case 'single':
      return runSingle(strategy.workers[0], o)
    case 'best-of-n':
      return runBestOfN(strategy.workers, o)
    case 'map-reduce':
      return runMapReduce(strategy.workers, o)
  }
}

/* ── One device ───────────────────────────────────────────────────────── */

async function runSingle(worker: Worker, o: RunOptions): Promise<TurnOutcome> {
  const result = await worker.run(request(o, {}), o.onToken)
  return {
    text: result.text,
    stats: withDevice(result.stats, worker.label),
    interrupted: result.interrupted,
    deviceLabel: worker.label,
  }
}

/* ── Several samples at once ──────────────────────────────────────────── */

/**
 * Every device draws its own sample of the same turn.
 *
 * Only the first worker's tokens are streamed into the transcript. Interleaving
 * several would produce a live view of nothing at all; the rest arrive complete
 * and become alternatives you can switch to.
 */
async function runBestOfN(workers: Worker[], o: RunOptions): Promise<TurnOutcome> {
  const settled = await Promise.all(
    workers.map(async (worker, i): Promise<Candidate> => {
      try {
        const result = await worker.run(
          // A different seed per device is the whole mechanism: same prompt,
          // same temperature, genuinely different samples.
          request(o, { seed: i + 1, temperature: o.temperature ?? 0.8 }),
          i === 0 ? o.onToken : () => {},
        )
        o.onStep?.({ step: i, steps: workers.length, label: worker.label, done: true })
        return {
          workerId: worker.id,
          deviceLabel: worker.label,
          text: result.text,
          stats: withDevice(result.stats, worker.label),
        }
      } catch (e) {
        o.onStep?.({ step: i, steps: workers.length, label: worker.label, done: true })
        return {
          workerId: worker.id,
          deviceLabel: worker.label,
          text: '',
          stats: null,
          error: message(e),
        }
      }
    }),
  )

  const good = settled.filter((c) => !c.error && c.text)
  if (!good.length) {
    throw new Error(settled.find((c) => c.error)?.error ?? 'No device produced an answer.')
  }

  // The one that was streamed stays the one on screen, so the text does not
  // change under the reader once the others land — unless that device failed,
  // in which case its half-written or empty stream must be replaced rather than
  // left sitting there under someone else's name.
  const shown = good.find((c) => c.workerId === workers[0].id) ?? good[0]
  return {
    text: shown.text,
    stats: shown.stats,
    interrupted: false,
    deviceLabel: shown.deviceLabel,
    candidates: settled,
    shownIndex: settled.indexOf(shown),
  }
}

/* ── Split the input, then join the answers ───────────────────────────── */

const MAP_SYSTEM =
  'You are reading one part of a longer document. Answer only from the part you are given. Be brief, and keep specifics: names, numbers, dates, quotes.'

const REDUCE_SYSTEM =
  'You are given notes taken from consecutive parts of one document. Write a single answer from them. Do not mention that the document was split, and do not refer to the notes or the parts.'

const DEFAULT_INSTRUCTION = 'Summarise this, keeping the specifics.'

/**
 * Map-reduce over a long input.
 *
 * Chunks are handed out from a queue rather than assigned up front, so a fast
 * laptop takes three parts while a phone takes one instead of everyone waiting
 * on the phone. A chunk whose device fails or vanishes goes back on the queue
 * once; only when nobody can read it does the whole turn fail.
 */
async function runMapReduce(workers: Worker[], o: RunOptions): Promise<TurnOutcome> {
  const { instruction, document } = splitTask(o.content)
  const ask = instruction ?? DEFAULT_INSTRUCTION
  const parts = chunk(document, partsFor(document.length, workers.length))
  const steps = parts.length + 1

  const notes = new Array<string | null>(parts.length).fill(null)
  interface Job { index: number; text: string; failedOn: string[] }
  const queue: Job[] = parts.map((text, index) => ({ index, text, failedOn: [] }))
  const failures: string[] = []
  let stillWorking = workers.length

  o.onStep?.({ step: 0, steps, label: `Reading ${parts.length} parts`, done: false })

  await Promise.all(
    workers.map(async (worker) => {
      try {
        for (;;) {
          if (o.signal?.aborted) return

          // A part this worker already dropped goes to somebody else. Handing it
          // straight back to the device that just failed it is how a retry turns
          // into two identical failures.
          const i = queue.findIndex((j) => !j.failedOn.includes(worker.id))
          const job =
            i >= 0 ? queue.splice(i, 1)[0] : stillWorking === 1 ? queue.shift() : undefined
          if (!job) return

          try {
            const result = await worker.run(
              {
                messages: [
                  { role: 'system', content: MAP_SYSTEM },
                  {
                    role: 'user',
                    content: `Part ${job.index + 1} of ${parts.length}:\n\n${job.text}\n\n---\n${ask}`,
                  },
                ],
                temperature: 0.2,
                maxTokens: 512,
              },
              () => {},
            )
            notes[job.index] = result.text.trim()
            o.onStep?.({
              step: job.index,
              steps,
              label: `${worker.label} read part ${job.index + 1} of ${parts.length}`,
              done: true,
            })
          } catch (e) {
            job.failedOn.push(worker.id)
            if (job.failedOn.length <= 1) queue.push(job)
            else failures.push(`part ${job.index + 1}: ${message(e)}`)
          }
        }
      } finally {
        stillWorking--
      }
    }),
  )

  const read = notes.filter((n): n is string => Boolean(n))
  if (!read.length) {
    throw new Error(`No part of the input could be read. ${failures[0] ?? ''}`.trim())
  }

  const reducer = workers[0]
  o.onStep?.({ step: parts.length, steps, label: `${reducer.label} is writing the answer`, done: false })

  const digest = notes
    .map((n, i) => (n ? `[Part ${i + 1}]\n${n}` : null))
    .filter(Boolean)
    .join('\n\n')

  const result = await reducer.run(
    {
      messages: [
        { role: 'system', content: REDUCE_SYSTEM },
        { role: 'user', content: `${digest}\n\n---\n${ask}` },
      ],
      temperature: o.temperature ?? 0.7,
      maxTokens: o.maxTokens,
    },
    o.onToken,
  )
  o.onStep?.({ step: parts.length, steps, label: 'Done', done: true })

  // A part that could not be read changes the answer, so it is reported rather
  // than silently folded in.
  const text = failures.length
    ? `${result.text}\n\n_(${failures.length} of ${parts.length} parts could not be read: ${failures.join('; ')})_`
    : result.text

  return {
    text,
    stats: withDevice(result.stats, reducer.label),
    interrupted: result.interrupted,
    deviceLabel: `${reducer.label} + ${workers.length - 1} more`,
  }
}

/* ── helpers ──────────────────────────────────────────────────────────── */

function request(o: RunOptions, over: Partial<GenerateRequest>): GenerateRequest {
  return {
    messages: o.messages,
    temperature: o.temperature,
    maxTokens: o.maxTokens,
    ...over,
  }
}

function withDevice(stats: RunStats | null, deviceLabel: string): RunStats | null {
  return stats ? { ...stats, deviceLabel } : null
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
