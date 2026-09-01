import { describe, expect, it, vi } from 'vitest'
import { planTurn, usableWorkers } from './plan'
import { runStrategy } from './run'
import { MAP_MIN_CHARS, chunk, splitTask } from './split'
import type { Strategy, Worker, WorkerResult } from './types'

/**
 * The strategies are written against the `Worker` interface and nothing else,
 * so they can be exercised with fakes that answer instantly — which is what
 * makes the failure paths (a device that dies mid-chunk, a device that is busy,
 * every device failing at once) testable at all.
 */

interface FakeOptions {
  local?: boolean
  modelId?: string | null
  bandwidthGBs?: number
  rttMs?: number
  busy?: boolean
  /** What this worker replies with, given the last user message. */
  reply?: (prompt: string) => string
  /** Fail this many times before succeeding. Infinity to always fail. */
  failures?: number
  /** Fail whenever the prompt matches, however many devices try it. */
  failOn?: RegExp
}

function fake(id: string, o: FakeOptions = {}) {
  let failures = o.failures ?? 0
  const seen: string[] = []

  const worker: Worker = {
    id,
    label: id,
    local: o.local ?? false,
    modelId: o.modelId === undefined ? 'model-a' : o.modelId,
    modelLabel: 'Model A',
    rttMs: o.rttMs ?? 10,
    bandwidthGBs: o.bandwidthGBs ?? 100,
    busy: o.busy ?? false,
    async run(req, onToken): Promise<WorkerResult> {
      const prompt = req.messages.at(-1)?.content ?? ''
      seen.push(prompt)
      if (o.failOn?.test(prompt)) throw new Error(`${id} choked on that part`)
      if (failures > 0) {
        failures--
        throw new Error(`${id} fell over`)
      }
      const text = o.reply ? o.reply(prompt) : `${id}:${req.seed ?? 0}`
      for (const ch of text) onToken(ch)
      return {
        text,
        stats: {
          promptTokens: 10, completionTokens: text.length, ttftMs: 5,
          prefillTokPerSec: 100, decodeTokPerSec: 50, totalMs: 20,
        },
        interrupted: false,
      }
    },
    async interrupt() {},
  }
  return { worker, seen }
}

const LONG = 'A paragraph about turbines and their maintenance schedule. '.repeat(200)

describe('choosing where a turn runs', () => {
  it('ignores devices that are busy or have a different model', () => {
    const usable = usableWorkers(
      [
        fake('busy', { busy: true }).worker,
        fake('other-model', { modelId: 'model-b' }).worker,
        fake('nothing', { modelId: null }).worker,
        fake('fine').worker,
      ],
      'model-a',
    )
    expect(usable.map((w) => w.id)).toEqual(['fine'])
  })

  it('puts the device with the most bandwidth first', () => {
    const usable = usableWorkers(
      [
        fake('phone', { bandwidthGBs: 60 }).worker,
        fake('laptop', { bandwidthGBs: 250, local: true, rttMs: 0 }).worker,
        fake('desktop', { bandwidthGBs: 900 }).worker,
      ],
      'model-a',
    )
    expect(usable.map((w) => w.id)).toEqual(['desktop', 'laptop', 'phone'])
  })

  it('says which is wrong when nothing can take the turn', () => {
    const none = planTurn({ workers: [], modelId: 'model-a', content: 'hi', choice: { kind: 'auto' } })
    expect(none).toMatchObject({ ok: false })
    expect((none as { reason: string }).reason).toMatch(/no device in this fleet has this model/i)

    const busy = planTurn({
      workers: [fake('a', { busy: true }).worker],
      modelId: 'model-a',
      content: 'hi',
      choice: { kind: 'auto' },
    })
    expect((busy as { reason: string }).reason).toMatch(/busy/i)
  })
})

describe('the claims a plan is allowed to make', () => {
  it('never says sending a turn to another device is faster', () => {
    const plan = planTurn({
      workers: [fake('here', { local: true, rttMs: 0 }).worker, fake('there').worker],
      modelId: 'model-a',
      content: 'hi',
      choice: { kind: 'single', workerId: 'there' },
    })
    expect(plan.ok).toBe(true)
    const s = (plan as { strategy: Strategy }).strategy
    expect(s.caveats.join(' ')).toMatch(/running it here would be faster/i)
    expect(s.why).not.toMatch(/faster|sooner|quicker/i)
  })

  it('says out loud that best-of-n does not shorten the wait', () => {
    const plan = planTurn({
      workers: [fake('a').worker, fake('b').worker, fake('c').worker],
      modelId: 'model-a',
      content: 'hi',
      choice: { kind: 'best-of-n' },
    })
    const s = (plan as { strategy: Strategy }).strategy
    expect(s.workers).toHaveLength(3)
    expect(s.caveats.join(' ')).toMatch(/does not make a reply arrive any sooner/i)
  })

  it('refuses best-of-n on a single device instead of pretending', () => {
    const plan = planTurn({
      workers: [fake('only', { local: true }).worker],
      modelId: 'model-a',
      content: 'hi',
      choice: { kind: 'best-of-n' },
    })
    expect(plan.ok).toBe(false)
    expect((plan as { reason: string }).reason).toMatch(/needs a second device/i)
  })

  it('refuses to split an input too short to be worth splitting', () => {
    const plan = planTurn({
      workers: [fake('a').worker, fake('b').worker],
      modelId: 'model-a',
      content: 'What is a turbine?',
      choice: { kind: 'map-reduce' },
    })
    expect(plan.ok).toBe(false)
    expect((plan as { reason: string }).reason).toMatch(/only pays off past/i)
  })

  it('refuses to split across one device, where the parts would be sequential', () => {
    const plan = planTurn({
      workers: [fake('only', { local: true }).worker],
      modelId: 'model-a',
      content: `Summarise this.\n\n${LONG}`,
      choice: { kind: 'map-reduce' },
    })
    expect(plan.ok).toBe(false)
    expect((plan as { reason: string }).reason).toMatch(/needs a second device/i)
  })

  it('is the one arrangement allowed to claim a sooner answer, and only when the work is independent', () => {
    const plan = planTurn({
      workers: [fake('a').worker, fake('b').worker],
      modelId: 'model-a',
      content: `Summarise this.\n\n${LONG}`,
      choice: { kind: 'map-reduce' },
    })
    const s = (plan as { strategy: Strategy }).strategy
    expect(s.kind).toBe('map-reduce')
    expect(s.why).toMatch(/genuinely makes a long input finish sooner/i)
  })

  it('counts the parts the run will really use, rather than one per device', () => {
    const twoDevices = [fake('a').worker, fake('b').worker]
    const short = planTurn({
      workers: twoDevices, modelId: 'model-a',
      content: `Summarise this.\n\n${LONG}`, choice: { kind: 'map-reduce' },
    })
    expect((short as { strategy: Strategy }).strategy.why).toMatch(/cut into 2 parts.*one each/i)

    // Four times the document, same two devices: more parts than devices, so
    // the promise changes from "one each" to "next one as they finish".
    const long = planTurn({
      workers: twoDevices, modelId: 'model-a',
      content: `Summarise this.\n\n${LONG.repeat(4)}`, choice: { kind: 'map-reduce' },
    })
    const why = (long as { strategy: Strategy }).strategy.why
    expect(why).toMatch(/cut into 8 parts/)
    expect(why).toMatch(/as they finish/)
    expect(why).not.toMatch(/one each/)
  })
})

describe('choosing on its own', () => {
  it('splits a long input when there is a second device', () => {
    const plan = planTurn({
      workers: [fake('a', { local: true }).worker, fake('b').worker],
      modelId: 'model-a',
      content: `Summarise this.\n\n${LONG}`,
      choice: { kind: 'auto' },
    })
    expect((plan as { strategy: Strategy }).strategy.kind).toBe('map-reduce')
  })

  it('runs a short turn on one device rather than spending the fleet on it', () => {
    const plan = planTurn({
      workers: [fake('a', { local: true, bandwidthGBs: 300 }).worker, fake('b').worker],
      modelId: 'model-a',
      content: 'hi',
      choice: { kind: 'auto' },
    })
    const s = (plan as { strategy: Strategy }).strategy
    expect(s.kind).toBe('single')
    expect(s.workers.map((w) => w.id)).toEqual(['a'])
  })

  it('never reaches for extra samples unasked', () => {
    const plan = planTurn({
      workers: [fake('a').worker, fake('b').worker, fake('c').worker],
      modelId: 'model-a',
      content: 'hi',
      choice: { kind: 'auto' },
    })
    expect((plan as { strategy: Strategy }).strategy.kind).not.toBe('best-of-n')
  })
})

describe('splitting a message into a task', () => {
  it('takes an instruction off the top', () => {
    const { instruction, document } = splitTask(`Summarise this.\n\n${LONG}`)
    expect(instruction).toBe('Summarise this.')
    expect(document.startsWith('A paragraph')).toBe(true)
  })

  it('takes an instruction off the bottom', () => {
    const { instruction, document } = splitTask(`${LONG}\n\nSo what breaks first?`)
    expect(instruction).toBe('So what breaks first?')
    expect(document).not.toMatch(/breaks first/)
  })

  it('treats a message with no short paragraph as all document', () => {
    const { instruction, document } = splitTask(LONG)
    expect(instruction).toBeNull()
    expect(document.length).toBeGreaterThan(MAP_MIN_CHARS)
  })
})

describe('cutting a document up', () => {
  it('produces as many parts as asked and loses nothing', () => {
    const doc = Array.from({ length: 12 }, (_, i) => `Paragraph ${i} says something.`).join('\n\n')
    const parts = chunk(doc, 4)
    expect(parts).toHaveLength(4)
    for (let i = 0; i < 12; i++) expect(parts.join(' ')).toContain(`Paragraph ${i} `)
  })

  it('never leaves a device with an empty part', () => {
    const doc = Array.from({ length: 9 }, (_, i) => `p${i}`).join('\n\n')
    for (const parts of [2, 3, 4]) {
      expect(chunk(doc, parts).every((p) => p.trim().length > 0)).toBe(true)
    }
  })

  it('falls back to sentences, then words, when there are no paragraphs', () => {
    expect(chunk('One. Two. Three. Four.', 2)).toHaveLength(2)
    expect(chunk('alpha beta gamma delta', 2)).toHaveLength(2)
  })

  it('gives back fewer parts than asked rather than inventing empty ones', () => {
    expect(chunk('just one thing', 9).length).toBeLessThanOrEqual(3)
    expect(chunk('', 3)).toEqual([])
  })
})

describe('running a turn', () => {
  const base = { messages: [{ role: 'user' as const, content: 'hello' }], content: 'hello' }

  it('streams the answer from a single device and names it', async () => {
    const { worker } = fake('laptop', { local: true })
    const seen: string[] = []
    const out = await runStrategy(
      { kind: 'single', workers: [worker], why: '', caveats: [] },
      { ...base, onToken: (d) => seen.push(d) },
    )
    expect(out.text).toBe('laptop:0')
    expect(seen.join('')).toBe('laptop:0')
    expect(out.deviceLabel).toBe('laptop')
    expect(out.stats?.deviceLabel).toBe('laptop')
  })

  it('draws one sample per device, with a different seed each', async () => {
    const a = fake('a')
    const b = fake('b')
    const out = await runStrategy(
      { kind: 'best-of-n', workers: [a.worker, b.worker], why: '', caveats: [] },
      { ...base, onToken: () => {} },
    )
    expect(out.candidates?.map((c) => c.text)).toEqual(['a:1', 'b:2'])
    // The one that was streamed is the one left on screen.
    expect(out.text).toBe('a:1')
  })

  it('streams only one candidate, so the transcript stays readable', async () => {
    const seen: string[] = []
    await runStrategy(
      { kind: 'best-of-n', workers: [fake('a').worker, fake('b').worker], why: '', caveats: [] },
      { ...base, onToken: (d) => seen.push(d) },
    )
    expect(seen.join('')).toBe('a:1')
  })

  it('keeps the samples that worked when one device fails', async () => {
    const out = await runStrategy(
      {
        kind: 'best-of-n',
        workers: [fake('a').worker, fake('b', { failures: Infinity }).worker],
        why: '', caveats: [],
      },
      { ...base, onToken: () => {} },
    )
    expect(out.text).toBe('a:1')
    expect(out.shownIndex).toBe(0)
    expect(out.candidates?.[1].error).toMatch(/fell over/)
  })

  it('falls back to a sample that worked when the streamed one dies', async () => {
    const streamed: string[] = []
    const out = await runStrategy(
      {
        kind: 'best-of-n',
        // The first worker is the one whose tokens reach the transcript, and it
        // is the one that fails. Leaving its empty stream on screen under
        // another device's name is the failure this guards against.
        workers: [fake('a', { failures: Infinity }).worker, fake('b').worker],
        why: '', caveats: [],
      },
      { ...base, onToken: (d) => streamed.push(d) },
    )
    expect(streamed).toHaveLength(0)
    expect(out.text).toBe('b:2')
    expect(out.deviceLabel).toBe('b')
    // Points at b, so the transcript highlights the sample it is showing rather
    // than the struck-through one that failed.
    expect(out.shownIndex).toBe(1)
  })

  it('fails with the device error when every sample fails', async () => {
    await expect(
      runStrategy(
        {
          kind: 'best-of-n',
          workers: [fake('a', { failures: Infinity }).worker, fake('b', { failures: Infinity }).worker],
          why: '', caveats: [],
        },
        { ...base, onToken: () => {} },
      ),
    ).rejects.toThrow(/fell over/)
  })
})

describe('map-reduce over a long input', () => {
  const content = `Summarise this.\n\n${LONG}`
  const strategy = (workers: Worker[]): Strategy => ({
    kind: 'map-reduce', workers, why: '', caveats: [],
  })

  /** Answers with the part number it was given, so assignment is observable. */
  const noteTaker = (id: string) =>
    fake(id, {
      reply: (prompt) => {
        const part = prompt.match(/^Part (\d+) of/)?.[1]
        return part ? `note-${part}` : `answer(${prompt.match(/note-\d+/g)?.join(',')})`
      },
    })

  it('reads every part and writes one answer from the notes', async () => {
    const a = noteTaker('a')
    const b = noteTaker('b')
    const seen: string[] = []
    const out = await runStrategy(strategy([a.worker, b.worker]), {
      messages: [], content, onToken: (d) => seen.push(d),
    })

    expect(out.text).toBe('answer(note-1,note-2)')
    // Only the final pass is streamed; the parts are read silently.
    expect(seen.join('')).toBe('answer(note-1,note-2)')
    expect(out.deviceLabel).toBe('a + 1 more')
  })

  it('hands out chunks from a queue, so a fast device takes more of them', async () => {
    // Four parts between two devices, one of which answers instantly.
    const fast = noteTaker('fast')
    const slow = noteTaker('slow')
    const slowRun = slow.worker.run.bind(slow.worker)
    slow.worker.run = async (req, onToken) => {
      await new Promise((r) => setTimeout(r, 30))
      return slowRun(req, onToken)
    }

    await runStrategy(strategy([fast.worker, slow.worker]), {
      messages: [], content: `Summarise this.\n\n${LONG}${LONG}`, onToken: () => {},
    })

    const partsRead = (w: { seen: string[] }) => w.seen.filter((p) => p.startsWith('Part ')).length
    // An up-front split would have given each device two. The queue gives the
    // slow one exactly what it can manage and the fast one the rest.
    expect(partsRead(fast)).toBe(3)
    expect(partsRead(slow)).toBe(1)
  })

  it('retries a dropped part on a different device, not the one that dropped it', async () => {
    const flaky = fake('flaky', { failures: 1, reply: (p) => `note-${p.match(/^Part (\d+)/)?.[1]}` })
    const steady = noteTaker('steady')
    const out = await runStrategy(strategy([steady.worker, flaky.worker]), {
      messages: [], content, onToken: () => {},
    })
    expect(out.text).toMatch(/note-1/)
    expect(out.text).toMatch(/note-2/)
    expect(out.text).not.toMatch(/could not be read/)
  })

  it('says so in the answer when no device could read a part', async () => {
    const a = fake('a', { failOn: /^Part 2 /, reply: (p) => `note-${p.match(/^Part (\d+)/)?.[1]}` })
    const b = fake('b', { failOn: /^Part 2 /, reply: (p) => `note-${p.match(/^Part (\d+)/)?.[1]}` })
    const out = await runStrategy(strategy([a.worker, b.worker]), {
      messages: [], content, onToken: () => {},
    })
    expect(out.text).toMatch(/1 of 2 parts could not be read/)
    expect(out.text).toMatch(/choked on that part/)
  })

  it('fails loudly when nothing could be read', async () => {
    await expect(
      runStrategy(strategy([fake('a', { failures: Infinity }).worker, fake('b', { failures: Infinity }).worker]), {
        messages: [], content, onToken: () => {},
      }),
    ).rejects.toThrow(/no part of the input could be read/i)
  })

  it('reports each part as it lands, and the final pass separately', async () => {
    const onStep = vi.fn()
    await runStrategy(strategy([noteTaker('a').worker, noteTaker('b').worker]), {
      messages: [], content, onToken: () => {}, onStep,
    })
    const labels = onStep.mock.calls.map((c) => c[0].label)
    expect(labels[0]).toMatch(/Reading 2 parts/)
    expect(labels.some((l: string) => /read part 1/.test(l))).toBe(true)
    expect(labels.some((l: string) => /writing the answer/.test(l))).toBe(true)
  })
})
