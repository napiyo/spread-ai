/** Human-readable byte counts. Binary units, because that is what GPU limits use. */
export function bytes(n: number, digits = 1): string {
  if (!Number.isFinite(n) || n <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  const v = n / 1024 ** i
  return `${v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : digits)} ${units[i]}`
}

export function ms(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n < 1000) return `${Math.round(n)} ms`
  if (n < 60_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)} s`
  return `${Math.floor(n / 60_000)}m ${Math.round((n % 60_000) / 1000)}s`
}

export function compact(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—'
  if (Math.abs(n) < 1000) return n.toFixed(n % 1 === 0 ? 0 : digits)
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: digits }).format(n)
}

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}
