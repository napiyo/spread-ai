import { describe, expect, it, vi } from 'vitest'
import { Mesh, type MeshPeer } from './mesh'
import { remoteWorker } from './remoteWorker'
import { serveWork, type ServeEngine } from './serve'
import type { Envelope } from './protocol'
import type { Signaler } from './transport'
import { runStrategy } from '@/strategies'
import type { Capability } from '@/capability/identify'
import type { GenerateResult } from '@/runtime/types'

/**
 * Running a turn on another device, end to end.
 *
 * Two real `Mesh` objects with their data channels replaced by direct delivery
 * into each other. Everything between — RPC framing, run ids, token events, the
 * worker the strategies see — is the code that ships. Only the WebRTC transport
 * is fake, and it is fake because Node has none, not because it is inconvenient.
 */

class FakeSignaler implements Signaler {
  readonly kind = 'ws' as const
  onSignal?: (from: string, payload: unknown) => void
  onPeerLeft?: (id: string) => void
  constructor(readonly peerId: string) {}
  async connect() {}
  send() {}
  close() {}
}

const CAP = { deviceId: 'd', label: 'Studio', bandwidthGBs: 400 } as unknown as Capability
const MODEL = { id: 'Llama-3.2-1B', label: 'Llama 3.2 1B', contextWindow: 4096 }

/** Delivers whatever one mesh sends straight into the other. */
function wire(to: Mesh, senderId: string, lost = { value: false }) {
  return {
    id: senderId,
    state: 'connected' as const,
    rttMs: 8,
    send(env: Envelope) {
      if (lost.value) return false
      queueMicrotask(() =>
        void (to as unknown as { onEnvelope: (f: string, e: Envelope) => Promise<void> })
          .onEnvelope(senderId, env),
      )
      return true
    },
    notePong() {},
    close() {},
    get bytes() {
      return { sent: 0, received: 0 }
    },
  }
}

interface FakeEngine extends ServeEngine {
  /** Resolves the generation that is currently waiting, if it was paused. */
  release?: () => void
}

function fakeEngine(over: Partial<ServeEngine> & { chunks?: string[]; hold?: boolean } = {}) {
  let interrupted = false
  let release = () => {}
  const engine: FakeEngine = {
    deviceLabel: 'Studio',
    loadedModelId: MODEL.id,
    loadedModelLabel: MODEL.label,
    busy: false,
    async generate(_params, onToken): Promise<GenerateResult | null> {
      const chunks = over.chunks ?? ['Hel', 'lo ', 'there']
      if (over.hold) await new Promise<void>((r) => (release = r))
      for (const c of chunks) {
        if (interrupted) break
        onToken(c)
      }
      const text = chunks.join('')
      return {
        text,
        stats: {
          promptTokens: 4, completionTokens: 3, ttftMs: 12,
          prefillTokPerSec: 300, decodeTokPerSec: 42, totalMs: 90,
        },
        interrupted,
      }
    },
    lastError: () => null,
    interrupt: () => {
      interrupted = true
    },
    capability: () => CAP,
    ...over,
  }
  engine.release = () => release()
  return engine
}

/** An asker and a server, already introduced. */
function pair(engine: ServeEngine) {
  const asker = new Mesh(new FakeSignaler('asker'), { label: 'Laptop', capability: CAP })
  const server = new Mesh(new FakeSignaler('server'), {
    label: 'Studio', capability: CAP, loaded: MODEL,
  })
  serveWork(server, () => engine)

  const lost = { value: false }
  const peers = (m: Mesh) => (m as unknown as { peers: Map<string, unknown> }).peers
  const infos = (m: Mesh) => (m as unknown as { info: Map<string, unknown> }).info

  peers(asker).set('server', wire(server, 'asker', lost))
  peers(server).set('asker', wire(asker, 'server', lost))
  infos(asker).set('server', {
    peerId: 'server', label: 'Studio', capability: CAP, loaded: MODEL, rttMs: 8, joinedAt: 0,
  })
  infos(server).set('asker', {
    peerId: 'asker', label: 'Laptop', capability: CAP, loaded: null, rttMs: 8, joinedAt: 0,
  })

  const peer = asker.list().find((p) => p.peerId === 'server') as MeshPeer
  return { asker, server, worker: remoteWorker(asker, peer), lost }
}

const TURN = {
  messages: [{ role: 'user' as const, content: 'hi' }],
  content: 'hi',
}

describe('running a turn on another device', () => {
  it('streams the tokens back as they are written, and names the device', async () => {
    const { worker } = pair(fakeEngine())
    const seen: string[] = []

    const out = await runStrategy(
      { kind: 'single', workers: [worker], why: '', caveats: [] },
      { ...TURN, onToken: (d) => seen.push(d) },
    )

    expect(seen).toEqual(['Hel', 'lo ', 'there'])
    expect(out.text).toBe('Hello there')
    expect(out.deviceLabel).toBe('Studio')
    // The measurement is attributed to the device that actually did the work,
    // which is what stops it recalibrating the wrong machine's roofline.
    expect(out.stats?.deviceLabel).toBe('Studio')
    expect(out.stats?.decodeTokPerSec).toBe(42)
  })

  it('does not leak one run\'s tokens into another', async () => {
    const { asker, worker } = pair(fakeEngine())
    const seen: string[] = []

    // A device shouting about a run nobody here started must be ignored.
    const inject = (asker as unknown as {
      onEnvelope: (f: string, e: Envelope) => Promise<void>
    }).onEnvelope.bind(asker)
    await inject('server', { k: 'ev', topic: 'gen', data: { runId: 'not-ours', delta: 'XXX' } })

    await runStrategy(
      { kind: 'single', workers: [worker], why: '', caveats: [] },
      { ...TURN, onToken: (d) => seen.push(d) },
    )
    expect(seen.join('')).toBe('Hello there')
  })

  it('refuses a model it does not have, by name', async () => {
    const { asker } = pair(fakeEngine())
    const peer = { ...asker.list()[0], loaded: { ...MODEL, id: 'Qwen-7B' } } as MeshPeer
    const worker = remoteWorker(asker, peer)

    await expect(worker.run({ messages: [] }, () => {})).rejects.toThrow(
      /Studio has Llama 3.2 1B loaded, not Qwen-7B/,
    )
  })

  it('refuses a second turn while it is still writing the first', async () => {
    const engine = fakeEngine({ hold: true })
    const { worker } = pair(engine)

    const first = worker.run({ messages: [] }, () => {})
    await new Promise((r) => setTimeout(r, 0))
    await expect(worker.run({ messages: [] }, () => {})).rejects.toThrow(/busy with another reply/)

    engine.release?.()
    await expect(first).resolves.toMatchObject({ text: 'Hello there' })
  })

  it('passes the reason a generation failed back to the asker', async () => {
    const { worker } = pair(
      fakeEngine({
        generate: async () => null,
        lastError: () => 'Ran out of GPU memory.',
      }),
    )
    await expect(worker.run({ messages: [] }, () => {})).rejects.toThrow(/Ran out of GPU memory/)
  })

  it('stops the run it was asked to stop, and only that one', async () => {
    const engine = fakeEngine({ hold: true })
    const { asker, worker } = pair(engine)
    const interrupt = vi.spyOn(engine, 'interrupt')

    const running = worker.run({ messages: [] }, () => {})
    await new Promise((r) => setTimeout(r, 0))

    // A stop naming a run that is not the live one must not touch it — this is
    // the difference between cancelling your own reply and cancelling one that
    // the owner of that device started a moment later.
    await expect(asker.call('server', 'interrupt', { runId: 'someone-elses' })).resolves.toBe(false)
    expect(interrupt).not.toHaveBeenCalled()

    await worker.interrupt()
    expect(interrupt).toHaveBeenCalled()

    engine.release?.()
    await running
  })

  it('fails the turn rather than hanging when the device goes away mid-reply', async () => {
    const engine = fakeEngine({ hold: true })
    const { asker, worker } = pair(engine)

    const running = worker.run({ messages: [] }, () => {})
    await new Promise((r) => setTimeout(r, 0))
    ;(asker as unknown as { drop: (id: string) => void }).drop('server')

    await expect(running).rejects.toThrow(/left the mesh/)
  })
})

describe('several devices at once', () => {
  it('draws a sample from each and keeps the ones that worked', async () => {
    const a = pair(fakeEngine({ deviceLabel: 'Studio', chunks: ['from studio'] }))
    const b = pair(
      fakeEngine({ deviceLabel: 'Mini', generate: async () => null, lastError: () => 'GPU busy' }),
    )

    const out = await runStrategy(
      { kind: 'best-of-n', workers: [a.worker, b.worker], why: '', caveats: [] },
      { ...TURN, onToken: () => {} },
    )

    expect(out.text).toBe('from studio')
    expect(out.candidates?.[1].error).toMatch(/GPU busy/)
  })
})
