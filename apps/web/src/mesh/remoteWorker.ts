import type { Mesh, MeshPeer } from './mesh'
import { TOKEN_TOPIC, type GenerateReply, type TokenEvent } from './protocol'
import type { Worker } from '@/strategies'

/**
 * A device in the mesh, dressed as somewhere a generation can happen.
 *
 * This is the whole of "run it over there": a request, a subscription to the
 * tokens coming back, and a stop that names the run it means. Everything above
 * it — chat, the strategies, the planner — cannot tell this apart from the GPU
 * in this tab, which is the point.
 */

/**
 * A generation can legitimately run for minutes on a phone, so the usual RPC
 * deadline would kill real work halfway through. It still needs *some* limit: a
 * device that sleeps mid-reply otherwise leaves the asker waiting forever.
 */
export const REMOTE_GENERATE_TIMEOUT_MS = 10 * 60_000

export function remoteWorker(mesh: Mesh, peer: MeshPeer): Worker {
  const loaded = peer.loaded
  let current: string | null = null

  return {
    id: peer.peerId,
    label: peer.label,
    local: false,
    modelId: loaded?.id ?? null,
    modelLabel: loaded?.label ?? null,
    rttMs: peer.rttMs ?? 0,
    bandwidthGBs: peer.capability?.bandwidthGBs ?? 0,
    // Whether that device is free is only knowable by asking; it refuses with a
    // message of its own if it is not, which is better than guessing here.
    busy: false,

    async run(req, onToken) {
      const runId = crypto.randomUUID()
      current = runId

      // Subscribed before the request goes out: the first token can arrive
      // before the promise for the call itself has been awaited.
      const off = mesh.subscribe(TOKEN_TOPIC, (data, from) => {
        if (from !== peer.peerId) return
        const event = data as TokenEvent
        if (event.runId !== runId || !('delta' in event)) return
        onToken(event.delta)
      })

      try {
        const reply = await mesh.call<GenerateReply>(
          peer.peerId,
          'generate',
          {
            runId,
            modelId: loaded?.id,
            messages: req.messages,
            maxTokens: req.maxTokens,
            temperature: req.temperature,
            topP: req.topP,
            seed: req.seed,
          },
          { timeoutMs: REMOTE_GENERATE_TIMEOUT_MS },
        )
        return { text: reply.text, stats: reply.stats, interrupted: reply.interrupted }
      } finally {
        off()
        if (current === runId) current = null
      }
    },

    async interrupt() {
      if (!current) return
      // A stop that cannot be delivered is not worth failing a turn over — the
      // request ends on its own either way.
      await mesh.call(peer.peerId, 'interrupt', { runId: current }).catch(() => {})
    },
  }
}
