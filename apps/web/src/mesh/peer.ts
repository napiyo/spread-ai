import {
  CONTROL_CHANNEL, TELEMETRY_CHANNEL, type Envelope,
} from './protocol'

export type PeerState = 'new' | 'connecting' | 'connected' | 'failed' | 'closed'

export interface PeerEvents {
  onState: (state: PeerState) => void
  /** Called once with a human-readable reason when the link gives up. */
  onFailure?: (reason: string) => void
  onEnvelope: (env: Envelope) => void
  onSignal: (payload: unknown) => void
  /** Bytes moved since the last call, used to drive the beams in the UI. */
  onTraffic?: (sent: number, received: number) => void
}

/** How long to wait for a direct connection before calling it a failure. */
const CONNECT_TIMEOUT_MS = 25_000
/** How long a 'disconnected' link is given to recover before being torn down. */
const DISCONNECT_GRACE_MS = 8_000

const ICE_SERVERS: RTCIceServer[] = [
  // Public STUN only, and only to discover a reflexive address when the two
  // devices are not on the same network. On a LAN the host candidates match
  // first and nothing external is contacted at all — which is what makes the
  // offline path work. No TURN: we never relay user data through a third party.
  { urls: 'stun:stun.l.google.com:19302' },
]

/**
 * One connection to one other device.
 *
 * Two channels: a reliable ordered one for control, tensors and CRDT updates,
 * and an unreliable one for telemetry, so a burst of "still here, 34 tok/s"
 * messages can never sit in front of a hidden state that a token is waiting on.
 */
export class Peer {
  readonly id: string
  state: PeerState = 'new'
  rttMs: number | null = null

  private pc: RTCPeerConnection
  private control: RTCDataChannel | null = null
  private telemetry: RTCDataChannel | null = null
  private pendingIce: RTCIceCandidateInit[] = []
  private remoteDescriptionSet = false
  private sent = 0
  private received = 0
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  /** Why this peer failed, when it did. Shown to the user verbatim. */
  failure: string | null = null

  constructor(
    id: string,
    private readonly events: PeerEvents,
    /** The peer that initiates is the one that creates the channels. */
    private readonly polite: boolean,
  ) {
    this.id = id
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })

    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.events.onSignal({ candidate: e.candidate.toJSON() })
    }

    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState
      if (s === 'connected') {
        this.clearTimers()
        this.setState('connected')
        return
      }
      if (s === 'failed') {
        this.fail(
          'Could not open a direct connection. Some networks block peer-to-peer traffic between devices.',
        )
        return
      }
      if (s === 'closed') {
        this.setState('closed')
        return
      }
      if (s === 'disconnected') {
        // WebRTC reports 'disconnected' for transient loss — a phone changing
        // network, a laptop waking up — and usually recovers on its own.
        // Tearing the peer down here loses connections that were about to come
        // back, so it gets a grace period first.
        this.scheduleDisconnectGrace()
        return
      }
      if (s === 'connecting') this.setState('connecting')
    }

    this.pc.ondatachannel = (e) => this.attach(e.channel)
  }

  private setState(s: PeerState) {
    if (this.state === s) return
    this.state = s
    this.events.onState(s)
    if (s === 'connected') this.startPinging()
    if (s === 'closed' || s === 'failed') this.stopPinging()
  }

  private fail(reason: string) {
    this.failure = reason
    this.clearTimers()
    this.events.onFailure?.(reason)
    this.setState('failed')
  }

  private scheduleDisconnectGrace() {
    if (this.graceTimer) return
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null
      if (this.pc.connectionState !== 'connected') {
        this.fail('The connection dropped and did not come back.')
      }
    }, DISCONNECT_GRACE_MS)
  }

  /**
   * Without a deadline a peer that can never be reached sits at "connecting"
   * forever, which reads as a hang rather than a failure with a cause.
   */
  private startConnectDeadline() {
    this.clearConnectTimer()
    this.connectTimer = setTimeout(() => {
      if (this.state !== 'connected') {
        this.fail(
          'Timed out before a direct connection opened. This usually means the network blocks peer-to-peer traffic.',
        )
      }
    }, CONNECT_TIMEOUT_MS)
  }

  private clearConnectTimer() {
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = null
  }

  private clearTimers() {
    this.clearConnectTimer()
    if (this.graceTimer) clearTimeout(this.graceTimer)
    this.graceTimer = null
  }

  /** Called on the side that initiates the connection. */
  async createOffer(): Promise<void> {
    this.attach(
      this.pc.createDataChannel(CONTROL_CHANNEL, { ordered: true, negotiated: false }),
    )
    this.attach(
      this.pc.createDataChannel(TELEMETRY_CHANNEL, {
        ordered: false,
        maxRetransmits: 0,
      }),
    )
    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)
    this.events.onSignal({ sdp: this.pc.localDescription?.toJSON() })
    this.setState('connecting')
    this.startConnectDeadline()
  }

  async handleSignal(payload: unknown): Promise<void> {
    const msg = payload as { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }

    if (msg.sdp) {
      await this.pc.setRemoteDescription(msg.sdp)
      this.remoteDescriptionSet = true
      // Candidates routinely arrive before the description they belong to.
      for (const c of this.pendingIce.splice(0)) {
        await this.pc.addIceCandidate(c).catch(() => {})
      }
      if (msg.sdp.type === 'offer') {
        const answer = await this.pc.createAnswer()
        await this.pc.setLocalDescription(answer)
        this.events.onSignal({ sdp: this.pc.localDescription?.toJSON() })
        this.startConnectDeadline()
      }
      return
    }

    if (msg.candidate) {
      if (!this.remoteDescriptionSet) this.pendingIce.push(msg.candidate)
      else await this.pc.addIceCandidate(msg.candidate).catch(() => {})
    }
  }

  private attach(channel: RTCDataChannel) {
    if (channel.label === TELEMETRY_CHANNEL) {
      this.telemetry = channel
    } else {
      this.control = channel
      channel.binaryType = 'arraybuffer'
    }

    channel.onopen = () => {
      if (this.control?.readyState === 'open') this.setState('connected')
    }
    channel.onclose = () => {
      if (channel === this.control) this.setState('closed')
    }
    channel.onmessage = (e) => {
      const size = typeof e.data === 'string' ? e.data.length : (e.data as ArrayBuffer).byteLength
      this.received += size
      this.events.onTraffic?.(0, size)
      try {
        this.events.onEnvelope(JSON.parse(String(e.data)) as Envelope)
      } catch {
        /* malformed frame from a peer is not worth tearing the link down for */
      }
    }
  }

  send(env: Envelope, viaTelemetry = false): boolean {
    const channel = viaTelemetry ? (this.telemetry ?? this.control) : this.control
    if (channel?.readyState !== 'open') return false
    const data = JSON.stringify(env)
    channel.send(data)
    this.sent += data.length
    this.events.onTraffic?.(data.length, 0)
    return true
  }

  private startPinging() {
    this.stopPinging()
    const ping = () => this.send({ k: 'ping', t: performance.now() }, true)
    ping()
    // Round-trip time is what the planner uses to price a pipeline hop, so it
    // is measured continuously rather than assumed.
    this.pingTimer = setInterval(ping, 4000)
  }

  private stopPinging() {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  notePong(sentAt: number) {
    const rtt = performance.now() - sentAt
    // Smooth it: a single scheduling hiccup should not make the UI claim the
    // link got worse.
    this.rttMs = this.rttMs == null ? rtt : this.rttMs * 0.7 + rtt * 0.3
  }

  get bytes() {
    return { sent: this.sent, received: this.received }
  }

  close() {
    this.stopPinging()
    this.clearTimers()
    this.control?.close()
    this.telemetry?.close()
    this.pc.close()
    this.setState('closed')
  }

  /** True when this side should back off in a glare situation. */
  get isPolite() {
    return this.polite
  }
}
