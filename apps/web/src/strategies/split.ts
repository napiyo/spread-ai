/**
 * Cutting one long request into pieces several devices can work on at once.
 *
 * This is the one place where spreading work across devices makes a single
 * answer arrive *sooner*, because the pieces are genuinely independent — unlike
 * splitting a model's layers, where every token still has to walk the chain.
 */

/**
 * Below this the map step is not worth its round trips. A device that can hold
 * the model can read a few thousand characters in about the time it takes to
 * ask two other devices to read a third of it each.
 */
export const MAP_MIN_CHARS = 4_000

/**
 * Roughly how much text to give one device at a time — about 1,500 tokens,
 * which a small model with a 4k window can read without crowding out its own
 * answer. Cutting to this size rather than to one part per device is what makes
 * the work queue mean anything: a laptop can get through four of these while a
 * phone is still on its first.
 */
export const MAP_CHUNK_CHARS = 6_000

/** An instruction longer than this is not an instruction, it is the document. */
const MAX_INSTRUCTION_CHARS = 400

export interface SplitTask {
  /** What to do with the document, when the message says so separately. */
  instruction: string | null
  document: string
}

/**
 * Separates "what to do" from "what to do it to".
 *
 * People paste long input in one of two shapes: the ask on top ("Summarise
 * this:" followed by ten thousand characters) or the ask at the bottom (the
 * document, then "so what are the risks?"). A short first or last paragraph
 * against a long body is that ask; anything else is treated as document with no
 * separate instruction, which is honest rather than clever.
 */
export function splitTask(text: string): SplitTask {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  if (paragraphs.length < 2) return { instruction: null, document: text.trim() }

  const first = paragraphs[0]
  const rest = paragraphs.slice(1).join('\n\n')
  if (first.length <= MAX_INSTRUCTION_CHARS && rest.length >= MAP_MIN_CHARS) {
    return { instruction: first, document: rest }
  }

  const last = paragraphs[paragraphs.length - 1]
  const head = paragraphs.slice(0, -1).join('\n\n')
  if (last.length <= MAX_INSTRUCTION_CHARS && head.length >= MAP_MIN_CHARS) {
    return { instruction: last, document: head }
  }

  return { instruction: null, document: text.trim() }
}

/**
 * Splits a document into `parts` pieces of roughly equal size.
 *
 * Cuts fall on paragraph boundaries where there are any, then on sentence
 * boundaries, and only between words as a last resort. A chunk that ends
 * mid-word makes a model invent the rest of it.
 */
export function chunk(document: string, parts: number): string[] {
  const text = document.trim()
  if (parts <= 1 || !text) return text ? [text] : []

  const { units, join } = splitIntoUnits(text)
  if (units.length <= parts) return units

  const target = Math.ceil(text.length / parts)
  const out: string[] = []
  let current = ''

  for (let i = 0; i < units.length; i++) {
    const unit = units[i]
    const bucketsLeft = parts - out.length
    const unitsLeft = units.length - i

    // Once as few units remain as there are buckets left, each takes exactly
    // one — otherwise a greedy fill can leave the last device with nothing.
    if (current && unitsLeft < bucketsLeft) {
      out.push(current)
      current = unit
      continue
    }
    if (current && current.length + unit.length > target && bucketsLeft > 1) {
      out.push(current)
      current = unit
    } else {
      current = current ? current + join + unit : unit
    }
  }
  if (current) out.push(current)
  return out
}

function splitIntoUnits(text: string): { units: string[]; join: string } {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  if (paragraphs.length > 1) return { units: paragraphs, join: '\n\n' }

  const sentences = text.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g)?.map((x) => x.trim()).filter(Boolean)
  if (sentences && sentences.length > 1) return { units: sentences, join: ' ' }

  const words = text.split(/\s+/).filter(Boolean)
  return words.length > 1 ? { units: words, join: ' ' } : { units: [text], join: ' ' }
}

/**
 * How many pieces to cut a document into for a given number of devices.
 *
 * At least one each, or the extra devices sit idle. More than one each when the
 * document is long, so a fast device can take several while a slow one takes
 * one. Capped, because past a handful of parts per device the reduce step is
 * reading more notes than the original document.
 */
export function partsFor(documentLength: number, workers: number): number {
  const bySize = Math.ceil(documentLength / MAP_CHUNK_CHARS)
  return Math.max(workers, Math.min(bySize, workers * 4))
}
