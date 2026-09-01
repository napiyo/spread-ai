import { create } from 'zustand'
import { Mesh, type MeshPeer } from '@/mesh/mesh'
import { WsSignaler } from '@/mesh/signalWs'
import { generateRoomCode, normaliseRoomCode, type SignalState } from '@/mesh/transport'
import { MeshSyncProvider } from '@/sync/meshProvider'
import { useDevice } from './device'
import { useEngine } from './engine'
import type { GenerateParams } from '@/mesh/protocol'

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
    const mesh = new Mesh(signaler, { label: capability.label, capability })

    mesh.onChange = () => get().refresh()
    mesh.onSignalState = (signalState) => set({ signalState })
    mesh.onError = (error) => set({ error })

    registerHandlers(mesh)
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
  },

  leave() {
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
 * What this device is willing to do on behalf of another.
 *
 * Deliberately narrow: a peer can ask what we are capable of, and can ask us to
 * run a generation on a model *we* already have loaded. It cannot make us
 * download anything or reach outside the tab.
 */
function registerHandlers(mesh: Mesh) {
  mesh.handle('capability', () => useDevice.getState().capability)

  mesh.handle('generate', async (params, from) => {
    const p = params as GenerateParams
    const engine = useEngine.getState()
    if (engine.status !== 'ready') throw new Error('No model is loaded on that device.')
    if (engine.model?.id !== p.modelId) {
      throw new Error(`That device has ${engine.model?.label ?? 'nothing'} loaded, not ${p.modelId}.`)
    }

    let text = ''
    const result = await engine.generate(
      {
        messages: p.messages as { role: 'user' | 'assistant' | 'system'; content: string }[],
        maxTokens: p.maxTokens,
        temperature: p.temperature,
      },
      (delta) => {
        text += delta
        // Stream back as events so the caller sees tokens as they appear
        // rather than waiting for the whole reply.
        mesh.broadcast(`gen:${from}`, { delta })
      },
    )
    return result ?? { text, stats: null }
  })

  mesh.handle('interrupt', () => {
    void useEngine.getState().interrupt()
    return true
  })

  mesh.handle('listCachedModels', async () => {
    // Which models this device already has on disk, so a peer can pull weights
    // from it instead of the internet.
    if (!('caches' in globalThis)) return []
    const names = await caches.keys()
    return names.filter((n) => /webllm|mlc|transformers/i.test(n))
  })
}
