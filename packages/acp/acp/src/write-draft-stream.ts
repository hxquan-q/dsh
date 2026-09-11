/**
 * Incremental ACP projection for Write tool-call argument streams (TASK-828 / xiaoai).
 *
 * LLM adapters emit `tool-call-delta` fragments; ACP historically waited for the
 * committed `tool/call` (full JSON). This module extracts a growing `content`
 * string from incomplete Write JSON so the host can paint Canvas while the model
 * is still generating the file.
 *
 * Edit is intentionally skipped: `new_string` is a patch, not the assembled
 * document. Non-markdown targets are also skipped.
 */

export interface WriteDraftIncrement {
  path: string
  seq: number
  delta: string
}

const WRITE_NAMES = new Set(['write'])

/** Basename check matching xiaoai AgentLoopSseRelay.isMarkdownPath. */
export function isMarkdownWritePath(path: string | undefined): boolean {
  if (path === undefined || path.length === 0) return false
  const name = path.replaceAll('\\', '/')
  const slash = name.lastIndexOf('/')
  const file = (slash >= 0 ? name.slice(slash + 1) : name).toLowerCase()
  return file.endsWith('.md') || file.endsWith('.markdown')
}

/**
 * Read one JSON string field from a possibly truncated object literal.
 * Dangling escape sequences are withheld so concat of emitted prefixes stays lossless.
 */
export function extractJsonStringField(
  json: string,
  field: string,
): { value: string; complete: boolean } | undefined {
  const key = `"${field}"`
  let from = 0
  while (from < json.length) {
    const keyAt = json.indexOf(key, from)
    if (keyAt < 0) return undefined
    let i = keyAt + key.length
    while (i < json.length && isJsonWs(json.charCodeAt(i))) i++
    if (json[i] !== ':') {
      from = keyAt + 1
      continue
    }
    i++
    while (i < json.length && isJsonWs(json.charCodeAt(i))) i++
    if (json[i] !== '"') {
      from = keyAt + 1
      continue
    }
    return readJsonString(json, i + 1)
  }
  return undefined
}

function isJsonWs(code: number): boolean {
  return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09
}

function readJsonString(source: string, start: number): { value: string; complete: boolean } {
  let i = start
  let out = ''
  while (i < source.length) {
    const ch = source[i]
    if (ch === '\\') {
      if (i + 1 >= source.length) return { value: out, complete: false }
      const next = source[i + 1]
      if (next === 'u') {
        if (i + 5 >= source.length) return { value: out, complete: false }
        const hex = source.slice(i + 2, i + 6)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { value: out, complete: false }
        out += String.fromCharCode(Number.parseInt(hex, 16))
        i += 6
        continue
      }
      out += unescapeJson(next)
      i += 2
      continue
    }
    if (ch === '"') return { value: out, complete: true }
    out += ch
    i++
  }
  return { value: out, complete: false }
}

function unescapeJson(escaped: string): string {
  switch (escaped) {
    case 'n': return '\n'
    case 'r': return '\r'
    case 't': return '\t'
    case 'b': return '\b'
    case 'f': return '\f'
    default: return escaped
  }
}

/**
 * Per-call accumulator. `push` is lossless: joining every returned `delta` equals
 * the final Write `content` field once the JSON string closes.
 */
export class WriteDraftStreamer {
  private name = ''
  private args = ''
  private emitted = 0
  private seq = 0
  private skip = false

  push(name: string | undefined, argumentsDelta: string): WriteDraftIncrement | undefined {
    if (this.skip) return undefined
    if (name !== undefined && name.length > 0) this.name = name
    this.args += argumentsDelta
    const tool = this.name.toLowerCase()
    if (tool.length > 0 && !WRITE_NAMES.has(tool)) {
      this.skip = true
      return undefined
    }
    if (!WRITE_NAMES.has(tool)) return undefined
    const pathField = extractJsonStringField(this.args, 'file_path')
      ?? extractJsonStringField(this.args, 'path')
    if (pathField === undefined || !pathField.complete) return undefined
    if (!isMarkdownWritePath(pathField.value)) {
      this.skip = true
      return undefined
    }
    const content = extractJsonStringField(this.args, 'content')
    if (content === undefined || content.value.length <= this.emitted) return undefined
    const delta = content.value.slice(this.emitted)
    this.emitted = content.value.length
    this.seq += 1
    return { path: pathField.value, seq: this.seq, delta }
  }
}
