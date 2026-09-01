import type { Signaler, SignalState } from './transport'

const RECONNECT_BASE_MS = 500
const RECONNECT_MAX_MS = 15_000

/**
 * Signaling over a WebSocket relay.
 *
 * Reconnects with backoff, because a laptop lid closing should not permanently
 * cost you the room. The relay only ever carries SDP and ICE.
 */
export class WsSignaler implements Signaler {
  readonly kind = 'ws' as const

  onPeerJoined?: (peerId: string) => void
  onPeerLeft?: (peerId: string) => void
  onExistingPeers?: (peerIds: string[]) => void
  onSignal?: (from: string, payload: unknown) => void
  onError?: (message: string) => void
  onStateChange?: (state: SignalState) => void

  private ws: WebSocket | null = null
  private closed = false
  private attempt = 0
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    readonly url: string,
    readonly room: string,
    readonly peerId: string,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.open(resolve, reject)
    })
  }

  private open(resolve?: () => void, reject?: (e: Error) => void) {
    if (this.closed) return
    this.onStateChange?.('connecting')

    const u = new URL(this.url)
    u.searchParams.set('room', this.room)
    u.searchParams.set('id', this.peerId)

    let settled = false
    const ws = new WebSocket(u.toString())
    this.ws = ws

    ws.onopen = () => {
      this.attempt = 0
      this.onStateChange?.('connected')
    }

    ws.onmessage = (e) => {
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(e.data))
      } catch {
        return
      }
      switch (msg.type) {
        case 'welcome':
          if (!settled) {
            settled = true
            resolve?.()
          }
          this.onExistingPeers?.((msg.peers as string[]) ?? [])
          break
        case 'joined':
          this.onPeerJoined?.(msg.id as string)
          break
        case 'left':
          this.onPeerLeft?.(msg.id as string)
          break
        case 'signal':
          this.onSignal?.(msg.from as string, msg.payload)
          break
        case 'error': {
          const err = new Error(String(msg.error))
          this.onError?.(err.message)
          if (!settled) {
            settled = true
            reject?.(err)
          }
          break
        }
      }
    }

    ws.onerror = () => {
      this.onStateChange?.('error')
      if (!settled) {
        settled = true
        reject?.(new Error('Could not reach the pairing service.'))
      }
    }

    ws.onclose = () => {
      if (this.closed) {
        this.onStateChange?.('closed')
        return
      }
      // Exponential backoff with jitter, so a relay restart doesn't get a
      // thundering herd from every device in the room at once.
      const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.attempt++)
      const jittered = delay * (0.7 + Math.random() * 0.6)
      this.onStateChange?.('connecting')
      this.timer = setTimeout(() => this.open(), jittered)
    }
  }

  send(to: string, payload: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'signal', to, payload }))
    }
  }

  close() {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.ws?.close()
    this.ws = null
    this.onStateChange?.('closed')
  }
}
