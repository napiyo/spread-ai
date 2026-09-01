import type {
  DeviceProbe,
  NetworkProbe,
  PlatformProbe,
  StorageProbe,
  WebGpuProbe,
} from './types'

const ID_KEY = 'spreadai.device.id'

function deviceId(): string {
  let id = localStorage.getItem(ID_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(ID_KEY, id)
  }
  return id
}

/* ── WebGPU ───────────────────────────────────────────────────────────── */

async function probeWebGpu(): Promise<{ gpu: WebGpuProbe | null; reason: string | null }> {
  if (!('gpu' in navigator) || !navigator.gpu) {
    return {
      gpu: null,
      reason: 'This browser has no WebGPU. Chrome, Edge, or Safari 26+ can run models here.',
    }
  }

  let adapter: GPUAdapter | null = null
  try {
    adapter =
      (await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })) ??
      (await navigator.gpu.requestAdapter())
  } catch (err) {
    return { gpu: null, reason: `WebGPU adapter request failed: ${String(err)}` }
  }

  if (!adapter) {
    return {
      gpu: null,
      reason:
        'WebGPU is present but no adapter was granted. On Linux this usually means the GPU is unsupported; in a VM there may be no GPU at all.',
    }
  }

  // `adapter.info` is the current spec surface; `requestAdapterInfo()` was the
  // older one and is gone from recent Chromium. Support both, expect neither.
  let info: Partial<GPUAdapterInfo> = {}
  try {
    info =
      (adapter.info as GPUAdapterInfo | undefined) ??
      (await (adapter as unknown as { requestAdapterInfo?: () => Promise<GPUAdapterInfo> })
        .requestAdapterInfo?.()) ??
      {}
  } catch {
    /* Adapter info is privacy-gated in several browsers; absence is normal. */
  }

  const l = adapter.limits
  return {
    gpu: {
      vendor: info.vendor ?? '',
      architecture: info.architecture ?? '',
      device: info.device ?? '',
      description: info.description ?? '',
      maxBufferSize: Number(l.maxBufferSize ?? 0),
      maxStorageBufferBindingSize: Number(l.maxStorageBufferBindingSize ?? 0),
      maxComputeWorkgroupStorageSize: Number(l.maxComputeWorkgroupStorageSize ?? 0),
      maxComputeInvocationsPerWorkgroup: Number(l.maxComputeInvocationsPerWorkgroup ?? 0),
      hasF16: adapter.features.has('shader-f16'),
      features: [...adapter.features],
      isFallbackAdapter: Boolean(
        (adapter as unknown as { isFallbackAdapter?: boolean }).isFallbackAdapter,
      ),
    },
    reason: null,
  }
}

/* ── Platform ─────────────────────────────────────────────────────────── */

interface UaBrand { brand: string; version: string }
interface UaData {
  brands: UaBrand[]
  mobile: boolean
  platform: string
  getHighEntropyValues?(hints: string[]): Promise<Record<string, unknown>>
}

/** Picks the real engine brand out of the deliberately-noisy GREASE list. */
function realBrand(brands: UaBrand[]): UaBrand | null {
  const junk = /not[)(\-.:;=?_/A-Za-z ]*a[)(\-.:;=?_/A-Za-z ]*brand/i
  const known = ['Google Chrome', 'Microsoft Edge', 'Opera', 'Brave', 'Chromium']
  const named = brands.find((b) => known.includes(b.brand) && b.brand !== 'Chromium')
  return named ?? brands.find((b) => !junk.test(b.brand)) ?? null
}

function parseUaString(ua: string) {
  const browser = /Firefox\/([\d.]+)/.exec(ua)
    ? { browser: 'Firefox', version: /Firefox\/([\d.]+)/.exec(ua)![1] }
    : /Edg\/([\d.]+)/.exec(ua)
      ? { browser: 'Edge', version: /Edg\/([\d.]+)/.exec(ua)![1] }
      : /Chrome\/([\d.]+)/.exec(ua)
        ? { browser: 'Chrome', version: /Chrome\/([\d.]+)/.exec(ua)![1] }
        : /Version\/([\d.]+).*Safari/.exec(ua)
          ? { browser: 'Safari', version: /Version\/([\d.]+).*Safari/.exec(ua)![1] }
          : { browser: 'Unknown', version: null as string | null }

  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Macintosh|Mac OS X/.test(ua)
      ? 'macOS'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'Unknown'

  const osVersion =
    /OS (\d+[_.]\d+)/.exec(ua)?.[1]?.replace('_', '.') ??
    /Android (\d+(?:\.\d+)?)/.exec(ua)?.[1] ??
    /Windows NT ([\d.]+)/.exec(ua)?.[1] ??
    null

  return { ...browser, os, osVersion }
}

/**
 * iPadOS reports itself as "Macintosh" in Safari. Touch points are the only
 * reliable tell, so we use them rather than trusting the UA.
 */
function appleFamily(os: string, ua: string): PlatformProbe['appleFamily'] {
  const touch = navigator.maxTouchPoints ?? 0
  if (/iPhone|iPod/.test(ua)) return 'iphone'
  if (/iPad/.test(ua)) return 'ipad'
  if (os === 'macOS') return touch > 1 ? 'ipad' : 'mac'
  return null
}

async function probePlatform(): Promise<PlatformProbe> {
  const ua = navigator.userAgent
  const parsed = parseUaString(ua)
  const uaData = (navigator as Navigator & { userAgentData?: UaData }).userAgentData

  let os = parsed.os
  let osVersion = parsed.osVersion
  let browser = parsed.browser
  let browserVersion = parsed.version
  let model: string | null = null
  let arch: string | null = null
  let mobile = /Mobi|Android|iPhone|iPad/.test(ua)

  if (uaData) {
    mobile = uaData.mobile
    const brand = realBrand(uaData.brands)
    if (brand) {
      browser = brand.brand
      browserVersion = brand.version
    }
    if (uaData.platform) os = uaData.platform
    try {
      // High-entropy hints need permission in some configurations and reject
      // silently in others; the low-entropy values above already stand alone.
      const hi = await uaData.getHighEntropyValues?.([
        'platformVersion',
        'model',
        'architecture',
        'bitness',
        'fullVersionList',
      ])
      if (hi) {
        osVersion = (hi.platformVersion as string) || osVersion
        model = ((hi.model as string) || '').trim() || null
        arch = (hi.architecture as string) || null
      }
    } catch {
      /* ignore — hints are best-effort */
    }
  }

  return {
    deviceMemoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
    cores: navigator.hardwareConcurrency ?? null,
    os,
    osVersion,
    browser,
    browserVersion,
    model,
    arch,
    mobile,
    appleFamily: appleFamily(parsed.os, ua),
    screen: {
      w: window.screen?.width ?? window.innerWidth,
      h: window.screen?.height ?? window.innerHeight,
      dpr: window.devicePixelRatio ?? 1,
    },
  }
}

/* ── Storage & network ────────────────────────────────────────────────── */

async function probeStorage(): Promise<StorageProbe> {
  let quotaBytes: number | null = null
  let usageBytes: number | null = null
  let persisted = false

  try {
    const est = await navigator.storage?.estimate?.()
    quotaBytes = est?.quota ?? null
    usageBytes = est?.usage ?? null
  } catch {
    /* ignore */
  }
  try {
    persisted = (await navigator.storage?.persisted?.()) ?? false
  } catch {
    /* ignore */
  }

  return {
    quotaBytes,
    usageBytes,
    persisted,
    hasOpfs: typeof navigator.storage?.getDirectory === 'function',
    hasCacheApi: 'caches' in globalThis,
  }
}

function probeNetwork(): NetworkProbe {
  const c = (navigator as Navigator & {
    connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean }
  }).connection
  return {
    online: navigator.onLine,
    effectiveType: c?.effectiveType ?? null,
    downlinkMbps: c?.downlink ?? null,
    rttMs: c?.rtt ?? null,
    saveData: Boolean(c?.saveData),
  }
}

/* ── Entry point ──────────────────────────────────────────────────────── */

let cached: Promise<DeviceProbe> | null = null

/** Probes run concurrently; a failure in one never blocks the others. */
export function probeDevice(force = false): Promise<DeviceProbe> {
  if (cached && !force) return cached
  cached = (async () => {
    const [gpuResult, platform, storage] = await Promise.all([
      probeWebGpu(),
      probePlatform(),
      probeStorage(),
    ])
    return {
      id: deviceId(),
      createdAt: Date.now(),
      webgpu: gpuResult.gpu,
      webgpuUnavailableReason: gpuResult.reason,
      platform,
      storage,
      network: probeNetwork(),
    }
  })()
  return cached
}

/**
 * Ask the browser to make our storage non-evictable. Model weights are the
 * whole point of the offline story, so this matters more than it usually does.
 * Chromium grants silently on engaged sites; Safari always denies.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true
    return (await navigator.storage?.persist?.()) ?? false
  } catch {
    return false
  }
}
