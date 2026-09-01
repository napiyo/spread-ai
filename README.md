# spreadAI

Run language models in a browser tab, on your own GPU, spread across the devices you own.

No install, no account, no inference server. Weights download once and stay cached; conversations
are CRDTs that sync device-to-device. The only backend is a ~150-line relay that introduces
browsers to each other and never sees a prompt, a token, or a weight.

---

## Problem statement

On-device inference is bounded by three limits that get conflated and are not the same thing:

| limit | typical | what actually binds |
|---|---|---|
| Disk / cache quota | tens of GB | almost never |
| GPU or unified memory | 8–16 GB on a laptop, 2–5 GB usable in a browser tab | a 4-bit 70B needs ~40 GB, so it is simply out |
| **Single WebGPU buffer** | ~256 MB on iOS, ~1–2 GB elsewhere | one tensor over the cap fails with memory to spare |

**Storage is not the problem.** Memory is, and inside a browser the per-allocation cap is a harder
wall than total memory.

The reflex is to split the model across devices. That solves capacity and nothing else, because
**splitting one model's layers does not make a single reply faster.** At batch size one the stages
run in sequence and every boundary adds a hop, so a model that already fits on your laptop gets
*slower* when you spread it. Meanwhile the models that actually run well in a browser — 8B and
under, 4-bit, ~4 GB — already fit on one modern laptop, where running them alone is fastest.

So the real question is not "how do I fit a bigger model", it is:

> **Given several devices you already own, what work can actually be moved off one of them — and
> when does moving it make things worse?**

That question has a different answer for each phase of inference, and existing systems answer it for
the wrong machine. Datacenter inference research assumes homogeneous, actively cooled nodes on a
400 Gb/s fabric, so throttling never enters the model and bandwidth is never the constraint. A fleet
of personal devices is the exact opposite: **heterogeneous, passively cooled, on a ~1 Gb/s private
link, and permanently co-located under one owner.** Nobody schedules for that. That gap is where
this project lives.

## Solution

Treat the fleet as **one thermally-constrained accelerator**, and decide per phase rather than per
model:

| phase | nature | can a second device help? |
|---|---|---|
| **Prefill** | compute-bound, prompt is all there at once | **Yes.** The work divides. |
| **Decode** | memory-bandwidth-bound, strictly sequential | **No.** Token n+1 needs token n. |
| **Sustained decode** | bounded by *heat*, not by silicon | **Yes** — hand the rest to a device that is still cool. |
| **Sampling** | independent draws | More answers, **not** a shorter wait. |

Every arrangement in this repo carries the honest account of what it buys, and arrangements that
would only add hops are **refused with a reason and a number** rather than offered. Those sentences
have unit tests that fail if the claim ever inverts. That is the design rule the whole codebase is
built around.

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
                    measure ──────────► predict ──────────► decide ──────────► run
                  capability/          planner/           strategies/        runtime/ + mesh/

apps/web/src/
  capability/   probe the device, benchmark it with two WGSL kernels, name it
    probe · bench (2 WGSL kernels) · identify · deviceDb
  planner/      everything that predicts, and everything that refuses
    modelSpec   bytes per weight, per layer, per KV token
    roofline    decode = bytes/bandwidth · prefill = flops/throughput · calibrate
    thermal     sustained vs peak throughput, and how to learn it from a run
    partition   contiguous layer ranges for pipeline sharding (modelled, not run)
    migrate     when to hand a reply over mid-sentence, and to whom
    prefill     when several devices should read one prompt between them
    recommend   the advisor: what to run, what to buy, what will not help
  catalog/      featured models, Hugging Face search, repo resolution
  runtime/      WebLLM and transformers.js engines behind one interface
  mesh/         WebRTC peers, RPC, capability gossip
    peer · mesh · protocol · signalWs · serve (what we do for peers)
    remoteWorker (a peer, dressed as somewhere a generation can happen)
  strategies/   how one turn is spread over the fleet, and when it refuses to be
    plan (the refusals) · run (the executors) · split (cutting a long input)
  sync/         Yjs document, IndexedDB persistence, mesh sync provider
  scenes/       Landing, Models, Advisor, Fleet, Chat
server/signal/  the introduction relay (SDP and ICE only)
```

Two seams hold it together. **`Capability`** is the only thing the planner consumes — every field
carries how it is known (`measured` / `matched` / `assumed`), so a benchmarked 219 GB/s is never
presented as the same kind of fact as a spec-sheet 273. **`Worker`** is the only thing the
strategies consume — "somewhere a generation can happen", implemented identically by the GPU in this
tab and by a paired device over a data channel, so "run it here" and "run it there" cannot drift
into two implementations.

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

### Scheduling a fleet that gets hot

Every other number in the planner is a **peak**: bandwidth over a one-second sweep, a decode rate
over a few hundred tokens. That is the right number for a short reply and the wrong one for a long
one. `planner/thermal.ts` models what a device does when you keep asking: full clocks for a hold
window, then exponential decay to a sustained floor.

For an 8B at 4-bit on a current flagship phone, that turns out to matter more than any topology:

| reply length | sustained tok/s | share of peak |
|---|---|---|
| 100 tokens | 5.9 | 100% |
| 500 tokens | 4.3 | 72% |
| 1,000 tokens | 3.3 | 56% |
| 4,000 tokens | 2.8 | 47% |

The class priors are labelled `assumed` and are replaced by `calibrateThermal` the moment a long
enough generation has been watched — the same discipline `roofline.calibrate` already applies, down
to refusing to fit from a run that never got hot rather than clamping a guess into range.

Two schedulers ride on that.

**`planner/migrate.ts` — hand the reply over mid-sentence.** The one thing a second device can do
for a *single* long reply. What crosses the wire is the KV cache for everything generated so far, so
the handover gets more expensive exactly as the case for making it gets stronger; the module scans
handover points and finds the crossover. Between two identical phones, one of them idle, over a
1 Gb/s link:

| reply | decision | saves | handover cost |
|---|---|---|---|
| 100 tokens | stay | — | — |
| 500 tokens | move at token 249 | 27 s | 0.96 s |
| 1,000 tokens | move at token 500 | 66 s | 1.2 s |
| 2,000 tokens | move at token 810 | 72 s | 1.6 s |
| 6,000 tokens | **stay** | (72 s, under 5% — inside the model's own error) | — |

It also separates two decisions that look identical and are not. If the target would have won from
the first token, throttling never decided anything — the plan reports `cause: 'faster-device'` and
says so, rather than dressing a routing choice up in thermal caveats. A genuinely thermal handover
only ever happens between devices of **similar speed**, which is a finding, not a caveat.

**`planner/prefill.ts` — read one long prompt on several devices.** Prefill divides; the catch is
that every block must attend to every earlier one, so the devices exchange KV as they go (a ring)
and the winner gathers all of it before decoding. Whether that pays is `prefillRatio` — transfer
cost over compute saved:

| model | 100 Mb/s | 1 Gb/s | 10 Gb/s |
|---|---|---|---|
| GQA 8B (8 KV heads) | 1.69 ✗ | **0.17** ✓ | 0.02 ✓ |
| MHA 8B (32 KV heads) | 6.75 ✗ | 0.67 ✓ | 0.06 ✓ |

**Both terms scale linearly with prompt length, so this ratio does not depend on the prompt at
all.** Whether to split a prompt is a property of the model's KV shape and the link speed — not of
the input. That was not the expected answer, and it is the most useful thing the model produced:
below 1 it wins at essentially any length (measured crossover: ~2 tokens), above 1 it never wins,
however long the prompt gets. Grouped-query attention is what puts a modern model on the right side
of the line.

The payoff, tablet + desktop over 1 Gb/s:

| prompt | time to first token | with the fleet |
|---|---|---|
| 2,000 tokens | 13.9 s | **4.1 s** |
| 8,000 tokens | 66.3 s | **18.0 s** |
| 32,000 tokens | 438.7 s | **96.1 s** |

Decoding is untouched. This shortens the wait for the *first* token, which is the delay a person
actually feels when they paste a document — and it is honest about being nothing more than that.

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
- 136 unit tests over the planner, recommender, mesh protocol and the strategies — including a
  remote generation driven end to end through two real `Mesh` objects with only the transport faked
- The whole distributed chat driven in a headless browser against a simulated mesh: the picker and
  its refusals, best-of-n with its sample switcher, splitting a long paste, and holding a
  conversation with no model loaded on this device at all
- The thermal, migration and parallel-prefill models against their own arithmetic — the integral
  inverts, the crossovers are found by bisection over the real cost model rather than a
  linearisation, and every refusal is asserted

**Not verified, and the numbers above depend on it:**

- **Every thermal and prefill figure in this README is a model output, not a measurement.** The
  roofline has been checked against real generations; the thermal priors have not been measured on
  any device, and no KV cache has ever crossed a link. The tables say what the arithmetic implies
  given those priors — the shapes (a phone at ~50% after a thousand tokens, a ratio that does not
  move with prompt length) are robust to the constants being somewhat wrong; the specific seconds
  are not. `calibrateThermal` exists to replace the priors and has never been fed real data.

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

## Outcome

What this repository now is: **a fleet inference planner with a working runtime attached**, built
around measuring rather than assuming, and around refusing rather than overpromising.

Concretely:

- **Capacity is planned end to end.** Two WGSL kernels measure the device, a roofline model turns
  that into predictions, and every real generation solves backwards for the efficiency constants —
  101 tok/s predicted against 103 measured on the machine this was built on.
- **Work really moves between devices.** A turn runs in this tab or on a paired one over an
  encrypted data channel, streamed token by token, with the transcript naming whose GPU wrote it. A
  device holding no model at all can hold a conversation through one that does.
- **Three execution strategies ship**, with their refusals: one device, best-of-n across several,
  and map-reduce over a long input.
- **Two scheduling models ship** for the things that genuinely shorten a single reply: thermal
  handover mid-generation, and parallel prefill of one long prompt.
- **One non-obvious result fell out of the arithmetic.** The cost of splitting a prompt, relative to
  the compute it saves, is independent of prompt length. Whether to do it is a property of the
  model's KV shape and the link — 0.17 for a grouped-query 8B over 1 Gb/s, 6.75 for a multi-head one
  over 100 Mb/s. It is decidable once per pairing, not per request.
- **The honesty is enforced by CI, not by prose.** 136 tests, including ones that fail if a plan
  ever starts describing a second device as faster when it is not.

And what it deliberately does not claim: no arrangement here makes a short reply on a capable device
arrive sooner, because none can.

## Future plan

Ordered by expected payoff, not by ease.

1. **Execute a thermal handover, not just plan one.** The planner names the token to move at; the
   runtime cannot yet export a KV cache, ship it and resume. This needs an engine-level KV
   serialisation path that neither WebLLM nor transformers.js exposes today — likely the largest
   single piece of work in this list, and the one with the clearest payoff.
2. **Execute parallel prefill.** Same blocker, same shape: it needs KV in and out of the engine, plus
   a ring exchange across the mesh. The cost model says a tablet and a desktop should turn a 66 s
   wait into 18 s; nothing yet finds out whether they do.
3. **Speculative decoding at runtime.** The model exists and the advisor recommends it. It needs the
   target to score a batch of drafted tokens in one forward pass, and no browser inference API
   exposes logits for that. Native (NNAPI / Core ML / QNN) does — which is the argument for a native
   port more than for anything else here.
4. **Pull weights from a peer instead of the network.** Devices already gossip what they have cached
   (`listCachedModels`); nothing acts on it. A phone on a hotel connection loading 4 GB from the
   laptop next to it, not from Hugging Face.
5. **Measure the thermal priors.** They are labelled `assumed` and the calibration path is written
   and tested; it needs long generations on real hardware to become `measured`.
6. **QR pairing**, for a fleet with no network at all. The `Signaler` interface already exists.
7. **Pipeline-sharded execution**, and the tool that splits a model into per-layer ONNX shards.
   Bottom of the list on purpose: it buys capacity only, and the capacity case is narrow.

## Research areas yet to explore

Open questions this codebase now makes it possible to ask, none of which it answers.

- **Multi-hop thermal scheduling.** One handover cannot rescue a reply long enough to cook both
  devices — the model says so and stops recommending one. Alternating between devices as each cools,
  a duty cycle across a fleet, is the obvious next question and is unstudied. What is the optimal
  policy when every node has its own thermal RC constant and moving state costs bandwidth?
- **Thermal behaviour as a first-class device property.** Everyone benchmarks peak. Almost nobody
  publishes hold time and sustained floor, yet for any reply over ~500 tokens those decide the
  ranking. What does a benchmark suite look like that reports them honestly?
- **Energy as the objective instead of latency.** These are personal devices on batteries. The right
  question is often not "which is fastest" but "which finishes without costing 8% of a phone
  battery". Nothing in this planner models joules yet.
- **Cascade inference across a fleet.** A small model on the phone answers, and escalates to the big
  model on the tablet only when its own uncertainty is high. Cheap in the common case, and it makes
  *average* latency fall in a way no arrangement here does. What is the right uncertainty signal, and
  how much of the small model's work can the big one reuse?
- **KV cache as a synchronised object.** Conversations already sync as CRDTs. If the KV cache
  followed, moving between devices mid-conversation would stop re-prefilling the history. Is a
  quantised, prefix-addressed KV cache small enough to sync over a room-speed link, and how much
  quality does the quantisation cost?
- **Where the KV/compute ratio actually sits across the model zoo.** `prefillRatio` reduces the
  parallel-prefill decision to one number per (model, link). Sweeping real architectures — MHA, GQA,
  MQA, MLA, sliding-window, and the KV-compression literature — would say which models are
  fleet-friendly *by construction*. That looks like a paper.
- **Whether these predictions survive contact with hardware.** Everything above is a model. The
  roofline has been checked against real generations; the thermal and prefill models have not.

## Not built yet

- **Thermal handover and parallel prefill execute nothing.** Both are planners: they say what to do,
  what it costs and when to refuse, and the runtime has no way to carry a KV cache between engines.
  This is the honest gap and it is deliberate — the arithmetic was worth settling before writing the
  hard part.
- **Speculative decoding at runtime.** The *model* of it exists and is tested in
  `planner/recommend.ts`, and the advisor recommends it, but nothing executes it. It needs the
  target model to score a batch of drafted tokens in one forward pass, and neither WebLLM's nor
  transformers.js's chat API exposes the logits to do that.
- Pipeline-sharded inference across devices, and the Python tool that splits a model into per-layer
  ONNX shards. `RuntimeKind` still has a `'pipeline'` case that refuses with a reason.
- Pulling weights from a peer that already has them rather than from the network. Devices already
  gossip what they have cached (`listCachedModels`); nothing acts on it yet.
- QR-code pairing for the fully offline path. The `Signaler` interface exists and the WebSocket
  implementation sits behind it, so this drops in without touching the mesh.
