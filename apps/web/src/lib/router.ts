import { useSyncExternalStore } from 'react'

export const ROUTES = ['home', 'models', 'fleet', 'advisor', 'chat'] as const
export type Route = (typeof ROUTES)[number]

function parse(): Route {
  const h = window.location.hash.replace(/^#\/?/, '').split('?')[0]
  return (ROUTES as readonly string[]).includes(h) ? (h as Route) : 'home'
}

const listeners = new Set<() => void>()
let current: Route = typeof window === 'undefined' ? 'home' : parse()

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    current = parse()
    for (const l of listeners) l()
  })
}

export function navigate(route: Route) {
  if (route === current && window.location.hash) return
  window.location.hash = route === 'home' ? '/' : `/${route}`
  window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => current,
    () => 'home' as Route,
  )
}
