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
help, and there are tests that fail if it ever starts claiming otherwise.

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
  mesh/         WebRTC peers, RPC, and capability gossip
  sync/         Yjs document, IndexedDB persistence, mesh sync provider
  scenes/       Landing, Models, Advisor, Fleet, Chat
server/signal/  the introduction relay (SDP and ICE only)
```

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
- 69 unit tests over the planner, recommender and mesh protocol

**Not verified**, because the browser used during development blocks them:

- **Peer-to-peer data channels.** Signaling, SDP exchange and candidate gathering all work, but ICE
  never completes — including for two `RTCPeerConnection`s wired directly together in a single page
  with no signaling at all, which rules out the application code as the cause. Everything above the
  transport is covered by tests against a fake peer. Needs confirming in a normal browser.
- **Offline app shell.** The service worker is generated and served correctly but registration fails
  in that environment with a fetch error, without and with COOP/COEP headers. Cached *weights* are
  confirmed working; the offline *shell* is not.

## Not built yet

- Distributed execution strategies (remote-run, map-reduce, parallel sampling, speculative decoding).
  The speculative decoding *model* exists and is tested in `planner/recommend.ts`; the runtime that
  executes it does not.
- Pipeline-sharded inference across devices, and the Python tool that splits a model into per-layer
  ONNX shards.
- QR-code pairing for the fully offline path. The `Signaler` interface exists and the WebSocket
  implementation sits behind it, so this drops in without touching the mesh.
