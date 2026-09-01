import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'

/**
 * Introduction service for spreadAI.
 *
 * It relays WebRTC offers, answers and ICE candidates between browsers in the
 * same room, and does nothing else. It never sees a prompt, a token, a model
 * weight or a hidden state — once two peers have found each other, all of that
 * flows directly between them over an encrypted data channel and this process
 * is out of the loop.
 *
 * It is deliberately stateless beyond the in-memory room map, so it restarts
 * cleanly and can be replaced by the QR pairing path entirely when offline.
 */

const PORT = Number(process.env.PORT ?? 8787)
const MAX_ROOM_SIZE = Number(process.env.MAX_ROOM_SIZE ?? 8)
const MAX_MESSAGE_BYTES = 64 * 1024
const HEARTBEAT_MS = 30_000

/** room -> Map<peerId, ws> */
const rooms = new Map()

const server = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }))
    return
  }
  res.writeHead(404)
  res.end()
})

const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES })

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

function leave(ws) {
  const { room, peerId } = ws.meta ?? {}
  const peers = rooms.get(room)
  if (!peers) return
  peers.delete(peerId)
  if (peers.size === 0) rooms.delete(room)
  else for (const other of peers.values()) send(other, { type: 'left', id: peerId })
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const room = (url.searchParams.get('room') ?? '').trim().toUpperCase()
  const peerId = (url.searchParams.get('id') ?? '').trim()

  // Room codes are typed by hand and shared out loud, so they are constrained
  // to an unambiguous alphabet rather than accepting anything at all.
  if (!/^[A-Z0-9]{4,12}$/.test(room) || !/^[A-Za-z0-9-]{8,64}$/.test(peerId)) {
    send(ws, { type: 'error', error: 'Bad room or peer id.' })
    ws.close(1008)
    return
  }

  let peers = rooms.get(room)
  if (!peers) {
    peers = new Map()
    rooms.set(room, peers)
  }
  if (peers.size >= MAX_ROOM_SIZE) {
    send(ws, { type: 'error', error: `That room already has ${MAX_ROOM_SIZE} devices in it.` })
    ws.close(1008)
    return
  }
  // A reconnecting peer replaces its own stale socket rather than duplicating.
  peers.get(peerId)?.close(1000)

  ws.meta = { room, peerId }
  ws.isAlive = true
  peers.set(peerId, ws)

  send(ws, { type: 'welcome', id: peerId, peers: [...peers.keys()].filter((p) => p !== peerId) })
  for (const [id, other] of peers) if (id !== peerId) send(other, { type: 'joined', id: peerId })

  ws.on('pong', () => {
    ws.isAlive = true
  })

  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg?.type !== 'signal' || typeof msg.to !== 'string') return

    const target = rooms.get(room)?.get(msg.to)
    // The payload is opaque here on purpose: it is SDP and ICE, and this
    // service has no business inspecting or reshaping it.
    if (target) send(target, { type: 'signal', from: peerId, payload: msg.payload })
  })

  ws.on('close', () => leave(ws))
  ws.on('error', () => leave(ws))
})

// Drop sockets that stopped answering: a phone that went into a tunnel would
// otherwise sit in the room forever and other peers would keep trying to reach it.
const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (!client.isAlive) {
      client.terminate()
      continue
    }
    client.isAlive = false
    client.ping()
  }
}, HEARTBEAT_MS)

wss.on('close', () => clearInterval(heartbeat))

server.listen(PORT, () => {
  console.log(`spreadAI signaling on :${PORT} — relays SDP only, never content`)
})
