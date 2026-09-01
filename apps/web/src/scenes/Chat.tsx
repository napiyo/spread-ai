import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  ArrowUp, Cpu, Loader2, MessageSquarePlus, Square, Trash2, Zap,
} from 'lucide-react'
import { Button } from '@/ui/primitives/Button'
import { Chip, LiveDot } from '@/ui/primitives/Chip'
import { NumberTicker } from '@/ui/fx/NumberTicker'
import { GridField } from '@/ui/fx/GridField'
import {
  chatReady, createThread, deleteThread, sendTurn, useThread, useThreadList,
} from '@/store/chat'
import { useEngine } from '@/store/engine'
import { navigate } from '@/lib/router'
import { bytes, ms } from '@/lib/format'
import { spring } from '@/lib/motion'
import { cn } from '@/lib/cn'
import type { MessageView } from '@/sync/doc'

export function Chat() {
  const [threadId, setThreadId] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const threads = useThreadList()
  const thread = useThread(threadId)
  const engine = useEngine()

  useEffect(() => {
    chatReady.then(() => setReady(true))
  }, [])

  // Pick up where you left off. With sync in place this is also how a
  // conversation started on another device becomes the one you land in.
  useEffect(() => {
    if (!ready || threadId) return
    setThreadId(threads[0]?.id ?? createThread(engine.model?.id, engine.model?.label))
  }, [ready, threadId, threads, engine.model])

  if (engine.status === 'idle' && !engine.model) return <NoModel />

  return (
    <div className="relative flex h-[calc(100dvh-3.5rem)]">
      <GridField fade="top" className="opacity-40" />

      <aside className="relative hidden w-64 shrink-0 flex-col border-r border-line md:flex">
        <div className="p-3">
          <Button
            size="sm"
            className="w-full"
            onClick={() => setThreadId(createThread(engine.model?.id, engine.model?.label))}
          >
            <MessageSquarePlus size={14} /> New conversation
          </Button>
        </div>
        <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
          {threads.map((t) => (
            <button
              key={t.id}
              onClick={() => setThreadId(t.id)}
              className={cn(
                'group flex w-full items-center gap-2 rounded-[8px] px-2.5 py-2 text-left text-[13px] transition-colors',
                t.id === threadId ? 'bg-panel text-fore' : 'text-mute hover:bg-panel/50 hover:text-dim',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              <span
                role="button"
                tabIndex={0}
                aria-label="Delete conversation"
                onClick={(e) => {
                  e.stopPropagation()
                  deleteThread(t.id)
                  if (t.id === threadId) setThreadId(null)
                }}
                className="opacity-0 transition-opacity group-hover:opacity-100 hover:text-rose"
              >
                <Trash2 size={13} />
              </span>
            </button>
          ))}
        </div>
      </aside>

      <div className="relative flex min-w-0 flex-1 flex-col">
        <ModelBar />
        <Transcript messages={thread?.messages ?? []} />
        <Composer
          disabled={engine.status !== 'ready'}
          generating={engine.generating}
          onSend={(text) => threadId && void sendTurn(threadId, text)}
          onStop={() => void engine.interrupt()}
        />
      </div>
    </div>
  )
}

/* ── Model status ─────────────────────────────────────────────────────── */

function ModelBar() {
  const { model, status, progress, error, unload, lastStats } = useEngine()

  return (
    <div className="relative border-b border-line px-5 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Cpu size={14} className="text-mute" />
        <span className="text-[13px] font-medium">{model?.label ?? 'No model'}</span>

        {status === 'ready' && (
          <Chip tone="good" icon={<LiveDot tone="var(--color-lime)" active={false} />}>
            in memory
          </Chip>
        )}
        {status === 'loading' && (
          <Chip tone="live" icon={<Loader2 size={11} className="animate-spin" />}>
            {progress?.text ?? 'loading'}
          </Chip>
        )}
        {status === 'error' && <Chip tone="bad">failed</Chip>}

        {lastStats && status === 'ready' && (
          <span className="flex items-center gap-1 text-[12px] text-mute">
            <Zap size={11} className="text-cy" />
            <NumberTicker value={lastStats.decodeTokPerSec} decimals={1} className="text-gradient" />
            <span>tok/s · first token {ms(lastStats.ttftMs)}</span>
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => navigate('models')}>
            Change
          </Button>
          {status === 'ready' && (
            <Button size="sm" variant="ghost" onClick={() => void unload()}>
              Unload
            </Button>
          )}
        </div>
      </div>

      {status === 'loading' && progress && (
        <div className="mt-2">
          <div className="h-[3px] overflow-hidden rounded-full bg-line">
            <motion.div
              className="h-full rounded-full"
              style={{ background: 'linear-gradient(90deg, var(--color-cy), var(--color-vi))' }}
              animate={{ width: `${Math.max(3, (progress.progress < 0 ? 0.05 : progress.progress) * 100)}%` }}
              transition={spring.soft}
            />
          </div>
          {progress.totalBytes ? (
            <div className="mt-1.5 text-[11.5px] text-mute">
              {bytes(progress.loadedBytes ?? 0)} of {bytes(progress.totalBytes)}
              {progress.fromCache && ' · from cache'}
            </div>
          ) : null}
        </div>
      )}

      {error && (
        <div className="mt-2 text-[12.5px] text-rose">
          {error.message}
          {error.hint && <span className="mt-0.5 block text-mute">{error.hint}</span>}
        </div>
      )}
    </div>
  )
}

/* ── Transcript ───────────────────────────────────────────────────────── */

function Transcript({ messages }: { messages: MessageView[] }) {
  const ref = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  // Follow the stream, but stop fighting the user the moment they scroll up to
  // read something earlier.
  const onScroll = () => {
    const el = ref.current
    if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  useLayoutEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  })

  if (!messages.length) {
    return (
      <div ref={ref} className="flex min-h-0 flex-1 items-center justify-center px-6">
        <div className="max-w-md text-center">
          <p className="text-[15px] text-dim">Everything here happens on your device.</p>
          <p className="mt-2 text-[13px] leading-relaxed text-mute">
            Nothing you type is sent anywhere. Close the tab and the conversation is still on this
            machine; open the same link on another device you've paired and it will be there too.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div ref={ref} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <AnimatePresence initial={false}>
          {messages.map((m) => (
            <motion.div
              key={m.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={spring.soft}
            >
              <Message message={m} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}

function Message({ message: m }: { message: MessageView }) {
  if (m.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-panel px-4 py-2.5 text-[14.5px] leading-relaxed whitespace-pre-wrap">
          {m.content}
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2 text-[11px] text-mute">
        {m.streaming && <LiveDot tone="var(--color-cy)" />}
        {m.deviceLabel && <span>{m.deviceLabel}</span>}
        {m.stats && (
          <span className="text-mute/80">
            {m.stats.completionTokens} tokens · {m.stats.tokensPerSec.toFixed(1)} tok/s · first in{' '}
            {ms(m.stats.ttftMs)}
          </span>
        )}
      </div>
      <div className="text-[14.5px] leading-[1.65] whitespace-pre-wrap text-fore/95">
        {m.content}
        {m.streaming && !m.content && <span className="text-mute">thinking…</span>}
        {m.streaming && m.content && <Caret />}
      </div>
      {m.error && <div className="mt-2 text-[12.5px] text-rose">{m.error}</div>}
    </div>
  )
}

function Caret() {
  return (
    <motion.span
      className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.15em] rounded-full bg-cy"
      animate={{ opacity: [1, 0.15, 1] }}
      transition={{ duration: 1, repeat: Infinity, ease: 'easeInOut' }}
    />
  )
}

/* ── Composer ─────────────────────────────────────────────────────────── */

function Composer({
  disabled, generating, onSend, onStop,
}: {
  disabled: boolean
  generating: boolean
  onSend: (text: string) => void
  onStop: () => void
}) {
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  const grow = () => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(200, el.scrollHeight)}px`
  }

  const submit = () => {
    const text = value.trim()
    if (!text || disabled || generating) return
    onSend(text)
    setValue('')
    requestAnimationFrame(grow)
  }

  return (
    <div className="relative border-t border-line px-5 py-4">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <textarea
          ref={ref}
          rows={1}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            setValue(e.target.value)
            grow()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={disabled ? 'Load a model to start' : 'Send a message…'}
          className="max-h-[200px] flex-1 resize-none rounded-[12px] border border-line-bright bg-panel/60 px-4 py-3 text-[14.5px] leading-relaxed outline-none placeholder:text-mute focus:border-cy/50 disabled:opacity-50"
        />
        {generating ? (
          <Button variant="outline" size="md" onClick={onStop} aria-label="Stop generating">
            <Square size={14} fill="currentColor" />
          </Button>
        ) : (
          <Button
            variant="primary"
            size="md"
            onClick={submit}
            disabled={disabled || !value.trim()}
            aria-label="Send"
          >
            <ArrowUp size={16} />
          </Button>
        )}
      </div>
    </div>
  )
}

function NoModel() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center px-6 py-32 text-center">
      <Cpu size={22} className="text-mute" />
      <h1 className="mt-4 text-xl font-semibold tracking-tight">No model loaded</h1>
      <p className="mt-2 text-[13.5px] leading-relaxed text-mute">
        Pick one from the shelf. The first load downloads weights and compiles shaders; after that
        it starts from cache and works with the network off.
      </p>
      <Button variant="primary" className="mt-5" onClick={() => navigate('models')}>
        Browse models
      </Button>
    </div>
  )
}
