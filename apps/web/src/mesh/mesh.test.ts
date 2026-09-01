import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { Mesh } from './mesh'
import { generateRoomCode, normaliseRoomCode, type Signaler } from './transport'
import type { Envelope } from './protocol'
import type { Capability } from '@/capability/identify'

/**
 * The mesh is tested against a fake transport rather than real WebRTC.
 *
 * That is not a shortcut: the parts worth testing here are the RPC framing,
 * the timeout and failure paths, and what happens to in-flight work when a
 * device vanishes — all of which are pure logic sitting above the transport.
 */

class FakeSignaler implements Signaler {
  readonly kind = 'ws' as const
  onPeerJoined?: (id: string) => void
  onPeerLeft?: (id: string) => void
  onExistingPeers?: (ids: string[]) => void
  onSignal?: (from: string, payload: unknown) => void
  sent: { to: string; payload: unknown }[] = []

  constructor(readonly peerId: string) {}
  async connect() {}
  send(to: string, payload: unknown) {
    this.sent.push({ to, payload })
  }
  close() {}
}

const CAP = { deviceId: 'me', label: 'Test Mac', bandwidthGBs: 200 } as unknown as Capability

/**
 * Wires a Mesh to a fake peer whose data channel we control, so we can drive
 * envelopes in both directions without a real RTCPeerConnection.
 */
function meshWithFakePeer(peerId = 'other') {
  const signaler = new FakeSignaler('self')
  const mesh = new Mesh(signaler, { label: 'Test Mac', capability: CAP })

  const outbound: Envelope[] = []
  const fake = {
    id: peerId,
    state: 'connected' as const,
    rttMs: null as number | null,
    send(env: Envelope) {
      outbound.push(env)
      return true
    },
    notePong(t: number) {
      this.rttMs = performance.now() - t
    },
    close() {},
    get bytes() {
      return { sent: 0, received: 0 }
    },
  }
  // The peer map is the seam: injecting here exercises everything above the
  // transport without pretending to test WebRTC itself.
  ;(mesh as unknown as { peers: Map<string, unknown> }).peers.set(peerId, fake)
  ;(mesh as unknown as { info: Map<string, unknown> }).info.set(peerId, {
    peerId, label: 'Their Phone', capability: CAP, rttMs: null, joinedAt: 0,
  })

  const deliver = (env: Envelope) =>
    (mesh as unknown as { onEnvelope: (f: string, e: Envelope) => Promise<void> }).onEnvelope(
      peerId,
      env,
    )

  return { mesh, signaler, outbound, deliver, peerId }
}

/**
 * Node has no WebRTC. The one test below that lets Mesh construct real Peer
 * objects only cares about *which* peers got dialled, so the connection itself
 * is stubbed out. Everything else injects a fake peer and never reaches this.
 */
class StubPeerConnection {
  connectionState = 'new'
  localDescription = null
  onicecandidate: unknown = null
  onconnectionstatechange: unknown = null
  ondatachannel: unknown = null
  createDataChannel() {
    return { close() {}, send() {}, readyState: 'connecting', label: 'sai-control' }
  }
  async createOffer() {
    return { type: 'offer', sdp: '' }
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  close() {}
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.stubGlobal('RTCPeerConnection', StubPeerConnection)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('room codes', () => {
  it('avoids characters people confuse when reading a code aloud', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateRoomCode()).not.toMatch(/[OI1L0UV]/)
    }
  })

  it('accepts a code however it was typed', () => {
    expect(normaliseRoomCode(' m4q-gge ')).toBe('M4QGGE')
  })
})

describe('rpc', () => {
  it('carries a result back to the caller', async () => {
    const { mesh, outbound, deliver } = meshWithFakePeer()
    const promise = mesh.call('other', 'capability')
    const req = outbound.at(-1) as Extract<Envelope, { k: 'req' }>
    expect(req.method).toBe('capability')

    await deliver({ k: 'res', id: req.id, ok: true, result: { ok: 1 } })
    await expect(promise).resolves.toEqual({ ok: 1 })
  })

  it('rejects with the remote error message, not a generic one', async () => {
    const { mesh, outbound, deliver } = meshWithFakePeer()
    const promise = mesh.call('other', 'generate')
    const req = outbound.at(-1) as Extract<Envelope, { k: 'req' }>
    await deliver({ k: 'res', id: req.id, ok: false, error: 'No model is loaded on that device.' })
    await expect(promise).rejects.toThrow('No model is loaded on that device.')
  })

  it('answers an unknown method rather than leaving the caller hanging', async () => {
    const { outbound, deliver } = meshWithFakePeer()
    await deliver({ k: 'req', id: 7, method: 'nonsense', params: null })
    const res = outbound.at(-1) as Extract<Envelope, { k: 'res' }>
    expect(res).toMatchObject({ k: 'res', id: 7, ok: false })
    expect((res as { error: string }).error).toMatch(/doesn't know how to "nonsense"/)
  })

  it('reports a handler that throws instead of dropping the request', async () => {
    const { mesh, outbound, deliver } = meshWithFakePeer()
    mesh.handle('boom', () => {
      throw new Error('GPU is busy')
    })
    await deliver({ k: 'req', id: 9, method: 'boom', params: null })
    expect(outbound.at(-1)).toMatchObject({ k: 'res', id: 9, ok: false, error: 'GPU is busy' })
  })

  it('names the device when one stops answering', async () => {
    const { mesh } = meshWithFakePeer()
    const promise = mesh.call('other', 'generate')
    const assertion = expect(promise).rejects.toThrow(/Their Phone did not answer in time/)
    await vi.advanceTimersByTimeAsync(31_000)
    await assertion
  })

  it('refuses to call a device that is not connected', async () => {
    const { mesh } = meshWithFakePeer()
    await expect(mesh.call('nobody', 'capability')).rejects.toThrow(/not connected/)
  })
})

describe('a device leaving', () => {
  it('fails in-flight work immediately rather than after a timeout', async () => {
    const { mesh, signaler } = meshWithFakePeer()
    const promise = mesh.call('other', 'generate')
    const assertion = expect(promise).rejects.toThrow(/left the mesh/)
    signaler.onPeerLeft?.('other')
    await assertion
    expect(mesh.list()).toHaveLength(0)
  })
})

describe('capability gossip', () => {
  it('adopts a peer label and capability from its hello', async () => {
    const { mesh, deliver } = meshWithFakePeer()
    await deliver({
      k: 'hello',
      info: { peerId: 'other', label: 'iPhone 17 Pro', capability: CAP, loaded: null },
    })
    expect(mesh.list()[0].label).toBe('iPhone 17 Pro')
    expect(mesh.labelOf('other')).toBe('iPhone 17 Pro')
  })

  it('answers a ping so the other side can measure the link', async () => {
    const { outbound, deliver } = meshWithFakePeer()
    await deliver({ k: 'ping', t: 1234 })
    expect(outbound.at(-1)).toEqual({ k: 'pong', t: 1234 })
  })

  it('carries which model a device has loaded, so the chat knows who can serve', async () => {
    const { mesh, deliver } = meshWithFakePeer()
    await deliver({
      k: 'hello',
      info: {
        peerId: 'other', label: 'Studio', capability: CAP,
        loaded: { id: 'Llama-3.2-1B', label: 'Llama 3.2 1B', contextWindow: 4096 },
      },
    })
    expect(mesh.list()[0].loaded?.id).toBe('Llama-3.2-1B')
  })

  it('keeps the measured round trip when a device re-announces itself', async () => {
    const { mesh, deliver } = meshWithFakePeer()
    await deliver({ k: 'ping', t: 0 })
    await deliver({ k: 'pong', t: performance.now() - 12 })
    const before = mesh.list()[0].rttMs
    expect(before).not.toBeNull()

    // Loading a model re-sends hello. Treating that as a brand new peer would
    // throw away everything we measured about the link.
    await deliver({
      k: 'hello',
      info: {
        peerId: 'other', label: 'Studio', capability: CAP,
        loaded: { id: 'Llama-3.2-1B', label: 'Llama 3.2 1B', contextWindow: 4096 },
      },
    })
    expect(mesh.list()[0].rttMs).toBe(before)
  })
})

describe('events', () => {
  it('sends a token stream to the one device that asked, not the room', () => {
    const { mesh, outbound } = meshWithFakePeer()
    mesh.emit('other', 'gen', { runId: 'r1', delta: 'hi' })
    expect(outbound.at(-1)).toEqual({ k: 'ev', topic: 'gen', data: { runId: 'r1', delta: 'hi' } })

    // Nothing goes anywhere when that device is gone, and it does not throw.
    expect(mesh.emit('nobody', 'gen', { runId: 'r1', delta: 'hi' })).toBe(false)
  })

  it('delivers an event to its subscribers with the sender attached', async () => {
    const { mesh, deliver } = meshWithFakePeer()
    const seen: [unknown, string][] = []
    mesh.subscribe('gen', (data, from) => seen.push([data, from]))
    await deliver({ k: 'ev', topic: 'gen', data: { runId: 'r1', delta: 'hi' } })
    expect(seen).toEqual([[{ runId: 'r1', delta: 'hi' }, 'other']])
  })
})

describe('per-call deadlines', () => {
  it('lets a generation run far longer than a question about hardware', async () => {
    const { mesh } = meshWithFakePeer()
    const quick = mesh.call('other', 'capability')
    const long = mesh.call('other', 'generate', {}, { timeoutMs: 600_000 })
    const quickFails = expect(quick).rejects.toThrow(/did not answer in time/)

    await vi.advanceTimersByTimeAsync(31_000)
    await quickFails

    // The generation is still going at the point the default would have killed it.
    let settled = false
    void long.catch(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    const longFails = expect(long).rejects.toThrow(/did not answer in time/)
    await vi.advanceTimersByTimeAsync(600_000)
    await longFails
  })
})

describe('newcomers place the calls', () => {
  it('dials peers that were already in the room, and waits for later arrivals', () => {
    const signaler = new FakeSignaler('self')
    const mesh = new Mesh(signaler, { label: 'Test Mac', capability: CAP })
    const peers = () => (mesh as unknown as { peers: Map<string, unknown> }).peers

    // Whoever arrives last dials everyone present. The peers already there do
    // nothing, which is what stops both sides offering at once.
    signaler.onExistingPeers?.(['a', 'b'])
    expect([...peers().keys()].sort()).toEqual(['a', 'b'])

    signaler.onPeerJoined?.('c')
    expect(peers().has('c')).toBe(false)
  })
})
