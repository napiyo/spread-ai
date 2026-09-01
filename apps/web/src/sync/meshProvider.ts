import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import type { Mesh } from '@/mesh/mesh'
import { awareness, ydoc } from './doc'

const MSG_SYNC = 0
const MSG_AWARENESS = 1

function toB64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s)
}

function fromB64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

/**
 * Syncs the conversation document across the mesh.
 *
 * Uses y-protocols directly rather than y-webrtc so that the CRDT rides the
 * same data channels as everything else — one connection per device, one place
 * where traffic is measured, and no second signaling service.
 *
 * Yjs is order-independent and idempotent, so a device that was offline for an
 * hour catches up by exchanging state vectors on reconnect. Nothing is lost and
 * nothing is overwritten; two people editing the same thread merge.
 */
export class MeshSyncProvider {
  private unsubscribe: (() => void)[] = []

  constructor(private readonly mesh: Mesh) {
    this.unsubscribe.push(
      mesh.subscribe('y', (data, from) => this.onMessage(fromB64(String(data)), from)),
    )

    const onUpdate = (update: Uint8Array, origin: unknown) => {
      // Updates that arrived from a peer must not be echoed back to the mesh,
      // or two devices bounce the same change between them indefinitely.
      if (origin === this) return
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_SYNC)
      syncProtocol.writeUpdate(enc, update)
      mesh.broadcastYjs(toB64(encoding.toUint8Array(enc)))
    }
    ydoc.on('update', onUpdate)
    this.unsubscribe.push(() => ydoc.off('update', onUpdate))

    const onAwareness = ({ added, updated, removed }: Record<string, number[]>) => {
      const changed = [...added, ...updated, ...removed]
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_AWARENESS)
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(awareness, changed))
      mesh.broadcastYjs(toB64(encoding.toUint8Array(enc)))
    }
    awareness.on('update', onAwareness)
    this.unsubscribe.push(() => awareness.off('update', onAwareness))
  }

  /**
   * Greets a newly connected device with our state vector, which is how the two
   * work out the minimal set of changes each is missing.
   */
  greet(peerId: string) {
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_SYNC)
    syncProtocol.writeSyncStep1(enc, ydoc)
    this.mesh.sendYjs(peerId, toB64(encoding.toUint8Array(enc)))

    const aw = encoding.createEncoder()
    encoding.writeVarUint(aw, MSG_AWARENESS)
    encoding.writeVarUint8Array(
      aw,
      awarenessProtocol.encodeAwarenessUpdate(awareness, [ydoc.clientID]),
    )
    this.mesh.sendYjs(peerId, toB64(encoding.toUint8Array(aw)))
  }

  private onMessage(bytes: Uint8Array, from: string) {
    const dec = decoding.createDecoder(bytes)
    const type = decoding.readVarUint(dec)

    if (type === MSG_SYNC) {
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_SYNC)
      // `this` as the origin marks everything applied here as remote, which is
      // what stops the echo in onUpdate above.
      syncProtocol.readSyncMessage(dec, enc, ydoc, this)
      if (encoding.length(enc) > 1) this.mesh.sendYjs(from, toB64(encoding.toUint8Array(enc)))
      return
    }

    if (type === MSG_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(awareness, decoding.readVarUint8Array(dec), this)
    }
  }

  destroy() {
    for (const off of this.unsubscribe) off()
    this.unsubscribe = []
  }
}
