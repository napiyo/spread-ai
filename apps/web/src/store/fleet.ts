import { create } from 'zustand'
import { capabilityFromSpec, type Capability } from '@/capability/identify'
import { DEVICE_BY_ID, type DeviceSpec } from '@/capability/deviceDb'
import { useDevice } from './device'

const KEY = 'spreadai.fleet.v1'

/** A device the user told us about but that is not connected. */
export interface DeclaredDevice {
  key: string
  specId: string
  count: number
}

interface FleetState {
  declared: DeclaredDevice[]
  add: (specId: string) => void
  remove: (key: string) => void
  setCount: (key: string, count: number) => void
  clear: () => void
}

function load(): DeclaredDevice[] {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? (JSON.parse(raw) as DeclaredDevice[]) : []
    // A device id we no longer know about would produce a fleet with holes in
    // it, so drop anything the table has since lost.
    return parsed.filter((d) => DEVICE_BY_ID.has(d.specId))
  } catch {
    return []
  }
}

function save(declared: DeclaredDevice[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(declared))
  } catch {
    /* private browsing */
  }
}

export const useFleet = create<FleetState>((set, get) => ({
  declared: load(),

  add(specId) {
    const existing = get().declared.find((d) => d.specId === specId)
    const declared = existing
      ? get().declared.map((d) => (d.specId === specId ? { ...d, count: Math.min(6, d.count + 1) } : d))
      : [...get().declared, { key: `${specId}:${Date.now()}`, specId, count: 1 }]
    save(declared)
    set({ declared })
  },

  remove(key) {
    const declared = get().declared.filter((d) => d.key !== key)
    save(declared)
    set({ declared })
  },

  setCount(key, count) {
    const declared =
      count <= 0
        ? get().declared.filter((d) => d.key !== key)
        : get().declared.map((d) => (d.key === key ? { ...d, count: Math.min(6, count) } : d))
    save(declared)
    set({ declared })
  },

  clear() {
    save([])
    set({ declared: [] })
  },
}))

export interface FleetMember {
  cap: Capability
  spec: DeviceSpec | null
  /** True for the device you are looking at right now, which we measured. */
  isThisDevice: boolean
  declaredKey?: string
}

/**
 * The fleet the planner reasons over: this device (measured) plus anything the
 * user declared (projected from the table). Measured always comes first, so a
 * recommendation is anchored to real hardware wherever possible.
 */
export function useFleetMembers(): FleetMember[] {
  const here = useDevice((s) => s.capability)
  const declared = useFleet((s) => s.declared)

  const members: FleetMember[] = []
  if (here) members.push({ cap: here, spec: here.match?.spec ?? null, isThisDevice: true })

  for (const d of declared) {
    const spec = DEVICE_BY_ID.get(d.specId)
    if (!spec) continue
    for (let i = 0; i < d.count; i++) {
      members.push({
        cap: capabilityFromSpec(spec, i),
        spec,
        isThisDevice: false,
        declaredKey: d.key,
      })
    }
  }
  return members
}
