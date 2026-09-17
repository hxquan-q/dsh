import { describe, expect, it } from 'vitest'
import {
  extractJsonStringField,
  WriteDraftStreamer,
} from '../src/write-draft-stream.ts'

describe('extractJsonStringField', () => {
  it('reads a complete string and withholds a dangling escape', () => {
    expect(extractJsonStringField('{"file_path":"report.md"}', 'file_path'))
      .toEqual({ value: 'report.md', complete: true })
    expect(extractJsonStringField('{"content":"hello\\', 'content'))
      .toEqual({ value: 'hello', complete: false })
  })
})

describe('WriteDraftStreamer', () => {
  it('concatenates streamed Write chunks to the exact content field', () => {
    const streamer = new WriteDraftStreamer()
    const chunks = [
      { name: 'write', delta: '{"file_path":"docs/report.md","content":"# A\\n\\n' },
      { name: undefined, delta: 'B\\u4e2d' },
      { name: undefined, delta: '文"}' },
    ]
    const deltas: string[] = []
    for (const chunk of chunks) {
      const increment = streamer.push(chunk.name, chunk.delta)
      if (increment !== undefined) deltas.push(increment.delta)
    }
    expect(deltas.join('')).toBe('# A\n\nB中文')
    expect(deltas.length).toBeGreaterThan(0)
    const last = streamer.push(undefined, '')
    expect(last).toBeUndefined()
  })

  it('does not emit for Edit or non-markdown Write', () => {
    const edit = new WriteDraftStreamer()
    expect(edit.push('edit', '{"file_path":"report.md","new_string":"# x"}')).toBeUndefined()
    expect(edit.push(undefined, '{"file_path":"report.md","content":"# x"}')).toBeUndefined()

    const csv = new WriteDraftStreamer()
    expect(csv.push('write', '{"file_path":"data.csv","content":"a,b"}')).toBeUndefined()
  })

  it('assigns monotonic seq starting at 1', () => {
    const streamer = new WriteDraftStreamer()
    const first = streamer.push('Write', '{"file_path":"a.md","content":"ab')
    const second = streamer.push(undefined, 'cd"}')
    expect(first).toMatchObject({ path: 'a.md', seq: 1, delta: 'ab' })
    expect(second).toMatchObject({ path: 'a.md', seq: 2, delta: 'cd' })
  })
})
