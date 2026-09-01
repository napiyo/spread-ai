/**
 * A thin client for the public Hugging Face Hub API.
 *
 * Everything here is an anonymous GET against endpoints that send permissive
 * CORS headers, so it works straight from the page with no token and no proxy.
 * Responses are cached in memory for the session because the Models scene
 * re-resolves the same repos as you scroll.
 */

const API = 'https://huggingface.co/api'

export interface HfSibling {
  rfilename: string
}

export interface HfModelInfo {
  id: string
  author?: string
  library_name?: string
  pipeline_tag?: string
  tags: string[]
  downloads?: number
  likes?: number
  lastModified?: string
  gated?: boolean | string
  siblings?: HfSibling[]
  /** Present on most modern repos and the most reliable parameter count there is. */
  safetensors?: { total?: number; parameters?: Record<string, number> }
}

export interface HfTreeEntry {
  path: string
  type: 'file' | 'directory'
  size?: number
  lfs?: { size?: number }
}

export interface HfSearchResult {
  id: string
  downloads: number
  likes: number
  tags: string[]
  library: string | null
  pipelineTag: string | null
}

const cache = new Map<string, Promise<unknown>>()

function get<T>(url: string, init?: RequestInit): Promise<T> {
  const hit = cache.get(url)
  if (hit) return hit as Promise<T>

  const p = fetch(url, { ...init, headers: { Accept: 'application/json', ...init?.headers } })
    .then(async (r) => {
      if (r.status === 401 || r.status === 403) {
        throw new HfError(`This repo is gated or private, so the browser cannot read it.`, r.status)
      }
      if (r.status === 404) throw new HfError(`No such model on Hugging Face.`, 404)
      if (!r.ok) throw new HfError(`Hugging Face returned ${r.status}.`, r.status)
      return (await r.json()) as T
    })
    .catch((e) => {
      // A failed lookup should be retryable rather than cached forever.
      cache.delete(url)
      throw e
    })

  cache.set(url, p)
  return p
}

export class HfError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'HfError'
  }
}

/** Accepts a full URL, `org/repo`, or a repo with a trailing path/branch. */
export function parseRepoId(input: string): string | null {
  const s = input.trim()
  if (!s) return null

  const url = /^(?:https?:\/\/)?(?:www\.)?huggingface\.co\/(.+)$/i.exec(s)
  const path = url ? url[1] : s

  const parts = path
    .replace(/^\/+/, '')
    .split(/[?#]/)[0]
    .split('/')
    .filter(Boolean)

  // Skip the Hub's own namespaces so a pasted dataset or space URL fails loudly.
  if (['datasets', 'spaces', 'collections'].includes(parts[0])) return null
  if (parts.length < 2) return null
  return `${parts[0]}/${parts[1]}`
}

export function searchModels(
  query: string,
  opts: { library?: string; limit?: number; signal?: AbortSignal } = {},
): Promise<HfSearchResult[]> {
  const p = new URLSearchParams({
    search: query,
    limit: String(opts.limit ?? 24),
    sort: 'downloads',
    direction: '-1',
    filter: 'text-generation',
  })
  if (opts.library) p.set('library', opts.library)

  return get<HfModelInfo[]>(`${API}/models?${p}`, { signal: opts.signal }).then((rows) =>
    rows.map((m) => ({
      id: m.id,
      downloads: m.downloads ?? 0,
      likes: m.likes ?? 0,
      tags: m.tags ?? [],
      library: m.library_name ?? null,
      pipelineTag: m.pipeline_tag ?? null,
    })),
  )
}

export function modelInfo(repo: string): Promise<HfModelInfo> {
  return get<HfModelInfo>(`${API}/models/${repo}`)
}

/** File listing with real byte sizes, which `siblings` does not carry. */
export function tree(repo: string, path = ''): Promise<HfTreeEntry[]> {
  return get<HfTreeEntry[]>(`${API}/models/${repo}/tree/main/${path}`).catch((e) => {
    if (e instanceof HfError && e.status === 404) return []
    throw e
  })
}

export function fileUrl(repo: string, path: string): string {
  return `https://huggingface.co/${repo}/resolve/main/${path}`
}

/**
 * The model's architecture config.
 *
 * MLC repos carry no `config.json` at all — the same fields live nested under
 * `model_config` in `mlc-chat-config.json`. Without this fallback every
 * pre-compiled model in the featured shelf silently loses its layer count, and
 * the planner quietly degrades to guessing from parameter count alone.
 */
export async function fetchConfig(repo: string): Promise<Record<string, unknown> | null> {
  try {
    return await get<Record<string, unknown>>(fileUrl(repo, 'config.json'))
  } catch {
    /* fall through to the MLC layout */
  }

  try {
    const mlc = await get<Record<string, unknown>>(fileUrl(repo, 'mlc-chat-config.json'))
    const inner = mlc.model_config
    if (inner && typeof inner === 'object') {
      return {
        ...(inner as Record<string, unknown>),
        // These live at the top level rather than inside model_config.
        vocab_size: mlc.vocab_size ?? (inner as Record<string, unknown>).vocab_size,
        model_type: mlc.model_type,
      }
    }
    return mlc
  } catch {
    // Some runnable repos genuinely have neither; the caller falls back to a
    // structural guess rather than refusing the model.
    return null
  }
}

export function sizeOf(entry: HfTreeEntry): number {
  return entry.lfs?.size ?? entry.size ?? 0
}
