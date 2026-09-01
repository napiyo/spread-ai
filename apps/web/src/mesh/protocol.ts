import type { Capability } from '@/capability/identify'

/** Wire protocol between peers. Kept small and explicit for debuggability. */

export interface PeerInfo {
  peerId: string
  label: string
  capability: Capability
  /** Measured round-trip time over the data channel, ms. */
  rttMs: number | null
  joinedAt: number
}

export type Envelope =
  | { k: 'hello'; info: Omit<PeerInfo, 'rttMs' | 'joinedAt'> }
  | { k: 'ping'; t: number }
  | { k: 'pong'; t: number }
  | { k: 'req'; id: number; method: string; params: unknown }
  | { k: 'res'; id: number; ok: true; result: unknown }
  | { k: 'res'; id: number; ok: false; error: string }
  | { k: 'ev'; topic: string; data: unknown }
  /** Yjs sync and awareness, forwarded verbatim to y-protocols. */
  | { k: 'y'; b64: string }

/** Methods a peer may ask another peer to perform. */
export type RpcMethod =
  | 'capability'
  | 'generate'
  | 'interrupt'
  | 'listCachedModels'
  | 'fetchModelChunk'

export interface GenerateParams {
  modelId: string
  messages: { role: string; content: string }[]
  maxTokens?: number
  temperature?: number
}

export const CONTROL_CHANNEL = 'sai-control'
/** Unreliable channel for telemetry that must never delay real work. */
export const TELEMETRY_CHANNEL = 'sai-telemetry'
