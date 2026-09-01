import { useMemo } from 'react'
import { useCatalog } from '@/store/catalog'
import { useDevice } from '@/store/device'
import { estimate, fitsOnDevice } from './roofline'
import { footprintBytes } from './modelSpec'

/**
 * Context length the shelf quotes speeds at.
 *
 * Not the model's maximum: decode re-reads the whole KV cache every token, so
 * pricing a 0.6B model at its full 40K window makes it look slower than a 3B
 * one, which is true at 40K and misleading as a headline. A typical chat turn
 * is nearer this.
 */
export const REFERENCE_CTX = 1024

export interface Prediction {
  /** True when it rests on the model's real architecture rather than its size. */
  exact: boolean
  fits: boolean
  blockers: string[]
  warnings: string[]
  requiredBytes: number
  tokensPerSec: number | null
  ttftMs: number | null
  /** True when the estimate uses efficiency measured on this device. */
  calibrated: boolean
}

/**
 * What this device would do with this model. Falls back to the runtime's own
 * VRAM figure while the architecture is still being fetched, and says which of
 * the two it used — a rough answer labelled rough beats a precise-looking guess.
 */
export function usePrediction(
  modelId: string,
  contextWindow: number,
  vramMb: number | null,
): Prediction | null {
  const spec = useCatalog((s) => s.specs[modelId])
  const cap = useDevice((s) => s.capability)

  return useMemo(() => {
    if (!cap) return null
    const ctx = Math.min(contextWindow || REFERENCE_CTX, REFERENCE_CTX)

    if (spec) {
      const fit = fitsOnDevice(spec, cap, ctx)
      const est = estimate({ model: spec, cap, ctx, promptTokens: 256, outputTokens: 256 })
      return {
        exact: true,
        fits: fit.fits,
        blockers: fit.blockers,
        warnings: fit.warnings,
        requiredBytes: footprintBytes(spec, ctx),
        tokensPerSec: est.tokensPerSec,
        ttftMs: est.ttftMs,
        calibrated: est.calibrated,
      }
    }

    if (vramMb) {
      const requiredBytes = vramMb * 1024 ** 2
      const fits = requiredBytes <= cap.weightBudgetBytes && cap.hasWebGpu
      return {
        exact: false,
        fits,
        blockers: fits
          ? []
          : [cap.hasWebGpu ? 'Larger than this device can spare for a browser tab.' : 'No WebGPU here.'],
        warnings: [],
        requiredBytes,
        tokensPerSec: null,
        ttftMs: null,
        calibrated: false,
      }
    }

    return null
  }, [spec, cap, contextWindow, vramMb])
}
