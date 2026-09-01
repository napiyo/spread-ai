import { Peer, type PeerState } from './peer'
import type { Signaler, SignalState } from './transport'
import type { Envelope, PeerInfo } from './protocol'
import type { Capability } from '@/capability/identify'

export interface MeshPeer extends PeerInfo {
  state: PeerState
  /** Bytes per second right now, for driving the beams. */
  throughput: number
}

export type RpcHandler = (params: unknown, from: string) => unknown | Promise<unknown>

const RPC_TIMEOUT_MS = 30_000

/**
 * The device mesh.
 *
 * Signaling introduces peers; after that every byte — capability gossip, CRDT
 * updates, prompts, tokens, model weights, hidden states — travels directly
 * between browsers over encrypted data channels.
 *
 * Topology is a full mesh rather than a star. It costs a few more connections
 * but means no single device's departure partitions the others, which matters
 * when the "server" is somebody's phone that might ring.
 */
export class Mesh {
  private peers = new Map<string, Peer>()
  private info = new Map<string, PeerInfo>()
  private handlers = new Map<string, RpcHandler>()
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private subscribers = new Map<string, Set<(data: unknown, from: string) => void>>()
  private seq = 0
  private trafficWindow = new Map<string, { bytes: number; since: number }>()

  onChange?: () => void
  onSignalState?: (s: SignalState) => void
  onError?: (message: string) => void

  constructor(
    private readonly signaler: Signaler,
    private self: { label: string; capability: Capability },
  ) {
    signaler.onStateChange = (s) => this.onSignalState?.(s)
    signaler.onExistingPeers = (ids) => {
      // We arrived last, so we place the calls. Whoever was already here waits
      // to be called — that alone prevents both sides offering at once.
      for (const id of ids) void this.dial(id, true)
    }
    signaler.onPeerJoined = () => this.onChange?.()
    signaler.onPeerLeft = (id) => this.drop(id)
    signaler.onSignal = (from, payload) => void this.onSignal(from, payload)
  }

  get peerId() {
    return this.signaler.peerId
  }

  async connect() {
    await this.signaler.connect()
  }

  private ensure(id: string, initiator: boolean): Peer {
    const existing = this.peers.get(id)
    if (existing) return existing

    const peer = new Peer(
      id,
      {
        onState: (state) => {
          if (state === 'connected') this.sayHello(id)
          if (state === 'closed' || state === 'failed') this.drop(id)
          this.onChange?.()
        },
        onFailure: (reason) => this.onError?.(reason),
        onEnvelope: (env) => void this.onEnvelope(id, env),
        onSignal: (payload) => this.signaler.send(id, payload),
        onTraffic: (sent, received) => this.noteTraffic(id, sent + received),
      },
      !initiator,
    )
    this.peers.set(id, peer)
    return peer
  }

  private async dial(id: string, initiator: boolean) {
    const peer = this.ensure(id, initiator)
    if (initiator) await peer.createOffer()
    this.onChange?.()
  }

  private async onSignal(from: string, payload: unknown) {
    // A signal from someone we have not dialled means they are calling us.
    const peer = this.ensure(from, false)
    try {
      await peer.handleSignal(payload)
    } catch (e) {
      // Swallowing this silently made a failed handshake look like a peer that
      // simply never answered, which is the hardest kind of bug to find.
      const message = e instanceof Error ? e.message : String(e)
      console.warn(`[mesh] handshake with ${from} failed:`, message)
      this.onError?.(`Could not complete the connection to ${this.labelOf(from)}: ${message}`)
    }
  }

  private sayHello(id: string) {
    this.peers.get(id)?.send({
      k: 'hello',
      info: {
        peerId: this.signaler.peerId,
        label: this.self.label,
        capability: this.self.capability,
      },
    })
  }

  private noteTraffic(id: string, bytes: number) {
    const now = performance.now()
    const w = this.trafficWindow.get(id)
    if (!w || now - w.since > 1000) this.trafficWindow.set(id, { bytes, since: now })
    else w.bytes += bytes
  }

  private async onEnvelope(from: string, env: Envelope) {
    switch (env.k) {
      case 'hello': {
        this.info.set(from, { ...env.info, rttMs: null, joinedAt: Date.now() })
        this.onChange?.()
        break
      }
      case 'ping':
        this.peers.get(from)?.send({ k: 'pong', t: env.t }, true)
        break
      case 'pong': {
        const peer = this.peers.get(from)
        peer?.notePong(env.t)
        const info = this.info.get(from)
        if (info && peer) info.rttMs = peer.rttMs
        this.onChange?.()
        break
      }
      case 'req': {
        const handler = this.handlers.get(env.method)
        if (!handler) {
          this.peers.get(from)?.send({
            k: 'res', id: env.id, ok: false,
            error: `This device doesn't know how to "${env.method}".`,
          })
          return
        }
        try {
          const result = await handler(env.params, from)
          this.peers.get(from)?.send({ k: 'res', id: env.id, ok: true, result })
        } catch (e) {
          this.peers.get(from)?.send({
            k: 'res', id: env.id, ok: false,
            error: e instanceof Error ? e.message : String(e),
          })
        }
        break
      }
      case 'res': {
        const p = this.pending.get(env.id)
        if (!p) return
        clearTimeout(p.timer)
        this.pending.delete(env.id)
        if (env.ok) p.resolve(env.result)
        else p.reject(new Error(env.error))
        break
      }
      case 'ev':
      case 'y': {
        const topic = env.k === 'y' ? 'y' : env.topic
        const data = env.k === 'y' ? env.b64 : env.data
        for (const fn of this.subscribers.get(topic) ?? []) fn(data, from)
        break
      }
    }
  }

  /* ── Public surface ─────────────────────────────────────────────────── */

  handle(method: string, handler: RpcHandler) {
    this.handlers.set(method, handler)
    return () => this.handlers.delete(method)
  }

  /** Calls a method on another device and waits for its answer. */
  call<T = unknown>(peerId: string, method: string, params?: unknown): Promise<T> {
    const peer = this.peers.get(peerId)
    if (!peer || peer.state !== 'connected') {
      return Promise.reject(new Error(`${this.labelOf(peerId)} is not connected.`))
    }
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      // Without a timeout a device that goes to sleep mid-request leaves the
      // caller hanging forever, which in the chat UI looks like a hung model.
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${this.labelOf(peerId)} did not answer in time.`))
      }, RPC_TIMEOUT_MS)

      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      if (!peer.send({ k: 'req', id, method, params })) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`Could not reach ${this.labelOf(peerId)}.`))
      }
    })
  }

  broadcast(topic: string, data: unknown) {
    for (const peer of this.peers.values()) peer.send({ k: 'ev', topic, data })
  }

  /** Raw frame used by the CRDT provider, which has its own binary encoding. */
  broadcastYjs(b64: string) {
    for (const peer of this.peers.values()) peer.send({ k: 'y', b64 })
  }

  sendYjs(peerId: string, b64: string) {
    this.peers.get(peerId)?.send({ k: 'y', b64 })
  }

  subscribe(topic: string, fn: (data: unknown, from: string) => void) {
    let set = this.subscribers.get(topic)
    if (!set) {
      set = new Set()
      this.subscribers.set(topic, set)
    }
    set.add(fn)
    return () => set.delete(fn)
  }

  list(): MeshPeer[] {
    const now = performance.now()
    return [...this.peers.entries()].map(([id, peer]) => {
      const info = this.info.get(id)
      const w = this.trafficWindow.get(id)
      const elapsed = w ? Math.max(0.25, (now - w.since) / 1000) : 1
      return {
        peerId: id,
        label: info?.label ?? 'Connecting…',
        capability: info?.capability as never,
        rttMs: peer.rttMs,
        joinedAt: info?.joinedAt ?? Date.now(),
        state: peer.state,
        throughput: w && now - w.since < 2000 ? w.bytes / elapsed : 0,
      }
    })
  }

  labelOf(peerId: string): string {
    return this.info.get(peerId)?.label ?? 'that device'
  }

  updateSelf(self: { label: string; capability: Capability }) {
    this.self = self
    for (const id of this.peers.keys()) this.sayHello(id)
  }

  private drop(id: string) {
    this.peers.get(id)?.close()
    this.peers.delete(id)
    this.info.delete(id)
    this.trafficWindow.delete(id)
    // Anything waiting on that device must fail now rather than time out
    // thirty seconds later with a less useful message.
    for (const [reqId, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('That device left the mesh.'))
      this.pending.delete(reqId)
    }
    this.onChange?.()
  }

  close() {
    for (const peer of this.peers.values()) peer.close()
    this.peers.clear()
    this.info.clear()
    this.signaler.close()
    this.onChange?.()
  }
}
