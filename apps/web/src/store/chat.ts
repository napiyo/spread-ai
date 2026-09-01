import { useSyncExternalStore } from 'react'
import { create } from 'zustand'
import {
  appendMessage, appendText, chooseCandidate, createThread, deleteThread, finishMessage,
  observeDoc, readThread, readThreadList, setMessageProgress, setThreadModel, whenSynced,
  type MessageCandidate, type ThreadView,
} from '@/sync/doc'
import { useEngine } from './engine'
import { currentWorkers } from './workers'
import {
  planTurn, runStrategy, strategyLabel,
  type Choice, type Strategy, type Worker,
} from '@/strategies'
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

export { createThread, deleteThread, chooseCandidate }

const SYSTEM_PROMPT =
  'You are a helpful assistant running entirely inside the user\'s web browser. Be concise.'

/**
 * The turn currently in flight, so the stop button can reach whichever devices
 * are actually doing the work — which is not necessarily this one.
 */
let inFlight: { strategy: Strategy } | null = null

interface TurnState {
  running: boolean
  /** Where this turn is being run, in words, while it is running. */
  where: string | null
}

/**
 * Whether a turn is in flight anywhere in the fleet.
 *
 * The engine's own `generating` flag is not enough any more: a turn can be
 * running on three other devices while this one sits idle, and the composer
 * still has to be closed and the stop button still has to work.
 */
export const useTurn = create<TurnState>(() => ({ running: false, where: null }))

/**
 * Which model the fleet should use for this turn.
 *
 * A device that was named explicitly decides, because picking a device and then
 * being told it has the wrong model loaded is nonsense. Otherwise whatever is
 * loaded here wins, and failing that the first peer that has anything — which is
 * what lets a laptop with no model chat through a desktop that has one.
 */
function modelForTurn(workers: Worker[], choice: Choice): string | null {
  if (choice.kind === 'single' && choice.workerId) {
    return workers.find((w) => w.id === choice.workerId)?.modelId ?? null
  }
  const here = workers.find((w) => w.local)
  return here?.modelId ?? workers.find((w) => w.modelId)?.modelId ?? null
}

/**
 * Sends a turn and streams the reply into the document.
 *
 * The reply message is created *before* generation starts and marked streaming,
 * so a device that joins mid-answer sees the reply filling in rather than
 * nothing at all.
 */
export async function sendTurn(
  threadId: string,
  content: string,
  choice: Choice = { kind: 'auto' },
): Promise<void> {
  if (inFlight) return

  const workers = currentWorkers()
  const modelId = modelForTurn(workers, choice)
  const plan = planTurn({ workers, modelId, content, choice })

  // A refusal is an answer. Writing it into the transcript as the reply keeps
  // the reason attached to the message that provoked it, instead of flashing it
  // somewhere else and losing it.
  if (!plan.ok) {
    appendMessage(threadId, 'user', content)
    const id = appendMessage(threadId, 'assistant', '')
    finishMessage(threadId, id, { error: plan.reason })
    return
  }

  const { strategy } = plan
  const lead = strategy.workers[0]
  if (lead.modelId) setThreadModel(threadId, lead.modelId, lead.modelLabel ?? lead.modelId)

  appendMessage(threadId, 'user', content)
  const replyId = appendMessage(threadId, 'assistant', '', {
    deviceLabel: strategy.workers[0].label,
    streaming: true,
  })

  const thread = readThread(threadId)
  const history: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(thread?.messages ?? [])
      .filter((m) => m.role !== 'system' && m.id !== replyId && m.content)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
  ]

  inFlight = { strategy }
  useTurn.setState({
    running: true,
    where: strategy.workers.map((w) => w.label).join(', '),
  })
  try {
    const outcome = await runStrategy(strategy, {
      messages: history,
      content,
      onToken: (delta) => appendText(threadId, replyId, delta),
      onStep: (step) =>
        setMessageProgress(
          threadId,
          replyId,
          step.done && step.step === step.steps - 1 ? null : step.label,
        ),
    })

    finishMessage(threadId, replyId, {
      deviceLabel: outcome.deviceLabel,
      strategy: strategyLabel(strategy.kind, strategy.workers.length),
      // Reconciles the transcript with the answer that actually won, which is
      // not always the one whose tokens were being streamed into it.
      text: outcome.text,
      shown: outcome.shownIndex,
      stats: outcome.stats
        ? {
            tokensPerSec: outcome.stats.decodeTokPerSec,
            ttftMs: outcome.stats.ttftMs,
            completionTokens: outcome.stats.completionTokens,
          }
        : undefined,
      candidates: outcome.candidates?.map(
        (c): MessageCandidate => ({
          deviceLabel: c.deviceLabel,
          text: c.text,
          error: c.error,
          stats: c.stats
            ? {
                tokensPerSec: c.stats.decodeTokPerSec,
                ttftMs: c.stats.ttftMs,
                completionTokens: c.stats.completionTokens,
              }
            : undefined,
        }),
      ),
    })
  } catch (e) {
    finishMessage(threadId, replyId, {
      error: e instanceof Error ? e.message : String(e),
    })
  } finally {
    inFlight = null
    useTurn.setState({ running: false, where: null })
  }
}

/** Stops whatever is running, wherever it is running. */
export async function stopTurn(): Promise<void> {
  const running = inFlight
  if (!running) {
    await useEngine.getState().interrupt()
    return
  }
  await Promise.all(running.strategy.workers.map((w) => w.interrupt().catch(() => {})))
}
