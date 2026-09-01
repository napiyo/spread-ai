# spreadAI

Run language models in a browser tab, on your own GPU, spread across the devices you own.

No install, no account, no inference server. Weights download once and stay cached; conversations
are CRDTs that sync device-to-device. The only backend is a ~150-line relay that introduces
browsers to each other and never sees a prompt, a token, or a weight.

---

## The claim this project refuses to make

Splitting one model's layers across several devices **does not make a single reply faster.** At
batch size one the stages run in sequence and each boundary adds a network hop, so a model that
already fits on your laptop gets *slower* when you spread it.

What spreading actually buys is **capacity** — running a model no single device could hold. Speed
comes from a different axis entirely: speculative decoding, parallel sampling, and map-reduce over
long inputs.

The advisor is built around saying that out loud. It will tell you when adding a device won't
help, and there are tests that fail if it ever starts claiming otherwise. The same rule governs the
runtime: the chat will refuse to split a short prompt across three devices and tell you why, rather
than doing it and looking busy.

## Running it

```bash
npm install
npm run dev
```

The device pairing relay is separate and optional:

```bash
npm run dev:signal
```

Tests and types:

```bash
npm test && npm run typecheck
```

## How it fits together

```
apps/web/src/
  capability/   probe the device, benchmark it with two WGSL kernels, name it
  planner/      the roofline model, layer partitioning, and recommendations
  catalog/      featured models, Hugging Face search, and repo resolution
  runtime/      WebLLM and transformers.js engines behind one interface
  mesh/         WebRTC peers, RPC, capability gossip, serving work to peers
  strategies/   how one turn is spread over the fleet, and when it refuses to be
  sync/         Yjs document, IndexedDB persistence, mesh sync provider
  scenes/       Landing, Models, Advisor, Fleet, Chat
server/signal/  the introduction relay (SDP and ICE only)
```

### Running a turn across the fleet

Every device that has a model in memory says so, and the room hears about it the moment it changes.
Above that gossip sits one interface — a `Worker`: somewhere a generation can happen. The GPU in
this tab is one. A paired device is another, reached over the data channel, streaming its tokens
back as it writes them. Nothing above that seam can tell the two apart, which is why "run it here"
and "run it there" are not two code paths that drift.

Three arrangements are built on it:

| | what it does | what it buys |
|---|---|---|
| **One device** | the whole turn, in one place | the fastest single reply there is |
| **Best of several** | each device draws its own sample at once | *n* answers to choose between, **not** a shorter wait |
| **Split the input** | long input cut up, read in parallel, answered from the notes | genuinely finishes sooner — the parts are independent |

And the refusals matter as much as the arrangements. Best-of-n on one device is just pressing
regenerate, so it is refused by name. Splitting an input under about four thousand characters costs
more in round trips than it saves in reading, so the menu greys it out and says so with the actual
number. Sending a turn to another device is never described as faster: the picker says out loud that
running it here would be quicker by the round trip, and that handing it away is for keeping this
device free. Tests fail if any of those sentences starts claiming otherwise.

The chunks are handed out from a queue rather than assigned up front, so a laptop reads four parts
while a phone reads one. A part whose device drops it is retried somewhere else — never on the
device that just failed it — and a part nobody can read is named in the answer rather than quietly
left out. A device with no model at all can still hold the conversation: it borrows a paired one,
and the transcript says whose GPU wrote each reply.

### The numbers are measured, not guessed

Two short WGSL kernels measure real memory bandwidth and real fp16 matmul throughput. Those two
numbers feed a roofline model:

```
decode:  time/token = bytesPerToken / (bandwidth x efficiency) + dispatchFloor x layers
prefill: ttft       = 2 x activeParams x promptTokens / (flops x efficiency)
```

The `dispatchFloor` term matters more than it looks: each transformer layer issues several WebGPU
dispatches whose cost is independent of how little work they do, which is why small models top out
around 150 tok/s in a browser rather than the 500 a pure bandwidth model predicts.

After any real generation the app solves backwards for the efficiency constants and stores them, so
projections stop being spec-sheet arithmetic and start being anchored to hardware it watched work.
Cold runs (which pay for shader compilation) and physically implausible samples are discarded rather
than clamped, because a bad reading averaged in is worse than no reading at all.

Measured on the machine this was built on (M4 Pro, 254 GB/s, 2.97 TFLOP/s fp16): predicted 101 tok/s
for SmolLM2 360M against 103 measured.

### Two runtimes, on purpose

WebLLM is much faster but only runs models pre-compiled to MLC format. transformers.js runs
arbitrary ONNX exports straight off the Hub. Paste any repo and the resolver tells you which of the
two applies — or refuses with a specific reason (`GGUF is llama.cpp's format`, `MLC weights but no
compiled kernel library`, `no ONNX export`) rather than failing silently.

### Privacy

The relay sees room codes and WebRTC handshake data. It cannot see anything else, because there is
nothing else to see: prompts, tokens, weights and hidden states travel directly between browsers
over encrypted data channels, and inference never leaves the tab.

## What is verified, and what isn't

Verified by running it:

- Device probing, both WGSL benchmarks (stable to ~1% across runs), device identification
- Real generation via WebLLM, with output and speeds matching published figures
- Model catalog, Hugging Face search, repo resolution across MLC / ONNX / unsupported
- The advisor end to end, including its refusals
- Conversation persistence across reloads (Yjs + IndexedDB)
- Model weights, wasm kernels and tokenizers cached to the Cache API
- The signaling relay, and the full WebRTC offer/answer/ICE-candidate exchange between two tabs
- 114 unit tests over the planner, recommender, mesh protocol and the strategies — including a
  remote generation driven end to end through two real `Mesh` objects with only the transport faked
- The whole distributed chat driven in a headless browser against a simulated mesh: the picker and
  its refusals, best-of-n with its sample switcher, splitting a long paste, and holding a
  conversation with no model loaded on this device at all

**Not verified**, because the browser used during development blocks them:

- **Peer-to-peer data channels.** Signaling, SDP exchange and candidate gathering all work, but ICE
  never completes — including for two `RTCPeerConnection`s wired directly together in a single page
  with no signaling at all, which rules out the application code as the cause. Everything above the
  transport is covered by tests against a fake peer, and the distributed strategies were exercised
  against two real meshes wired to each other in process. What has *not* happened is a token
  crossing a genuine `RTCDataChannel` between two machines. Needs confirming in a normal browser.
- **Offline app shell.** The service worker is generated and served correctly but registration fails
  in that environment with a fetch error, without and with COOP/COEP headers. Cached *weights* are
  confirmed working; the offline *shell* is not.

## Not built yet

- **Speculative decoding at runtime.** The *model* of it exists and is tested in
  `planner/recommend.ts`, and the advisor recommends it, but nothing executes it. It needs the
  target model to score a batch of drafted tokens in one forward pass, and neither WebLLM's nor
  transformers.js's chat API exposes the logits to do that. This is the honest gap: it is the one
  arrangement that would make a *single* reply arrive sooner, and it is the one still missing.
- Pipeline-sharded inference across devices, and the Python tool that splits a model into per-layer
  ONNX shards. `RuntimeKind` still has a `'pipeline'` case that refuses with a reason.
- Pulling weights from a peer that already has them rather than from the network. Devices already
  gossip what they have cached (`listCachedModels`); nothing acts on it yet.
- QR-code pairing for the fully offline path. The `Signaler` interface exists and the WebSocket
  implementation sits behind it, so this drops in without touching the mesh.
