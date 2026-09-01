import type { Capability } from '@/capability/identify'
import type { RunStats } from '@/runtime/types'

/** Wire protocol between peers. Kept small and explicit for debuggability. */

/** What a device currently has in memory and can therefore run for someone else. */
export interface LoadedModel {
  id: string
  label: string
  contextWindow: number
}

export interface PeerInfo {
  peerId: string
  label: string
  capability: Capability
  /**
   * The model that device has resident right now, or null. Gossiped rather than
   * asked for, because the chat UI needs to know who can serve a turn *before*
   * anyone types anything, and a round trip per keystroke is not that.
   */
  loaded: LoadedModel | null
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
  /**
   * Identifies one generation for its whole life. Token events carry it so two
   * concurrent runs cannot interleave into one reply, and `interrupt` carries
   * it so a stale stop never kills a generation started afterwards.
   */
  runId: string
  modelId: string
  messages: { role: string; content: string }[]
  maxTokens?: number
  temperature?: number
  topP?: number
  seed?: number
}

export interface GenerateReply {
  text: string
  stats: RunStats | null
  interrupted: boolean
  /** Name of the device that actually did the work, for the transcript. */
  deviceLabel: string
}

export interface InterruptParams {
  runId: string
}

/**
 * Tokens travel as events rather than as one big result so the asking device
 * sees a reply appear as it is written. They go to the requester alone — a
 * broadcast would hand everyone else in the room a copy of somebody's prompt.
 */
export const TOKEN_TOPIC = 'gen'

export type TokenEvent =
  | { runId: string; delta: string }
  | { runId: string; done: true }

export const CONTROL_CHANNEL = 'sai-control'
/** Unreliable channel for telemetry that must never delay real work. */
export const TELEMETRY_CHANNEL = 'sai-telemetry'
