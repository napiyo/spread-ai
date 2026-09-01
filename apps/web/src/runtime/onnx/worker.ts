/// <reference lib="webworker" />
import {
  AutoModelForCausalLM, AutoTokenizer, InterruptableStoppingCriteria, TextStreamer,
  type PreTrainedModel, type PreTrainedTokenizer,
} from '@huggingface/transformers'

/**
 * transformers.js runtime, running on a worker.
 *
 * This is the path that makes "paste any Hugging Face link" real: it loads
 * ordinary ONNX exports straight from the Hub. It is slower than WebLLM, whose
 * kernels are compiled ahead of time for each architecture, but it is not
 * limited to a fixed catalogue.
 */

type In =
  | { type: 'load'; repo: string; dtype: string; contextWindow: number }
  | { type: 'generate'; id: number; messages: unknown[]; options: Record<string, unknown> }
  | { type: 'interrupt' }
  | { type: 'unload' }

let tokenizer: PreTrainedTokenizer | null = null
let model: PreTrainedModel | null = null
let stopper: InterruptableStoppingCriteria | null = null

const post = (m: unknown) => (self as unknown as Worker).postMessage(m)

self.onmessage = async (e: MessageEvent<In>) => {
  const msg = e.data
  try {
    switch (msg.type) {
      case 'load':
        await load(msg.repo, msg.dtype)
        break
      case 'generate':
        await generate(msg.id, msg.messages, msg.options)
        break
      case 'interrupt':
        stopper?.interrupt()
        break
      case 'unload':
        await model?.dispose()
        model = null
        tokenizer = null
        break
    }
  } catch (err) {
    post({ type: 'error', error: err instanceof Error ? err.message : String(err) })
  }
}

async function load(repo: string, dtype: string) {
  // transformers.js reports progress per file. We forward the raw events and
  // let the main thread aggregate, so the UI can show which file is arriving.
  const progress_callback = (p: Record<string, unknown>) => post({ type: 'progress', payload: p })

  tokenizer = await AutoTokenizer.from_pretrained(repo, { progress_callback })
  model = await AutoModelForCausalLM.from_pretrained(repo, {
    dtype: dtype as never,
    device: 'webgpu',
    progress_callback,
  })

  // First generation compiles shaders and is dramatically slower than the rest.
  // Doing one token here keeps that cost out of the user's first message.
  post({ type: 'phase', phase: 'warming' })
  const warm = tokenizer('hello')
  await model.generate({ ...warm, max_new_tokens: 1 })

  post({ type: 'ready' })
}

async function generate(id: number, messages: unknown[], options: Record<string, unknown>) {
  if (!model || !tokenizer) throw new Error('No model is loaded.')

  const inputs = tokenizer.apply_chat_template(messages as never, {
    add_generation_prompt: true,
    return_dict: true,
  }) as Record<string, unknown>

  stopper = new InterruptableStoppingCriteria()

  let started = 0
  const t0 = performance.now()
  let count = 0

  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (text: string) => {
      if (!text) return
      if (!started) started = performance.now()
      count++
      post({ type: 'token', id, delta: text })
    },
  })

  const out = await model.generate({
    ...inputs,
    ...options,
    streamer,
    stopping_criteria: stopper,
    return_dict_in_generate: false,
  })

  const totalMs = performance.now() - t0
  const ttftMs = started ? started - t0 : totalMs
  const promptTokens = Number((inputs.input_ids as { dims?: number[] })?.dims?.[1] ?? 0)

  post({
    type: 'done',
    id,
    stats: {
      promptTokens,
      completionTokens: count,
      ttftMs,
      prefillTokPerSec: promptTokens / (ttftMs / 1000),
      decodeTokPerSec: count / Math.max(0.001, (totalMs - ttftMs) / 1000),
      totalMs,
    },
    interrupted: stopper.interrupted,
  })
  void out
}
