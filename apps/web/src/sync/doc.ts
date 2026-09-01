import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { Awareness } from 'y-protocols/awareness'

/**
 * The one shared document.
 *
 * Conversations are CRDTs from the very first keystroke, even on a single
 * device, so that adding peer sync later is a matter of attaching another
 * provider rather than migrating data. Assistant replies are Y.Text so that two
 * devices watching the same generation converge instead of clobbering.
 *
 * Layout:
 *   threads : Y.Map<threadId, Y.Map>
 *     ├ id, title, createdAt, updatedAt, modelId, modelLabel
 *     └ messages : Y.Array<Y.Map>
 *          └ id, role, createdAt, deviceLabel, stats, strategy,
 *            candidates, shown, progress, text: Y.Text
 *   prefs   : Y.Map
 */

export const ydoc = new Y.Doc()
export const awareness = new Awareness(ydoc)

export const threads = ydoc.getMap<Y.Map<unknown>>('threads')
export const prefs = ydoc.getMap<unknown>('prefs')

export const persistence = new IndexeddbPersistence('spreadai.doc.v1', ydoc)

/** Resolves once anything previously stored on this device has been replayed. */
export const whenSynced: Promise<void> = new Promise((resolve) => {
  persistence.once('synced', () => resolve())
})

export interface MessageStats {
  tokensPerSec: number
  ttftMs: number
  completionTokens: number
}

/** One sample of a reply, when several devices drew one at the same time. */
export interface MessageCandidate {
  deviceLabel: string
  text: string
  stats?: MessageStats
  error?: string
}

export interface MessageView {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
  deviceLabel?: string
  stats?: MessageStats
  /** Set while a reply is still arriving. */
  streaming?: boolean
  /** What the fleet is doing right now, for turns that take several steps. */
  progress?: string
  /** How this reply was produced, e.g. "split 3 ways". */
  strategy?: string
  /** Every sample drawn, when more than one was. */
  candidates?: MessageCandidate[]
  /** Which candidate is currently shown. */
  shown?: number
  error?: string
}

export interface ThreadView {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  modelId?: string
  modelLabel?: string
  messages: MessageView[]
}

const uid = () => crypto.randomUUID()

export function createThread(modelId?: string, modelLabel?: string): string {
  const id = uid()
  const t = new Y.Map<unknown>()
  ydoc.transact(() => {
    t.set('id', id)
    t.set('title', 'New conversation')
    t.set('createdAt', Date.now())
    t.set('updatedAt', Date.now())
    if (modelId) t.set('modelId', modelId)
    if (modelLabel) t.set('modelLabel', modelLabel)
    t.set('messages', new Y.Array<Y.Map<unknown>>())
    threads.set(id, t)
  })
  return id
}

export function deleteThread(id: string) {
  threads.delete(id)
}

function messagesOf(threadId: string): Y.Array<Y.Map<unknown>> | null {
  const t = threads.get(threadId)
  return (t?.get('messages') as Y.Array<Y.Map<unknown>>) ?? null
}

export function appendMessage(
  threadId: string,
  role: MessageView['role'],
  content = '',
  extra: Partial<Pick<MessageView, 'deviceLabel' | 'streaming'>> = {},
): string {
  const arr = messagesOf(threadId)
  if (!arr) throw new Error(`No thread ${threadId}`)

  const id = uid()
  ydoc.transact(() => {
    const m = new Y.Map<unknown>()
    m.set('id', id)
    m.set('role', role)
    m.set('createdAt', Date.now())
    const text = new Y.Text()
    if (content) text.insert(0, content)
    m.set('text', text)
    if (extra.deviceLabel) m.set('deviceLabel', extra.deviceLabel)
    if (extra.streaming) m.set('streaming', true)
    arr.push([m])

    const t = threads.get(threadId)
    t?.set('updatedAt', Date.now())
    // The first thing a person types is a better title than "New conversation",
    // and they should not have to name it themselves.
    if (role === 'user' && arr.length === 1 && content) {
      t?.set('title', content.slice(0, 60).replace(/\s+/g, ' ').trim())
    }
  })
  return id
}

function findMessage(threadId: string, messageId: string): Y.Map<unknown> | null {
  const arr = messagesOf(threadId)
  if (!arr) return null
  for (const m of arr) if (m.get('id') === messageId) return m
  return null
}

/**
 * Appends streamed text to a message.
 *
 * Deliberately writes on every token rather than batching: Y.Text updates for
 * single tokens are tiny, and it means a second device watching the same thread
 * sees the reply arrive live instead of in one lump at the end.
 */
export function appendText(threadId: string, messageId: string, delta: string) {
  const m = findMessage(threadId, messageId)
  if (!m) return
  const text = m.get('text') as Y.Text
  text.insert(text.length, delta)
}

/**
 * What the fleet is doing right now.
 *
 * Written into the document rather than kept in component state so that a
 * second device watching the same thread sees "reading part 3 of 4" too,
 * instead of an answer that appears out of nowhere a minute later.
 */
export function setMessageProgress(threadId: string, messageId: string, progress: string | null) {
  const m = findMessage(threadId, messageId)
  if (!m) return
  if (progress) m.set('progress', progress)
  else m.delete('progress')
}

export function finishMessage(
  threadId: string,
  messageId: string,
  patch: {
    stats?: MessageStats
    error?: string
    deviceLabel?: string
    strategy?: string
    candidates?: MessageCandidate[]
    shown?: number
    /**
     * The final text, when it is not what was streamed — a sample whose device
     * died halfway through leaves a fragment in the document that has to go.
     */
    text?: string
  } = {},
) {
  const m = findMessage(threadId, messageId)
  if (!m) return
  ydoc.transact(() => {
    m.delete('streaming')
    m.delete('progress')

    const text = m.get('text') as Y.Text
    if (patch.text != null && patch.text !== text.toString()) {
      text.delete(0, text.length)
      text.insert(0, patch.text)
    }

    if (patch.stats) m.set('stats', patch.stats)
    if (patch.error) m.set('error', patch.error)
    if (patch.deviceLabel) m.set('deviceLabel', patch.deviceLabel)
    if (patch.strategy) m.set('strategy', patch.strategy)
    // Only worth keeping when there is actually a choice to make.
    if (patch.candidates && patch.candidates.length > 1) {
      m.set('candidates', patch.candidates)
      m.set('shown', patch.shown ?? 0)
    }
    threads.get(threadId)?.set('updatedAt', Date.now())
  })
}

/**
 * Switches a best-of-n reply to a different sample.
 *
 * The text is a Y.Text, so this is a replace rather than a new message: the
 * conversation keeps one reply in one place, and the swap merges on every
 * device rather than producing two divergent transcripts.
 */
export function chooseCandidate(threadId: string, messageId: string, index: number) {
  const m = findMessage(threadId, messageId)
  if (!m) return
  const candidates = m.get('candidates') as MessageCandidate[] | undefined
  const pick = candidates?.[index]
  if (!pick || pick.error) return

  ydoc.transact(() => {
    const text = m.get('text') as Y.Text
    text.delete(0, text.length)
    text.insert(0, pick.text)
    m.set('shown', index)
    m.set('deviceLabel', pick.deviceLabel)
    if (pick.stats) m.set('stats', pick.stats)
    else m.delete('stats')
    threads.get(threadId)?.set('updatedAt', Date.now())
  })
}

export function setThreadModel(threadId: string, modelId: string, modelLabel: string) {
  const t = threads.get(threadId)
  ydoc.transact(() => {
    t?.set('modelId', modelId)
    t?.set('modelLabel', modelLabel)
  })
}

/* ── Reading ──────────────────────────────────────────────────────────── */

function toMessageView(m: Y.Map<unknown>): MessageView {
  return {
    id: m.get('id') as string,
    role: m.get('role') as MessageView['role'],
    content: (m.get('text') as Y.Text)?.toString() ?? '',
    createdAt: (m.get('createdAt') as number) ?? 0,
    deviceLabel: m.get('deviceLabel') as string | undefined,
    stats: m.get('stats') as MessageStats | undefined,
    streaming: Boolean(m.get('streaming')),
    progress: m.get('progress') as string | undefined,
    strategy: m.get('strategy') as string | undefined,
    candidates: m.get('candidates') as MessageCandidate[] | undefined,
    shown: m.get('shown') as number | undefined,
    error: m.get('error') as string | undefined,
  }
}

export function readThread(id: string): ThreadView | null {
  const t = threads.get(id)
  if (!t) return null
  const arr = (t.get('messages') as Y.Array<Y.Map<unknown>>) ?? new Y.Array()
  return {
    id,
    title: (t.get('title') as string) ?? 'Conversation',
    createdAt: (t.get('createdAt') as number) ?? 0,
    updatedAt: (t.get('updatedAt') as number) ?? 0,
    modelId: t.get('modelId') as string | undefined,
    modelLabel: t.get('modelLabel') as string | undefined,
    messages: arr.map(toMessageView),
  }
}

export function readThreadList(): ThreadView[] {
  return [...threads.keys()]
    .map((id) => readThread(id))
    .filter((t): t is ThreadView => Boolean(t))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** Subscribes to any change anywhere in the document. */
export function observeDoc(fn: () => void): () => void {
  const handler = () => fn()
  ydoc.on('afterTransaction', handler)
  return () => ydoc.off('afterTransaction', handler)
}
