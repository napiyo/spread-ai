/**
 * WGSL kernels for the capability benchmark.
 *
 * These are deliberately plain, portable kernels rather than tuned ones. We are
 * measuring a device so we can *compare* devices and seed the roofline model —
 * consistency across hardware matters more than squeezing out peak. The roofline
 * is then recalibrated against real generation the first time you run a model,
 * so any systematic underestimate here washes out.
 */

/** Grid-stride streaming read. Bandwidth-bound by construction. */
export const BANDWIDTH_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read>       src  : array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> sink : array<f32>;

override PASSES : u32 = 1u;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>,
        @builtin(num_workgroups)       nwg : vec3<u32>) {
  let n      = arrayLength(&src);
  let stride = nwg.x * 256u;
  var acc    = vec4<f32>(0.0);

  for (var p : u32 = 0u; p < PASSES; p = p + 1u) {
    var i = gid.x;
    loop {
      if (i >= n) { break; }
      acc = acc + src[i];
      i = i + stride;
    }
  }

  // Consume the accumulator so nothing is dead-code eliminated, but under a
  // condition that never holds so we never actually touch memory here.
  let s = acc.x + acc.y + acc.z + acc.w;
  if (s == 1.2345679e33) { sink[gid.x] = s; }
}
`

/**
 * 64x64 tiled matmul, 4x4 per thread, 16x16 workgroup.
 * FLOPs = 2*M*N*K. `T` is f32 or f16.
 */
export function matmulWgsl(T: 'f32' | 'f16'): string {
  const enable = T === 'f16' ? 'enable f16;\n' : ''
  return /* wgsl */ `${enable}
struct Dims { M : u32, N : u32, K : u32, _pad : u32 };

@group(0) @binding(0) var<uniform>              d : Dims;
@group(0) @binding(1) var<storage, read>        A : array<${T}>;
@group(0) @binding(2) var<storage, read>        B : array<${T}>;
@group(0) @binding(3) var<storage, read_write>  C : array<${T}>;

var<workgroup> As : array<${T}, 1024>;  // 64 rows x 16 k
var<workgroup> Bs : array<${T}, 1024>;  // 16 k  x 64 cols

@compute @workgroup_size(16, 16)
fn main(@builtin(workgroup_id)        wg  : vec3<u32>,
        @builtin(local_invocation_id) lid : vec3<u32>) {
  let tileRow = wg.y * 64u;
  let tileCol = wg.x * 64u;
  let lin     = lid.y * 16u + lid.x;

  var acc : array<array<${T}, 4>, 4>;
  for (var i = 0u; i < 4u; i = i + 1u) {
    for (var j = 0u; j < 4u; j = j + 1u) { acc[i][j] = ${T}(0.0); }
  }

  var kk = 0u;
  loop {
    if (kk >= d.K) { break; }

    // Cooperative load: 1024 elements per tile, 256 threads, 4 each.
    for (var t = 0u; t < 4u; t = t + 1u) {
      let ia = lin + t * 256u;
      As[ia] = A[(tileRow + ia / 16u) * d.K + kk + (ia % 16u)];
      let ib = lin + t * 256u;
      Bs[ib] = B[(kk + ib / 64u) * d.N + tileCol + (ib % 64u)];
    }
    workgroupBarrier();

    for (var k = 0u; k < 16u; k = k + 1u) {
      var av : array<${T}, 4>;
      var bv : array<${T}, 4>;
      for (var i = 0u; i < 4u; i = i + 1u) { av[i] = As[(lid.y * 4u + i) * 16u + k]; }
      for (var j = 0u; j < 4u; j = j + 1u) { bv[j] = Bs[k * 64u + lid.x * 4u + j]; }
      for (var i = 0u; i < 4u; i = i + 1u) {
        for (var j = 0u; j < 4u; j = j + 1u) { acc[i][j] = acc[i][j] + av[i] * bv[j]; }
      }
    }
    workgroupBarrier();
    kk = kk + 16u;
  }

  for (var i = 0u; i < 4u; i = i + 1u) {
    let r = tileRow + lid.y * 4u + i;
    for (var j = 0u; j < 4u; j = j + 1u) {
      C[r * d.N + tileCol + lid.x * 4u + j] = acc[i][j];
    }
  }
}
`
}
