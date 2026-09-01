/** Everything we can learn about a device without asking the user. */
export interface DeviceProbe {
  /** Stable per-browser-profile id, persisted in localStorage. */
  id: string
  createdAt: number

  webgpu: WebGpuProbe | null
  /** Why WebGPU is unavailable, when it is. User-facing. */
  webgpuUnavailableReason: string | null

  platform: PlatformProbe
  storage: StorageProbe
  network: NetworkProbe
}

export interface WebGpuProbe {
  vendor: string
  architecture: string
  device: string
  description: string
  /** Largest single GPUBuffer the implementation will hand out. */
  maxBufferSize: number
  maxStorageBufferBindingSize: number
  maxComputeWorkgroupStorageSize: number
  maxComputeInvocationsPerWorkgroup: number
  /** Native fp16 in shaders — roughly doubles usable model size and speed. */
  hasF16: boolean
  features: string[]
  /** True when the adapter reports itself as software/fallback. */
  isFallbackAdapter: boolean
}

export interface PlatformProbe {
  /** navigator.deviceMemory, GB, coarse and often absent outside Chromium. */
  deviceMemoryGb: number | null
  cores: number | null
  /** From UA-CH where available, else parsed from the UA string. */
  os: string
  osVersion: string | null
  browser: string
  browserVersion: string | null
  /** UA-CH `model`, e.g. "Pixel 8 Pro". Empty on Apple platforms by design. */
  model: string | null
  arch: string | null
  mobile: boolean
  /** Apple hides the iPhone model entirely; this is our best structural guess. */
  appleFamily: 'iphone' | 'ipad' | 'mac' | null
  screen: { w: number; h: number; dpr: number }
}

export interface StorageProbe {
  quotaBytes: number | null
  usageBytes: number | null
  /** Storage that survives eviction pressure — matters for multi-GB weights. */
  persisted: boolean
  hasOpfs: boolean
  hasCacheApi: boolean
}

export interface NetworkProbe {
  online: boolean
  /** navigator.connection, Chromium-only. */
  effectiveType: string | null
  downlinkMbps: number | null
  rttMs: number | null
  saveData: boolean
}
