import { useMemo } from 'react'
import { remoteWorker } from '@/mesh/remoteWorker'
import type { Worker } from '@/strategies'
import { useDevice } from './device'
import { useEngine } from './engine'
import { useMeshStore } from './mesh'

/**
 * Every place a turn could actually run: this tab, and each paired device that
 * has a model in memory.
 *
 * This is the seam between the mesh and the strategies. Above it nothing knows
 * whether a generation crossed a network; below it nothing knows what a
 * conversation is.
 */

function localWorker(): Worker {
  const { capability } = useDevice.getState()
  const { status, model, generating } = useEngine.getState()

  return {
    id: 'local',
    label: capability?.label ?? 'This device',
    local: true,
    modelId: status === 'ready' && model ? model.id : null,
    modelLabel: status === 'ready' && model ? model.label : null,
    rttMs: 0,
    bandwidthGBs: capability?.bandwidthGBs ?? 0,
    busy: generating,
    async run(req, onToken) {
      const result = await useEngine.getState().generate(req, onToken)
      // The engine signals failure by returning null and parking the reason in
      // its own state. A worker has to throw, or a strategy cannot tell a
      // failed sample from an empty one.
      if (!result) {
        throw new Error(useEngine.getState().error?.message ?? 'This device could not generate a reply.')
      }
      return result
    },
    interrupt: () => useEngine.getState().interrupt(),
  }
}

/** Snapshot for code outside React, such as sending a turn. */
export function currentWorkers(): Worker[] {
  const mesh = useMeshStore.getState().mesh
  const peers = useMeshStore.getState().peers
  const remote = mesh
    ? peers
        .filter((p) => p.state === 'connected' && p.loaded)
        .map((p) => remoteWorker(mesh, p))
    : []
  return [localWorker(), ...remote]
}

/** The same list, recomputed when the fleet or the local engine changes. */
export function useWorkers(): Worker[] {
  const mesh = useMeshStore((s) => s.mesh)
  const peers = useMeshStore((s) => s.peers)
  const status = useEngine((s) => s.status)
  const model = useEngine((s) => s.model)
  const generating = useEngine((s) => s.generating)
  const capability = useDevice((s) => s.capability)

  return useMemo(
    () => currentWorkers(),
    // Rebuilt from the store on every relevant change; the dependencies are
    // named rather than derived so a stale worker list cannot survive one.
    [mesh, peers, status, model, generating, capability],
  )
}
