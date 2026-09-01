import { useSyncExternalStore } from 'react'
import {
  appendMessage, appendText, createThread, deleteThread, finishMessage,
  observeDoc, readThread, readThreadList, setThreadModel, whenSynced,
  type ThreadView,
} from '@/sync/doc'
import { useDevice } from './device'
import { useEngine } from './engine'
import type { ChatMessage } from '@/runtime/types'

/* ── React bindings over the CRDT ─────────────────────────────────────── */

// The document mutates in place, so a version counter is what tells React
// something changed; snapshots themselves are rebuilt on read.
let version = 0
const listeners = new Set<() => void>()

observeDoc(() => {
  version++
  for (const l of listeners) l()
})

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

let threadListCache: { v: number; value: ThreadView[] } = { v: -1, value: [] }
export function useThreadList(): ThreadView[] {
  return useSyncExternalStore(
    subscribe,
    () => {
      // useSyncExternalStore requires a stable reference between renders or it
      // loops forever, so the snapshot is memoised against the version counter.
      if (threadListCache.v !== version) threadListCache = { v: version, value: readThreadList() }
      return threadListCache.value
    },
    () => [],
  )
}

const threadCache = new Map<string, { v: number; value: ThreadView | null }>()
export function useThread(id: string | null): ThreadView | null {
  return useSyncExternalStore(
    subscribe,
    () => {
      if (!id) return null
      const hit = threadCache.get(id)
      if (hit && hit.v === version) return hit.value
      const value = readThread(id)
      threadCache.set(id, { v: version, value })
      return value
    },
    () => null,
  )
}

export const chatReady = whenSynced

/* ── Actions ──────────────────────────────────────────────────────────── */

export { createThread, deleteThread }

const SYSTEM_PROMPT =
  'You are a helpful assistant running entirely inside the user\'s web browser. Be concise.'

/**
 * Sends a turn and streams the reply into the document.
 *
 * The reply message is created *before* generation starts and marked streaming,
 * so a device that joins mid-answer sees the reply filling in rather than
 * nothing at all.
 */
export async function sendTurn(threadId: string, content: string): Promise<void> {
  const engine = useEngine.getState()
  const model = engine.model
  if (!model || engine.status !== 'ready' || engine.generating) return

  const deviceLabel = useDevice.getState().capability?.label
  setThreadModel(threadId, model.id, model.label)

  appendMessage(threadId, 'user', content)
  const replyId = appendMessage(threadId, 'assistant', '', { deviceLabel, streaming: true })

  const thread = readThread(threadId)
  const history: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(thread?.messages ?? [])
      .filter((m) => m.role !== 'system' && m.id !== replyId && m.content)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
  ]

  const result = await engine.generate({ messages: history }, (delta) =>
    appendText(threadId, replyId, delta),
  )

  if (result) {
    finishMessage(threadId, replyId, {
      stats: {
        tokensPerSec: result.stats.decodeTokPerSec,
        ttftMs: result.stats.ttftMs,
        completionTokens: result.stats.completionTokens,
      },
    })
  } else {
    finishMessage(threadId, replyId, {
      error: useEngine.getState().error?.message ?? 'Generation failed.',
    })
  }
}
