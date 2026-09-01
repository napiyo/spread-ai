import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import {
  Copy, Cpu, Laptop, Link2, LogOut, Monitor, Radio, Smartphone, Tablet, Users, Wifi, WifiOff,
} from 'lucide-react'
import { GridField } from '@/ui/fx/GridField'
import { AnimatedBeam } from '@/ui/fx/AnimatedBeam'
import { Spotlight } from '@/ui/fx/Spotlight'
import { NumberTicker } from '@/ui/fx/NumberTicker'
import { Button } from '@/ui/primitives/Button'
import { Chip, LiveDot } from '@/ui/primitives/Chip'
import { useMeshStore } from '@/store/mesh'
import { useDevice } from '@/store/device'
import { normaliseRoomCode } from '@/mesh/transport'
import type { MeshPeer } from '@/mesh/mesh'
import { bytes } from '@/lib/format'
import { riseIn, spring, stagger } from '@/lib/motion'
import { cn } from '@/lib/cn'

const KIND_ICON = { phone: Smartphone, tablet: Tablet, laptop: Laptop, desktop: Monitor }

export function Fleet() {
  const deviceInit = useDevice((s) => s.init)
  const { room, peers, signalState, error, join, leave, mesh } = useMeshStore()

  useEffect(() => {
    void deviceInit()
  }, [deviceInit])

  return (
    <div className="relative min-h-dvh">
      <GridField fade="top" className="opacity-50" />
      <div className="relative mx-auto max-w-6xl px-6 py-14">
        <h1 className="text-[34px] leading-tight font-semibold tracking-[-0.03em]">Your fleet</h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-dim">
          Open this page on another device and enter the same code. They'll find each other and talk
          directly — the pairing service only passes along the introduction and never sees a single
          token.
        </p>

        <RoomBar
          room={room}
          state={signalState}
          error={error}
          connected={Boolean(mesh)}
          onJoin={join}
          onLeave={leave}
        />

        {mesh ? <Graph peers={peers} /> : <NotConnected />}

        {peers.length > 0 && <PeerList peers={peers} />}
      </div>
    </div>
  )
}

/* ── Room ─────────────────────────────────────────────────────────────── */

const STATE_COPY: Record<string, { text: string; tone: 'live' | 'good' | 'warn' | 'bad' }> = {
  idle: { text: 'not connected', tone: 'warn' },
  connecting: { text: 'connecting', tone: 'warn' },
  connected: { text: 'listening for devices', tone: 'good' },
  closed: { text: 'disconnected', tone: 'warn' },
  error: { text: 'pairing service unreachable', tone: 'bad' },
}

function RoomBar({
  room, state, error, connected, onJoin, onLeave,
}: {
  room: string | null
  state: string
  error: string | null
  connected: boolean
  onJoin: (room?: string) => Promise<void>
  onLeave: () => void
}) {
  const [input, setInput] = useState('')
  const [copied, setCopied] = useState(false)
  const status = STATE_COPY[state] ?? STATE_COPY.idle

  return (
    <div className="mt-8">
      <div className="flex flex-wrap items-center gap-3">
        {connected && room ? (
          <>
            <div className="flex items-center gap-3 rounded-[10px] border border-line-bright bg-panel/60 px-4 py-2.5">
              <span className="text-[10.5px] tracking-wide text-mute uppercase">Room</span>
              <span className="font-mono text-[19px] tracking-[0.22em] text-gradient">{room}</span>
              <button
                aria-label="Copy room code"
                onClick={() => {
                  void navigator.clipboard?.writeText(room)
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1600)
                }}
                className="text-mute transition-colors hover:text-fore"
              >
                <Copy size={14} />
              </button>
            </div>
            {copied && (
              <motion.span
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                className="text-[12px] text-lime"
              >
                copied
              </motion.span>
            )}
            <Chip
              tone={status.tone}
              icon={
                state === 'connected' ? (
                  <LiveDot tone="var(--color-lime)" />
                ) : state === 'error' ? (
                  <WifiOff size={11} />
                ) : (
                  <Wifi size={11} />
                )
              }
            >
              {status.text}
            </Chip>
            <Button size="sm" variant="ghost" onClick={onLeave}>
              <LogOut size={13} /> Leave
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" onClick={() => void onJoin()}>
              <Radio size={15} /> Start a fleet
            </Button>
            <span className="text-[13px] text-mute">or join one</span>
            <input
              value={input}
              onChange={(e) => setInput(normaliseRoomCode(e.target.value).slice(0, 8))}
              onKeyDown={(e) => e.key === 'Enter' && input && void onJoin(input)}
              placeholder="CODE"
              className="h-10 w-32 rounded-[9px] border border-line-bright bg-panel/60 px-3 text-center font-mono text-[15px] tracking-[0.2em] uppercase outline-none placeholder:tracking-normal placeholder:text-mute focus:border-cy/50"
            />
            <Button variant="outline" disabled={input.length < 4} onClick={() => void onJoin(input)}>
              Join
            </Button>
          </>
        )}
      </div>

      {error && (
        <div className="mt-3 max-w-2xl text-[13px] leading-relaxed text-rose">
          {error}
          <span className="mt-1 block text-mute">
            The pairing service is a small process you run yourself — <code className="font-mono">npm run dev:signal</code>.
            Devices on the same network can also pair with no service at all.
          </span>
        </div>
      )}
    </div>
  )
}

/* ── Graph ────────────────────────────────────────────────────────────── */

function Graph({ peers }: { peers: MeshPeer[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const centreRef = useRef<HTMLDivElement>(null)
  const peerRefs = useRef(new Map<string, HTMLDivElement>())
  const here = useDevice((s) => s.capability)
  const [, force] = useState(0)

  // The beams need both endpoints mounted before they can measure, so one
  // extra render after layout settles is unavoidable.
  useEffect(() => {
    const id = requestAnimationFrame(() => force((n) => n + 1))
    return () => cancelAnimationFrame(id)
  }, [peers.length])

  const positions = useMemo(() => {
    const n = Math.max(1, peers.length)
    return peers.map((_, i) => {
      const angle = (i / n) * Math.PI * 2 - Math.PI / 2
      return { x: 50 + Math.cos(angle) * 34, y: 50 + Math.sin(angle) * 33 }
    })
  }, [peers])

  return (
    <div
      ref={containerRef}
      className="relative mt-10 h-[420px] overflow-hidden rounded-lg border border-line bg-panel/20"
    >
      <GridField fade="radial" className="opacity-70" />

      {peers.map((p, i) => {
        const el = peerRefs.current.get(p.peerId)
        if (!el) return null
        return (
          <AnimatedBeam
            key={`beam-${p.peerId}`}
            containerRef={containerRef}
            fromRef={centreRef}
            toRef={{ current: el }}
            // Beam speed tracks real bytes on the wire, so a still line means a
            // genuinely idle link rather than a decorative pause.
            flow={p.state === 'connected' ? Math.min(1, p.throughput / 40_000) : 0}
            curvature={i % 2 === 0 ? 26 : -26}
            dashed={p.state !== 'connected'}
          />
        )
      })}

      <div
        ref={centreRef}
        className="absolute top-1/2 left-1/2 z-10 -translate-x-1/2 -translate-y-1/2"
      >
        <Node
          label={here?.label ?? 'This device'}
          sub="this device"
          kind={here?.kind ?? 'laptop'}
          measured={here?.source === 'measured'}
          primary
        />
      </div>

      <AnimatePresence>
        {peers.map((p, i) => (
          <motion.div
            key={p.peerId}
            ref={(el) => {
              if (el) peerRefs.current.set(p.peerId, el)
              else peerRefs.current.delete(p.peerId)
            }}
            initial={{ opacity: 0, scale: 0.7 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.7 }}
            transition={spring.soft}
            className="absolute z-10 -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${positions[i].x}%`, top: `${positions[i].y}%` }}
          >
            <Node
              label={p.label}
              sub={
                p.state === 'connected'
                  ? p.rttMs != null
                    ? `${p.rttMs.toFixed(0)} ms away`
                    : 'connected'
                  : p.state
              }
              kind={p.capability?.kind ?? 'laptop'}
              measured={p.capability?.source === 'measured'}
              dim={p.state !== 'connected'}
            />
          </motion.div>
        ))}
      </AnimatePresence>

      {peers.length === 0 && (
        <div className="absolute inset-x-0 bottom-8 text-center text-[13px] text-mute">
          Waiting for another device to join.
        </div>
      )}
    </div>
  )
}

function Node({
  label, sub, kind, measured, primary, dim,
}: {
  label: string
  sub: string
  kind: 'phone' | 'tablet' | 'laptop' | 'desktop'
  measured?: boolean
  primary?: boolean
  dim?: boolean
}) {
  const Icon = KIND_ICON[kind] ?? Laptop
  return (
    <div className={cn('flex flex-col items-center gap-2', dim && 'opacity-50')}>
      <div
        className={cn(
          'relative grid h-16 w-16 place-items-center rounded-2xl border backdrop-blur-md',
          primary ? 'border-cy/45 bg-cy/[0.07]' : 'border-line-bright bg-panel/80',
        )}
      >
        <Icon size={22} className={primary ? 'text-cy' : 'text-dim'} />
        {measured && (
          <span className="absolute -top-1 -right-1 grid h-4 w-4 place-items-center rounded-full bg-lime text-[9px] font-bold text-void">
            ✓
          </span>
        )}
      </div>
      <div className="max-w-[140px] text-center">
        <div className="truncate text-[12.5px] font-medium">{label}</div>
        <div className="truncate text-[10.5px] text-mute">{sub}</div>
      </div>
    </div>
  )
}

function NotConnected() {
  return (
    <div className="mt-10 rounded-lg border border-dashed border-line-bright bg-panel/20 px-6 py-16 text-center">
      <Users size={22} className="mx-auto text-mute" />
      <h2 className="mt-3 text-[15px] font-medium">No fleet yet</h2>
      <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-mute">
        Start one and you'll get a short code. Open this page on your phone or another laptop,
        type the code, and the two will connect directly to each other.
      </p>
    </div>
  )
}

/* ── Peer detail ──────────────────────────────────────────────────────── */

function PeerList({ peers }: { peers: MeshPeer[] }) {
  return (
    <motion.div
      className="mt-8 grid gap-3 md:grid-cols-2 lg:grid-cols-3"
      initial="hidden"
      animate="show"
      variants={stagger(0, 0.05)}
    >
      {peers.map((p) => (
        <motion.div key={p.peerId} variants={riseIn}>
          <Spotlight className="panel h-full rounded-md">
            <div className="p-4">
              <div className="flex items-center gap-2">
                <LiveDot
                  active={p.state === 'connected'}
                  tone={p.state === 'connected' ? 'var(--color-lime)' : 'var(--color-amber)'}
                />
                <span className="min-w-0 flex-1 truncate text-[14px] font-medium">{p.label}</span>
                {p.capability?.hasWebGpu === false && <Chip tone="warn">no webgpu</Chip>}
              </div>

              {/* What that device has in memory is the thing that decides
                  whether it can take a turn, so it belongs on the card. */}
              <div className="mt-2 flex items-center gap-1.5 text-[11.5px]">
                {p.loaded ? (
                  <Chip tone="good" icon={<Cpu size={11} />}>
                    {p.loaded.label}
                  </Chip>
                ) : (
                  <span className="text-mute">no model loaded — can't take a turn yet</span>
                )}
              </div>

              {p.capability && (
                <div className="mt-3 grid grid-cols-3 gap-3">
                  <Field label="Bandwidth" value={`${Math.round(p.capability.bandwidthGBs)} GB/s`} />
                  <Field label="Max buffer" value={bytes(p.capability.maxBufferBytes, 0)} />
                  <Field
                    label="Round trip"
                    value={p.rttMs != null ? `${p.rttMs.toFixed(0)} ms` : '—'}
                  />
                </div>
              )}

              <div className="mt-3 flex items-center gap-1.5 border-t border-line pt-3 text-[11px] text-mute">
                <Link2 size={11} />
                <NumberTicker value={p.throughput / 1024} decimals={1} />
                <span>KB/s over the direct link</span>
              </div>
            </div>
          </Spotlight>
        </motion.div>
      ))}
    </motion.div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] tracking-wide text-mute uppercase">{label}</div>
      <div className="mt-0.5 text-[13px] font-medium">{value}</div>
    </div>
  )
}
