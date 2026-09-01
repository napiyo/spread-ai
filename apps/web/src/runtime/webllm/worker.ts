/// <reference lib="webworker" />
import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm'

/**
 * WebLLM runs on a dedicated worker so that model compilation and the decode
 * loop never block the main thread — the fleet graph has to keep animating
 * while tokens are being produced.
 */
const handler = new WebWorkerMLCEngineHandler()
self.onmessage = (msg: MessageEvent) => handler.onmessage(msg)
