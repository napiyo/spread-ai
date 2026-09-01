/**
 * A curated table of devices we can recognise, with the numbers that decide
 * whether a model runs and how fast.
 *
 * `bandwidthGBs` is *nominal* peak memory bandwidth from published specs. Real
 * WebGPU throughput lands around 55-85% of it; we never use the nominal figure
 * where a measured one exists. This table exists for two jobs only:
 *   1. naming the device you are on ("looks like an M4 Pro"), and
 *   2. projecting devices you *don't* have in front of you, which is the whole
 *      point of the advisor.
 */
export interface DeviceSpec {
  id: string
  label: string
  chip: string
  kind: 'phone' | 'tablet' | 'laptop' | 'desktop'
  /** Unified or dedicated memory, GB. Ranges collapse to the common config. */
  memGb: number
  /** Nominal peak memory bandwidth, GB/s. */
  bandwidthGBs: number
  /** Nominal peak fp16 GPU throughput, GFLOP/s. */
  gflopsF16: number
  /**
   * Practical ceiling for a single WebGPU buffer, MB. This is what actually
   * decides whether a model fits, and on iOS it is brutal.
   */
  webgpuMaxBufferMb: number
  /** Fraction of system memory a browser tab can realistically use for weights. */
  usableMemFraction: number
  year: number
  note?: string
}

const APPLE_PHONE_NOTE =
  'iOS Safari caps a single WebGPU buffer at roughly 256 MB, so iPhones carry small shards no matter how much RAM they have.'

export const DEVICE_DB: DeviceSpec[] = [
  // -- Mac ---------------------------------------------------------------
  { id: 'm1', label: 'MacBook Air M1', chip: 'M1', kind: 'laptop', memGb: 8, bandwidthGBs: 68, gflopsF16: 2600, webgpuMaxBufferMb: 2048, usableMemFraction: 0.5, year: 2020 },
  { id: 'm1-pro', label: 'MacBook Pro M1 Pro', chip: 'M1 Pro', kind: 'laptop', memGb: 16, bandwidthGBs: 200, gflopsF16: 5300, webgpuMaxBufferMb: 4096, usableMemFraction: 0.6, year: 2021 },
  { id: 'm1-max', label: 'MacBook Pro M1 Max', chip: 'M1 Max', kind: 'laptop', memGb: 32, bandwidthGBs: 400, gflopsF16: 10600, webgpuMaxBufferMb: 4096, usableMemFraction: 0.65, year: 2021 },
  { id: 'm2', label: 'MacBook Air M2', chip: 'M2', kind: 'laptop', memGb: 8, bandwidthGBs: 100, gflopsF16: 3600, webgpuMaxBufferMb: 2048, usableMemFraction: 0.5, year: 2022 },
  { id: 'm2-pro', label: 'MacBook Pro M2 Pro', chip: 'M2 Pro', kind: 'laptop', memGb: 16, bandwidthGBs: 200, gflopsF16: 6800, webgpuMaxBufferMb: 4096, usableMemFraction: 0.6, year: 2023 },
  { id: 'm2-max', label: 'MacBook Pro M2 Max', chip: 'M2 Max', kind: 'laptop', memGb: 32, bandwidthGBs: 400, gflopsF16: 13600, webgpuMaxBufferMb: 4096, usableMemFraction: 0.65, year: 2023 },
  { id: 'm2-ultra', label: 'Mac Studio M2 Ultra', chip: 'M2 Ultra', kind: 'desktop', memGb: 64, bandwidthGBs: 800, gflopsF16: 27200, webgpuMaxBufferMb: 4096, usableMemFraction: 0.7, year: 2023 },
  { id: 'm3', label: 'MacBook Air M3', chip: 'M3', kind: 'laptop', memGb: 8, bandwidthGBs: 100, gflopsF16: 4100, webgpuMaxBufferMb: 2048, usableMemFraction: 0.5, year: 2024 },
  { id: 'm3-pro', label: 'MacBook Pro M3 Pro', chip: 'M3 Pro', kind: 'laptop', memGb: 18, bandwidthGBs: 150, gflopsF16: 7100, webgpuMaxBufferMb: 4096, usableMemFraction: 0.6, year: 2023 },
  { id: 'm3-max', label: 'MacBook Pro M3 Max', chip: 'M3 Max', kind: 'laptop', memGb: 36, bandwidthGBs: 400, gflopsF16: 14200, webgpuMaxBufferMb: 4096, usableMemFraction: 0.65, year: 2023 },
  { id: 'm3-ultra', label: 'Mac Studio M3 Ultra', chip: 'M3 Ultra', kind: 'desktop', memGb: 96, bandwidthGBs: 800, gflopsF16: 28400, webgpuMaxBufferMb: 4096, usableMemFraction: 0.7, year: 2025 },
  { id: 'm4', label: 'MacBook Air M4', chip: 'M4', kind: 'laptop', memGb: 16, bandwidthGBs: 120, gflopsF16: 4600, webgpuMaxBufferMb: 2048, usableMemFraction: 0.55, year: 2025 },
  { id: 'm4-pro', label: 'MacBook Pro M4 Pro', chip: 'M4 Pro', kind: 'laptop', memGb: 24, bandwidthGBs: 273, gflopsF16: 9200, webgpuMaxBufferMb: 4096, usableMemFraction: 0.6, year: 2024 },
  { id: 'm4-max', label: 'MacBook Pro M4 Max', chip: 'M4 Max', kind: 'laptop', memGb: 48, bandwidthGBs: 546, gflopsF16: 18400, webgpuMaxBufferMb: 4096, usableMemFraction: 0.65, year: 2024 },
  { id: 'm5', label: 'MacBook Pro M5', chip: 'M5', kind: 'laptop', memGb: 16, bandwidthGBs: 153, gflopsF16: 7400, webgpuMaxBufferMb: 4096, usableMemFraction: 0.55, year: 2025 },

  // -- iPhone ------------------------------------------------------------
  { id: 'iphone-14-pro', label: 'iPhone 14 Pro', chip: 'A16 Bionic', kind: 'phone', memGb: 6, bandwidthGBs: 34, gflopsF16: 1600, webgpuMaxBufferMb: 256, usableMemFraction: 0.25, year: 2022, note: APPLE_PHONE_NOTE },
  { id: 'iphone-15-pro', label: 'iPhone 15 Pro', chip: 'A17 Pro', kind: 'phone', memGb: 8, bandwidthGBs: 51, gflopsF16: 2100, webgpuMaxBufferMb: 256, usableMemFraction: 0.28, year: 2023, note: APPLE_PHONE_NOTE },
  { id: 'iphone-16', label: 'iPhone 16', chip: 'A18', kind: 'phone', memGb: 8, bandwidthGBs: 60, gflopsF16: 2300, webgpuMaxBufferMb: 256, usableMemFraction: 0.28, year: 2024, note: APPLE_PHONE_NOTE },
  { id: 'iphone-16-pro', label: 'iPhone 16 Pro', chip: 'A18 Pro', kind: 'phone', memGb: 8, bandwidthGBs: 60, gflopsF16: 2700, webgpuMaxBufferMb: 256, usableMemFraction: 0.28, year: 2024, note: APPLE_PHONE_NOTE },
  { id: 'iphone-17', label: 'iPhone 17', chip: 'A19', kind: 'phone', memGb: 8, bandwidthGBs: 64, gflopsF16: 2900, webgpuMaxBufferMb: 256, usableMemFraction: 0.28, year: 2025, note: APPLE_PHONE_NOTE },
  { id: 'iphone-17-pro', label: 'iPhone 17 Pro', chip: 'A19 Pro', kind: 'phone', memGb: 12, bandwidthGBs: 68, gflopsF16: 3400, webgpuMaxBufferMb: 256, usableMemFraction: 0.3, year: 2025, note: APPLE_PHONE_NOTE },

  // -- iPad --------------------------------------------------------------
  { id: 'ipad-air-m2', label: 'iPad Air M2', chip: 'M2', kind: 'tablet', memGb: 8, bandwidthGBs: 100, gflopsF16: 3600, webgpuMaxBufferMb: 1024, usableMemFraction: 0.35, year: 2024 },
  { id: 'ipad-pro-m4', label: 'iPad Pro M4', chip: 'M4', kind: 'tablet', memGb: 16, bandwidthGBs: 120, gflopsF16: 4600, webgpuMaxBufferMb: 1024, usableMemFraction: 0.4, year: 2024, note: 'iPadOS is more generous than iOS but still well below a Mac, around 1 GB per WebGPU buffer.' },

  // -- Android -----------------------------------------------------------
  { id: 'sd-8-gen-3', label: 'Snapdragon 8 Gen 3 phone', chip: 'Adreno 750', kind: 'phone', memGb: 12, bandwidthGBs: 77, gflopsF16: 4300, webgpuMaxBufferMb: 1024, usableMemFraction: 0.3, year: 2024, note: 'Chrome on Android is far more permissive than iOS Safari, but thermal throttling arrives within a minute of sustained load.' },
  { id: 'sd-8-elite', label: 'Snapdragon 8 Elite phone', chip: 'Adreno 830', kind: 'phone', memGb: 16, bandwidthGBs: 85, gflopsF16: 6000, webgpuMaxBufferMb: 1536, usableMemFraction: 0.32, year: 2025 },
  { id: 'tensor-g4', label: 'Pixel 9 (Tensor G4)', chip: 'Mali-G715', kind: 'phone', memGb: 12, bandwidthGBs: 51, gflopsF16: 2400, webgpuMaxBufferMb: 1024, usableMemFraction: 0.28, year: 2024 },

  // -- PC ----------------------------------------------------------------
  { id: 'igpu-modern', label: 'Laptop with integrated graphics', chip: 'Iris Xe / Radeon 780M', kind: 'laptop', memGb: 16, bandwidthGBs: 70, gflopsF16: 4000, webgpuMaxBufferMb: 2048, usableMemFraction: 0.4, year: 2023 },
  { id: 'rtx-3060', label: 'PC with RTX 3060', chip: 'RTX 3060 12GB', kind: 'desktop', memGb: 12, bandwidthGBs: 360, gflopsF16: 25000, webgpuMaxBufferMb: 2048, usableMemFraction: 0.8, year: 2021, note: 'Dedicated VRAM, so the model must fit in 12 GB regardless of system RAM.' },
  { id: 'rtx-4070', label: 'PC with RTX 4070', chip: 'RTX 4070', kind: 'desktop', memGb: 12, bandwidthGBs: 504, gflopsF16: 29000, webgpuMaxBufferMb: 2048, usableMemFraction: 0.8, year: 2023 },
  { id: 'rtx-4090', label: 'PC with RTX 4090', chip: 'RTX 4090', kind: 'desktop', memGb: 24, bandwidthGBs: 1008, gflopsF16: 82000, webgpuMaxBufferMb: 2048, usableMemFraction: 0.85, year: 2022 },
  { id: 'rtx-5090', label: 'PC with RTX 5090', chip: 'RTX 5090', kind: 'desktop', memGb: 32, bandwidthGBs: 1792, gflopsF16: 105000, webgpuMaxBufferMb: 2048, usableMemFraction: 0.85, year: 2025 },
]

export const DEVICE_BY_ID = new Map(DEVICE_DB.map((d) => [d.id, d]))

/** Grouped for the "what devices do you have?" picker. */
export const DEVICE_GROUPS: { label: string; kind: DeviceSpec['kind'] }[] = [
  { label: 'Phones', kind: 'phone' },
  { label: 'Tablets', kind: 'tablet' },
  { label: 'Laptops', kind: 'laptop' },
  { label: 'Desktops', kind: 'desktop' },
]
