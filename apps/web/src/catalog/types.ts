import type { Quant } from '@/planner/modelSpec'
import type { RuntimeKind } from '@/runtime/types'

export interface CatalogEntry {
  /** Stable key across the app. */
  id: string
  label: string
  family: string
  /** Billions of parameters. */
  paramsB: number
  runtime: RuntimeKind
  quant: Quant
  /** GPU memory the runtime says it needs, MB. Authoritative when present. */
  vramMb: number | null
  contextWindow: number
  blurb: string
  tags: string[]
  hfRepo: string | null
  webllmModelId?: string
  onnxDtype?: string
  featured: boolean
}
