import { BANDWIDTH_WGSL, matmulWgsl } from './shaders'

export interface BenchResult {
  /** Sustained device-memory read bandwidth, GB/s. Drives decode tok/s. */
  bandwidthGBs: number
  /** Dense fp32 matmul throughput, GFLOP/s. Drives prefill / TTFT. */
  gflopsF32: number
  /** Same in fp16 where the adapter supports it — closer to real inference. */
  gflopsF16: number | null
  /** Largest buffer we actually succeeded in allocating, bytes. */
  allocatedBytes: number
  /** Wall-clock cost of the benchmark itself. */
  elapsedMs: number
  matmulSize: number
  warnings: string[]
}

export type BenchPhase = 'init' | 'bandwidth' | 'matmul-f32' | 'matmul-f16' | 'done'

export interface BenchOptions {
  signal?: AbortSignal
  onPhase?: (phase: BenchPhase, progress: number) => void
}

const MB = 1024 * 1024

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Benchmark cancelled', 'AbortError')
}

/**
 * Peak, not median. This measures a ceiling, and the only things that move a
 * sample are sources of contention — a compositor frame, another tab, our own
 * background animation — all of which can only make it slower. The best sample
 * is the one least polluted.
 */
function peak(xs: number[]): number {
  return Math.max(...xs)
}

/**
 * Wall-clock timing around `onSubmittedWorkDone` carries a fixed overhead of a
 * few milliseconds. A 5 ms measurement is therefore mostly noise. We calibrate
 * how much work one dispatch costs, then batch enough dispatches per submit
 * that the timed region is long enough for the overhead to disappear into it.
 */
async function calibrateReps(
  device: GPUDevice,
  dispatch: (enc: GPUCommandEncoder, reps: number) => void,
  targetMs: number,
  maxReps: number,
): Promise<number> {
  await timeSubmit(device, (e) => dispatch(e, 1)) // warm up: compile, first touch
  const ms = await timeSubmit(device, (e) => dispatch(e, 1))
  if (!Number.isFinite(ms) || ms <= 0) return 1
  return Math.max(1, Math.min(maxReps, Math.round(targetMs / ms)))
}

/** Timed regions shorter than this are dominated by submit overhead. */
const TARGET_SUBMIT_MS = 90

/**
 * WebGPU gives us no synchronous clock, and `timestamp-query` is an optional
 * feature that most Safari builds lack. Wall-clock around `onSubmittedWorkDone`
 * is accurate enough provided each measured submit runs for tens of ms, which
 * is why the kernels below are sized to do a lot of work per dispatch.
 */
async function timeSubmit(device: GPUDevice, record: (enc: GPUCommandEncoder) => void) {
  const enc = device.createCommandEncoder()
  record(enc)
  const cmd = enc.finish()
  const t0 = performance.now()
  device.queue.submit([cmd])
  await device.queue.onSubmittedWorkDone()
  return performance.now() - t0
}

/* ── Bandwidth ────────────────────────────────────────────────────────── */

async function benchBandwidth(
  device: GPUDevice,
  limits: GPUSupportedLimits,
  opts: BenchOptions,
): Promise<{ gbs: number; bytes: number; warnings: string[] }> {
  const warnings: string[] = []

  // Stay well inside both caps. On iPhone Safari `maxStorageBufferBindingSize`
  // is the binding constraint that actually bites; on desktop it is rarely hit.
  const cap = Math.min(
    Number(limits.maxStorageBufferBindingSize),
    Number(limits.maxBufferSize),
    256 * MB,
  )
  let size = Math.floor(cap / (16 * MB)) * 16 * MB
  if (size < 4 * MB) size = Math.max(4 * MB, Math.floor(cap / MB) * MB)

  let src: GPUBuffer | null = null
  // Back off on allocation failure rather than giving up: a device that can
  // only hand out 64 MB is exactly the kind we most need a real number for.
  for (let attempt = 0; attempt < 5 && !src; attempt++) {
    try {
      device.pushErrorScope('out-of-memory')
      const buf = device.createBuffer({ size, usage: GPUBufferUsage.STORAGE })
      const oom = await device.popErrorScope()
      if (oom) {
        buf.destroy()
        throw new Error('out of memory')
      }
      src = buf
    } catch {
      size = Math.floor(size / 2 / MB) * MB
      if (size < 2 * MB) break
    }
  }
  if (!src) throw new Error('Could not allocate a benchmark buffer of any usable size.')
  if (size < 32 * MB) {
    warnings.push(
      `Only ${(size / MB).toFixed(0)} MB could be allocated for the bandwidth test, so the reading may sit partly in cache and read high.`,
    )
  }

  const sink = device.createBuffer({ size: 4096, usage: GPUBufferUsage.STORAGE })
  const module = device.createShaderModule({ code: BANDWIDTH_WGSL })

  // Enough workgroups to saturate, few enough that each thread does real work.
  const workgroups = 1024
  const passes = size >= 64 * MB ? 4 : size >= 16 * MB ? 12 : 32

  const pipeline = await device.createComputePipelineAsync({
    layout: 'auto',
    compute: { module, entryPoint: 'main', constants: { PASSES: passes } },
  })
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: src } },
      { binding: 1, resource: { buffer: sink } },
    ],
  })

  const dispatch = (enc: GPUCommandEncoder, reps: number) => {
    const pass = enc.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bind)
    for (let i = 0; i < reps; i++) pass.dispatchWorkgroups(workgroups)
    pass.end()
  }

  const reps = await calibrateReps(device, dispatch, TARGET_SUBMIT_MS, 512)
  throwIfAborted(opts.signal)

  const samples: number[] = []
  const rounds = 4
  const bytesPerSubmit = size * passes * reps
  for (let i = 0; i < rounds; i++) {
    throwIfAborted(opts.signal)
    const ms = await timeSubmit(device, (e) => dispatch(e, reps))
    samples.push(bytesPerSubmit / (ms / 1000) / 1e9)
    opts.onPhase?.('bandwidth', (i + 1) / rounds)
  }

  src.destroy()
  sink.destroy()
  return { gbs: peak(samples), bytes: size, warnings }
}

/* ── Matmul ───────────────────────────────────────────────────────────── */

async function benchMatmul(
  device: GPUDevice,
  precision: 'f32' | 'f16',
  n: number,
  opts: BenchOptions,
): Promise<number> {
  const elems = n * n
  const bytesPer = precision === 'f16' ? 2 : 4
  const byteLen = elems * bytesPer

  const module = device.createShaderModule({ code: matmulWgsl(precision) })
  const pipeline = await device.createComputePipelineAsync({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  })

  const mk = () =>
    device.createBuffer({ size: byteLen, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
  const A = mk()
  const B = mk()
  const C = mk()

  const dims = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(dims, 0, new Uint32Array([n, n, n, 0]))

  // Small non-zero values keep results finite in fp16 and avoid any
  // denormal-flush fast paths that would flatter the measurement.
  const fill = new Uint8Array(byteLen)
  if (precision === 'f32') {
    const view = new Float32Array(fill.buffer)
    for (let i = 0; i < view.length; i++) view[i] = 0.01 + (i % 7) * 0.003
  } else {
    // 0.25 as an IEEE half is 0x3400; a constant pattern is enough for timing.
    const view = new Uint16Array(fill.buffer)
    view.fill(0x3400)
  }
  device.queue.writeBuffer(A, 0, fill)
  device.queue.writeBuffer(B, 0, fill)

  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: dims } },
      { binding: 1, resource: { buffer: A } },
      { binding: 2, resource: { buffer: B } },
      { binding: 3, resource: { buffer: C } },
    ],
  })

  const tiles = n / 64
  const dispatch = (enc: GPUCommandEncoder, reps: number) => {
    const pass = enc.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bind)
    // Every repeat recomputes the same product into C. Wasteful by design: we
    // want a long timed region, not a result.
    for (let i = 0; i < reps; i++) pass.dispatchWorkgroups(tiles, tiles)
    pass.end()
  }

  const reps = await calibrateReps(device, dispatch, TARGET_SUBMIT_MS, 512)
  throwIfAborted(opts.signal)

  const samples: number[] = []
  const rounds = 4
  const flops = 2 * n * n * n * reps
  for (let i = 0; i < rounds; i++) {
    throwIfAborted(opts.signal)
    const ms = await timeSubmit(device, (e) => dispatch(e, reps))
    samples.push(flops / (ms / 1000) / 1e9)
    opts.onPhase?.(precision === 'f16' ? 'matmul-f16' : 'matmul-f32', (i + 1) / rounds)
  }

  for (const b of [A, B, C, dims]) b.destroy()
  return peak(samples)
}

/* ── Entry point ──────────────────────────────────────────────────────── */

/**
 * Runs the full capability benchmark. Roughly 0.6–1.5 s of GPU time; always
 * user-initiated, always cancellable.
 */
export async function runBenchmark(opts: BenchOptions = {}): Promise<BenchResult> {
  const t0 = performance.now()
  const warnings: string[] = []
  opts.onPhase?.('init', 0)

  // Our own background animation runs on the same GPU we are about to measure.
  // Leaving it going costs a real slice of the reading, so it stops for the
  // duration and resumes in the finally below.
  const root = document.documentElement
  root.dataset.benching = '1'

  if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.')
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('No WebGPU adapter was granted.')

  const wantF16 = adapter.features.has('shader-f16')
  const device = await adapter.requestDevice({
    requiredFeatures: wantF16 ? (['shader-f16'] as GPUFeatureName[]) : [],
    requiredLimits: {
      maxBufferSize: adapter.limits.maxBufferSize,
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
    },
  })

  // Without this, a shader that fails to compile surfaces as a silent zero.
  const deviceLost = device.lost.then((info) => {
    warnings.push(`GPU device lost during benchmark: ${info.message || info.reason}`)
  })
  device.onuncapturederror = (e) => warnings.push(`GPU error: ${e.error.message}`)

  try {
    throwIfAborted(opts.signal)
    const bw = await benchBandwidth(device, adapter.limits, opts)
    warnings.push(...bw.warnings)

    // Size the matmul so even a phone finishes quickly but a laptop is loaded.
    const maxByBuffer = Math.floor(Math.sqrt(bw.bytes / 4 / 4) / 64) * 64
    const n = Math.max(256, Math.min(1024, maxByBuffer))

    const gflopsF32 = await benchMatmul(device, 'f32', n, opts)

    let gflopsF16: number | null = null
    if (wantF16) {
      try {
        gflopsF16 = await benchMatmul(device, 'f16', n, opts)
      } catch (err) {
        warnings.push(`fp16 matmul unavailable, using fp32 only (${String(err)}).`)
      }
    } else {
      warnings.push(
        'This GPU has no shader-f16. Models will run in fp32 where required, using roughly double the memory.',
      )
    }

    opts.onPhase?.('done', 1)
    void deviceLost
    return {
      bandwidthGBs: bw.gbs,
      gflopsF32,
      gflopsF16,
      allocatedBytes: bw.bytes,
      elapsedMs: performance.now() - t0,
      matmulSize: n,
      warnings,
    }
  } finally {
    device.destroy()
    delete root.dataset.benching
  }
}
