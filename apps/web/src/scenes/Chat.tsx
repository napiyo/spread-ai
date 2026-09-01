import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  ArrowUp, Check, ChevronDown, Cpu, Layers, Loader2, MessageSquarePlus, Network,
  Shuffle, Square, Trash2, Zap,
} from 'lucide-react'
import { Button } from '@/ui/primitives/Button'
import { Chip, LiveDot } from '@/ui/primitives/Chip'
import { Menu, MenuItem, MenuLabel } from '@/ui/primitives/Menu'
import { NumberTicker } from '@/ui/fx/NumberTicker'
import { GridField } from '@/ui/fx/GridField'
import {
  chatReady, chooseCandidate, createThread, deleteThread, sendTurn, stopTurn,
  useThread, useThreadList, useTurn,
} from '@/store/chat'
import { useEngine } from '@/store/engine'
import { useWorkers } from '@/store/workers'
import { planTurn, usableWorkers, type Choice, type Worker } from '@/strategies'
import { navigate } from '@/lib/router'
import { bytes, ms } from '@/lib/format'
import { spring } from '@/lib/motion'
import { cn } from '@/lib/cn'
import type { MessageView } from '@/sync/doc'

export function Chat() {
  const [threadId, setThreadId] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [choice, setChoice] = useState<Choice>({ kind: 'auto' })
  const [draft, setDraft] = useState('')
  const threads = useThreadList()
  const thread = useThread(threadId)
  const engine = useEngine()
  const turn = useTurn()
  const workers = useWorkers()

  const usable = useMemo(() => usableWorkers(workers, null), [workers])
  const modelId = useMemo(
    () => workers.find((w) => w.local)?.modelId ?? usable[0]?.modelId ?? null,
    [workers, usable],
  )

  // Planned against what is actually in the box, so the note under the composer
  // is about the message you are about to send rather than about messages in
  // general — a long paste changes the answer while you are looking at it.
  const plan = useMemo(
    () => planTurn({ workers, modelId, content: draft, choice }),
    [workers, modelId, draft, choice],
  )

  useEffect(() => {
    chatReady.then(() => setReady(true))
  }, [])

  // Pick up where you left off. With sync in place this is also how a
  // conversation started on another device becomes the one you land in.
  useEffect(() => {
    if (!ready || threadId) return
    setThreadId(threads[0]?.id ?? createThread(engine.model?.id, engine.model?.label))
  }, [ready, threadId, threads, engine.model])

  // A device with nothing loaded is still useful if something in the fleet has
  // a model — that is the whole point of pairing them.
  if (engine.status === 'idle' && !engine.model && !usable.length) return <NoModel />

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
        <ModelBar
          workers={workers}
          usable={usable}
          choice={choice}
          onChoice={setChoice}
          content={draft}
        />
        <Transcript messages={thread?.messages ?? []} threadId={threadId} />
        <Composer
          value={draft}
          onValue={setDraft}
          disabled={!usable.length && engine.status !== 'ready'}
          generating={turn.running || engine.generating}
          note={<PlanNote plan={plan} draft={draft} />}
          onSend={(text) => threadId && void sendTurn(threadId, text, choice)}
          onStop={() => void stopTurn()}
        />
      </div>
    </div>
  )
}

/* ── Where a turn runs ────────────────────────────────────────────────── */

const CHOICE_ICON = { auto: Network, single: Cpu, 'best-of-n': Shuffle, 'map-reduce': Layers }

function choiceTitle(choice: Choice, workers: Worker[]): string {
  switch (choice.kind) {
    case 'auto':
      return 'Automatic'
    case 'single': {
      const w = choice.workerId ? workers.find((x) => x.id === choice.workerId) : undefined
      return w ? w.label : 'Fastest device'
    }
    case 'best-of-n':
      return 'Best of several'
    case 'map-reduce':
      return 'Split the input'
  }
}

function same(a: Choice, b: Choice): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'single' && b.kind === 'single') return a.workerId === b.workerId
  return true
}

/**
 * The picker for where a turn runs.
 *
 * Every arrangement is listed even when it cannot be used, with the reason it
 * cannot, because a greyed row that says "needs a second device with this model
 * loaded" teaches what the fleet is for and an absent row teaches nothing.
 */
function RunPicker({
  workers, usable, choice, onChoice, content,
}: {
  workers: Worker[]
  usable: Worker[]
  choice: Choice
  onChoice: (c: Choice) => void
  content: string
}) {
  const modelId = workers.find((w) => w.local)?.modelId ?? usable[0]?.modelId ?? null
  const reasonFor = (c: Choice): string | null => {
    const plan = planTurn({ workers, modelId, content, choice: c })
    return plan.ok ? null : plan.reason
  }

  const Icon = CHOICE_ICON[choice.kind]
  const options: Choice[] = [{ kind: 'best-of-n' }, { kind: 'map-reduce' }]

  return (
    <Menu
      trigger={(open) => (
        <>
          <Icon size={12} />
          <span>{choiceTitle(choice, workers)}</span>
          <ChevronDown size={12} className={cn('transition-transform', open && 'rotate-180')} />
        </>
      )}
    >
      {(close) => (
        <>
          <MenuLabel>Where this turn runs</MenuLabel>
          <MenuItem
            selected={choice.kind === 'auto'}
            title="Automatic"
            subtitle="One device, unless the input is long enough that splitting it genuinely helps."
            onClick={() => {
              onChoice({ kind: 'auto' })
              close()
            }}
          />

          <MenuLabel>One device</MenuLabel>
          {usable.length === 0 && (
            <div className="px-2.5 py-2 text-[11.5px] leading-snug text-mute">
              Nothing in this fleet has a model loaded.
            </div>
          )}
          {usable.map((w) => (
            <MenuItem
              key={w.id}
              selected={same(choice, { kind: 'single', workerId: w.id })}
              title={
                <span className="flex items-center gap-1.5">
                  {w.label}
                  {w.local && <span className="text-[10px] text-mute">here</span>}
                </span>
              }
              subtitle={`${w.modelLabel ?? w.modelId} · ${
                w.local ? 'no network hop' : `${Math.round(w.rttMs)} ms away`
              }`}
              onClick={() => {
                onChoice({ kind: 'single', workerId: w.id })
                close()
              }}
            />
          ))}

          <MenuLabel>Across the fleet</MenuLabel>
          {options.map((option) => {
            const reason = reasonFor(option)
            return (
              <MenuItem
                key={option.kind}
                selected={same(choice, option)}
                disabled={Boolean(reason)}
                title={choiceTitle(option, workers)}
                subtitle={
                  reason ??
                  (option.kind === 'best-of-n'
                    ? 'Each device draws its own sample. More answers to pick from, not a shorter wait.'
                    : 'Long input is cut up, read in parallel, then answered from the notes.')
                }
                onClick={() => {
                  if (reason) return
                  onChoice(option)
                  close()
                }}
              />
            )
          })}
        </>
      )}
    </Menu>
  )
}

/** The honest line under the composer: what will happen, and what it costs. */
function PlanNote({
  plan, draft,
}: {
  plan: ReturnType<typeof planTurn>
  draft: string
}) {
  if (!draft.trim()) return null

  if (!plan.ok) {
    return <span className="text-amber">{plan.reason}</span>
  }
  const { strategy } = plan
  return (
    <>
      <span className="text-dim">{strategy.why}</span>
      {strategy.caveats[0] && <span className="text-mute"> {strategy.caveats[0]}</span>}
    </>
  )
}

/* ── Model status ─────────────────────────────────────────────────────── */

function ModelBar({
  workers, usable, choice, onChoice, content,
}: {
  workers: Worker[]
  usable: Worker[]
  choice: Choice
  onChoice: (c: Choice) => void
  content: string
}) {
  const { model, status, progress, error, unload, lastStats } = useEngine()
  const remote = usable.filter((w) => !w.local)
  const here = workers.find((w) => w.local)

  return (
    <div className="relative border-b border-line px-5 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Cpu size={14} className="text-mute" />
        <span className="text-[13px] font-medium">
          {model?.label ?? here?.modelLabel ?? usable[0]?.modelLabel ?? 'No model'}
        </span>

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
        {status !== 'ready' && usable.length > 0 && (
          <Chip tone="live" icon={<Network size={11} />}>
            on {usable[0].label}
          </Chip>
        )}
        {remote.length > 0 && (
          <Chip tone="neutral" icon={<Network size={11} />}>
            {remote.length} {remote.length === 1 ? 'device' : 'devices'} ready to help
          </Chip>
        )}

        {lastStats && status === 'ready' && (
          <span className="flex items-center gap-1 text-[12px] text-mute">
            <Zap size={11} className="text-cy" />
            <NumberTicker value={lastStats.decodeTokPerSec} decimals={1} className="text-gradient" />
            <span>tok/s · first token {ms(lastStats.ttftMs)}</span>
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          <RunPicker
            workers={workers}
            usable={usable}
            choice={choice}
            onChoice={onChoice}
            content={content}
          />
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

function Transcript({
  messages, threadId,
}: {
  messages: MessageView[]
  threadId: string | null
}) {
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
          <p className="text-[15px] text-dim">Everything here happens on your own devices.</p>
          <p className="mt-2 text-[13px] leading-relaxed text-mute">
            Nothing you type reaches a server. A turn runs in this tab, or on a device you have
            paired — over an encrypted link straight between the two browsers. Close the tab and the
            conversation is still here; open the same link anywhere in your fleet and it is there too.
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
              <Message message={m} threadId={threadId} />
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  )
}

function Message({ message: m, threadId }: { message: MessageView; threadId: string | null }) {
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
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[11px] text-mute">
        {m.streaming && <LiveDot tone="var(--color-cy)" />}
        {m.deviceLabel && <span>{m.deviceLabel}</span>}
        {m.strategy && <span className="text-mute/70">· {m.strategy}</span>}
        {m.stats && (
          <span className="text-mute/80">
            {m.stats.completionTokens} tokens · {m.stats.tokensPerSec.toFixed(1)} tok/s · first in{' '}
            {ms(m.stats.ttftMs)}
          </span>
        )}
      </div>

      {/* What the fleet is doing, while it is doing it. Several devices working
          in parallel look identical to a hang without this. */}
      {m.streaming && m.progress && (
        <div className="mb-2 flex items-center gap-1.5 text-[11.5px] text-cy">
          <Loader2 size={11} className="animate-spin" />
          {m.progress}
        </div>
      )}

      <div className="text-[14.5px] leading-[1.65] whitespace-pre-wrap text-fore/95">
        {m.content}
        {m.streaming && !m.content && !m.progress && <span className="text-mute">thinking…</span>}
        {m.streaming && m.content && <Caret />}
      </div>

      {m.candidates && threadId && (
        <Candidates message={m} threadId={threadId} />
      )}
      {m.error && <div className="mt-2 text-[12.5px] text-rose">{m.error}</div>}
    </div>
  )
}

/**
 * The other samples, when several devices each drew one.
 *
 * Switching rewrites the reply in place rather than appending a second one: the
 * conversation stays one transcript, and the swap is a CRDT edit so every
 * device that is watching follows along.
 */
function Candidates({ message: m, threadId }: { message: MessageView; threadId: string }) {
  const candidates = m.candidates ?? []
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-mute">{candidates.length} samples:</span>
      {candidates.map((c, i) => (
        <button
          key={`${c.deviceLabel}-${i}`}
          disabled={Boolean(c.error)}
          title={c.error ?? `${c.text.slice(0, 140)}${c.text.length > 140 ? '…' : ''}`}
          onClick={() => chooseCandidate(threadId, m.id, i)}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition-colors',
            c.error
              ? 'cursor-not-allowed border-line text-mute/60 line-through'
              : i === m.shown
                ? 'border-cy/45 bg-cy/[0.07] text-cy'
                : 'border-line-bright text-dim hover:border-mute hover:text-fore',
          )}
        >
          {i === m.shown && !c.error && <Check size={10} />}
          {c.deviceLabel}
        </button>
      ))}
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
  value, onValue, disabled, generating, note, onSend, onStop,
}: {
  value: string
  onValue: (v: string) => void
  disabled: boolean
  generating: boolean
  note: ReactNode
  onSend: (text: string) => void
  onStop: () => void
}) {
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
    onValue('')
    requestAnimationFrame(grow)
  }

  return (
    <div className="relative border-t border-line px-5 py-4">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-end gap-2">
          <textarea
            ref={ref}
            rows={1}
            value={value}
            disabled={disabled}
            onChange={(e) => {
              onValue(e.target.value)
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

        {/* What is about to happen, before it happens. */}
        <div className="mt-2 min-h-[1.1rem] text-[11.5px] leading-snug">{note}</div>
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
