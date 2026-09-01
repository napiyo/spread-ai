import { create } from 'zustand'
import { Mesh, type MeshPeer } from '@/mesh/mesh'
import { WsSignaler } from '@/mesh/signalWs'
import { generateRoomCode, normaliseRoomCode, type SignalState } from '@/mesh/transport'
import { MeshSyncProvider } from '@/sync/meshProvider'
import { useDevice } from './device'
import { useEngine } from './engine'
import { serveWork, type ServeEngine } from '@/mesh/serve'
import type { LoadedModel } from '@/mesh/protocol'

const ROOM_KEY = 'spreadai.room'
const PEER_KEY = 'spreadai.peer'

/**
 * Identity within a room is per *tab*, not per device.
 *
 * The device id is stable across tabs of the same browser profile, so using it
 * directly meant two tabs on one machine claimed the same identity and evicted
 * each other from the room. sessionStorage is per-tab and survives reloads,
 * which is exactly the lifetime a mesh membership should have.
 */
function sessionPeerId(deviceId: string): string {
  let id = sessionStorage.getItem(PEER_KEY)
  if (!id) {
    id = `${deviceId.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`
    sessionStorage.setItem(PEER_KEY, id)
  }
  return id
}

/** Where the introduction service lives. Only ever sees SDP. */
function signalUrl(): string {
  const env = import.meta.env.VITE_SIGNAL_URL as string | undefined
  if (env) return env
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  // In development the relay runs beside the dev server on its own port.
  return `${proto}://${location.hostname}:8787`
}

interface MeshState {
  mesh: Mesh | null
  provider: MeshSyncProvider | null
  room: string | null
  signalState: SignalState
  peers: MeshPeer[]
  error: string | null

  join: (room?: string) => Promise<void>
  leave: () => void
  refresh: () => void
}

/** Torn down on leave: the announcer subscription and the greeting timer. */
let teardown: (() => void)[] = []

/** What we tell the room we have in memory. Null while nothing is loaded. */
function localLoaded(): LoadedModel | null {
  const { status, model } = useEngine.getState()
  if (status !== 'ready' || !model) return null
  return { id: model.id, label: model.label, contextWindow: model.contextWindow }
}

export const useMeshStore = create<MeshState>((set, get) => ({
  mesh: null,
  provider: null,
  room: null,
  signalState: 'idle',
  peers: [],
  error: null,

  async join(roomInput) {
    if (get().mesh) get().leave()

    const capability = useDevice.getState().capability
    if (!capability) {
      set({ error: 'Still working out what this device is. Try again in a moment.' })
      return
    }

    const room = roomInput
      ? normaliseRoomCode(roomInput)
      : (localStorage.getItem(ROOM_KEY) ?? generateRoomCode())
    localStorage.setItem(ROOM_KEY, room)

    const peerId = sessionPeerId(capability.deviceId)
    const signaler = new WsSignaler(signalUrl(), room, peerId)
    const mesh = new Mesh(signaler, {
      label: capability.label,
      capability,
      loaded: localLoaded(),
    })

    mesh.onChange = () => get().refresh()
    mesh.onSignalState = (signalState) => set({ signalState })
    mesh.onError = (error) => set({ error })

    teardown.push(serveWork(mesh, engineFacade))
    const provider = new MeshSyncProvider(mesh)

    set({ mesh, provider, room, error: null })

    try {
      await mesh.connect()
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) })
    }

    // A device that has just connected needs our document state before it can
    // show anything, so every newly connected peer gets greeted with our state
    // vector. That is what makes a conversation started on the laptop appear on
    // a phone that was not in the room when it began.
    let known = new Set<string>()
    const tick = setInterval(() => {
      const current = get().mesh
      if (!current) {
        clearInterval(tick)
        return
      }
      for (const p of current.list()) {
        if (p.state === 'connected' && !known.has(p.peerId)) {
          known.add(p.peerId)
          provider.greet(p.peerId)
        }
      }
      known = new Set([...known].filter((id) => current.list().some((p) => p.peerId === id)))
      get().refresh()
    }, 1000)
    teardown.push(() => clearInterval(tick))

    // Loading or dropping a model changes what this device can do for the
    // others, so the room is told the moment it happens rather than the next
    // time somebody asks.
    let announced = localLoaded()?.id ?? null
    const unsubscribeEngine = useEngine.subscribe(() => {
      const loaded = localLoaded()
      if ((loaded?.id ?? null) === announced) return
      announced = loaded?.id ?? null
      const cap = useDevice.getState().capability
      if (cap) mesh.updateSelf({ label: cap.label, capability: cap, loaded })
    })
    teardown.push(unsubscribeEngine)
  },

  leave() {
    for (const off of teardown) off()
    teardown = []
    get().provider?.destroy()
    get().mesh?.close()
    set({ mesh: null, provider: null, peers: [], signalState: 'idle' })
  },

  refresh() {
    const mesh = get().mesh
    set({ peers: mesh ? mesh.list() : [] })
  },
}))

/**
 * The engine, as the peer-serving code needs to see it.
 *
 * Narrowing it to this shape is what keeps `mesh/serve` free of the stores, and
 * therefore testable against a fake engine rather than a real GPU.
 */
function engineFacade(): ServeEngine {
  const engine = useEngine.getState()
  const ready = engine.status === 'ready' ? engine.model : null

  return {
    deviceLabel: useDevice.getState().capability?.label ?? 'that device',
    loadedModelId: ready?.id ?? null,
    loadedModelLabel: ready?.label ?? null,
    busy: engine.generating,
    generate: (params, onToken) =>
      engine.generate(
        {
          messages: params.messages as { role: 'user' | 'assistant' | 'system'; content: string }[],
          maxTokens: params.maxTokens,
          temperature: params.temperature,
          topP: params.topP,
          seed: params.seed,
        },
        onToken,
      ),
    lastError: () => useEngine.getState().error?.message ?? null,
    interrupt: () => void useEngine.getState().interrupt(),
    capability: () => useDevice.getState().capability,
  }
}
