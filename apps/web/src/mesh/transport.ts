/**
 * How two browsers first hear about each other.
 *
 * WebRTC needs an out-of-band channel to trade an offer, an answer and ICE
 * candidates. Everything after that is peer-to-peer. Two implementations exist
 * because the two situations are genuinely different: a WebSocket relay is
 * effortless and works across networks, and a QR handshake needs no server at
 * all and therefore still works on a plane.
 */
export interface Signaler {
  readonly kind: 'ws' | 'qr'
  /** Our own id within this session. */
  readonly peerId: string
  connect(): Promise<void>
  send(to: string, payload: unknown): void
  close(): void

  onPeerJoined?: (peerId: string) => void
  onPeerLeft?: (peerId: string) => void
  /** Peers already present when we arrived — we are the one who calls them. */
  onExistingPeers?: (peerIds: string[]) => void
  onSignal?: (from: string, payload: unknown) => void
  onError?: (message: string) => void
  onStateChange?: (state: SignalState) => void
}

export type SignalState = 'idle' | 'connecting' | 'connected' | 'closed' | 'error'

/**
 * Room codes are read aloud and typed by hand, so the alphabet excludes
 * everything people confuse: no O/0, no I/1/L, no U/V.
 */
const ALPHABET = 'ACDEFGHJKMNPQRTWXY2346789'

export function generateRoomCode(length = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
}

export function normaliseRoomCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}
