import { create } from 'zustand'
import { probeDevice, requestPersistentStorage } from '@/capability/probe'
import { runBenchmark, type BenchPhase, type BenchResult } from '@/capability/bench'
import { toCapability, type Capability } from '@/capability/identify'
import type { DeviceProbe } from '@/capability/types'

const BENCH_KEY = 'spreadai.bench.v1'
const LABEL_KEY = 'spreadai.device.label'
const CAL_KEY = 'spreadai.calibration.v1'

function load<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

interface DeviceState {
  probe: DeviceProbe | null
  bench: BenchResult | null
  capability: Capability | null
  probing: boolean
  benching: boolean
  benchPhase: BenchPhase | null
  benchProgress: number
  error: string | null
  persistentStorage: boolean

  init: () => Promise<void>
  benchmark: () => Promise<void>
  setLabel: (label: string) => void
  setCalibration: (c: Capability['calibration']) => void
}

/**
 * Benchmark results are cached because the measurement costs GPU time and does
 * not change between visits on the same hardware. Calibration is kept separate
 * since it improves every time a real model runs.
 */
export const useDevice = create<DeviceState>((set, get) => ({
  probe: null,
  bench: null,
  capability: null,
  probing: false,
  benching: false,
  benchPhase: null,
  benchProgress: 0,
  error: null,
  persistentStorage: false,

  async init() {
    if (get().probing || get().probe) return
    set({ probing: true, error: null })
    try {
      const probe = await probeDevice()
      const bench = load<BenchResult>(BENCH_KEY)
      const label = localStorage.getItem(LABEL_KEY) ?? undefined
      const calibration = load<Capability['calibration']>(CAL_KEY)
      const capability = { ...toCapability(probe, bench, { label }), calibration }
      set({ probe, bench, capability, probing: false })
      requestPersistentStorage().then((persistentStorage) => set({ persistentStorage }))
    } catch (e) {
      set({ probing: false, error: e instanceof Error ? e.message : String(e) })
    }
  },

  async benchmark() {
    const { probe, benching } = get()
    if (!probe || benching) return
    set({ benching: true, error: null, benchPhase: 'init', benchProgress: 0 })
    try {
      const bench = await runBenchmark({
        onPhase: (benchPhase, benchProgress) => set({ benchPhase, benchProgress }),
      })
      localStorage.setItem(BENCH_KEY, JSON.stringify(bench))
      const label = localStorage.getItem(LABEL_KEY) ?? undefined
      set({
        bench,
        capability: { ...toCapability(probe, bench, { label }), calibration: get().capability?.calibration ?? null },
        benching: false,
        benchPhase: 'done',
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      set({ benching: false, benchPhase: null, error: msg.includes('Abort') ? null : msg })
    }
  },

  setLabel(label) {
    localStorage.setItem(LABEL_KEY, label)
    const cap = get().capability
    if (cap) set({ capability: { ...cap, label } })
  },

  setCalibration(calibration) {
    if (calibration) localStorage.setItem(CAL_KEY, JSON.stringify(calibration))
    const cap = get().capability
    if (cap) set({ capability: { ...cap, calibration } })
  },
}))
