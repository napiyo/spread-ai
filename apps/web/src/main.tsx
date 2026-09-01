import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'

// Debugging a peer-to-peer mesh means inspecting two browsers at once, so the
// stores are reachable from the console in development.
if (import.meta.env.DEV) {
  void Promise.all([
    import('./store/mesh'),
    import('./store/device'),
    import('./store/engine'),
    import('./sync/doc'),
  ]).then(([mesh, device, engine, doc]) => {
    Object.assign(window, { __spreadai: { mesh, device, engine, doc } })
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
