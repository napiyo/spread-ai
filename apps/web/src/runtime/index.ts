import { RuntimeError, type LoadableModel, type Runtime } from './types'

/**
 * Builds the right engine for a model. One engine is live at a time.
 *
 * Both engines are imported dynamically: together they are most of the weight
 * of this application, and neither is needed until someone actually chooses a
 * model. Nothing about the landing page, the advisor or the fleet graph should
 * wait on a multi-megabyte inference library.
 */
export async function createRuntime(model: LoadableModel): Promise<Runtime> {
  switch (model.runtime) {
    case 'webllm': {
      const { WebLlmRuntime } = await import('./webllm')
      return new WebLlmRuntime()
    }
    case 'onnx': {
      const { OnnxRuntime } = await import('./onnx')
      return new OnnxRuntime()
    }
    case 'pipeline':
      throw new RuntimeError(
        'Pipeline-sharded models are not wired up yet.',
        'This is the path that splits one model across several devices.',
      )
  }
}

export * from './types'
