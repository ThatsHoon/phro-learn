import { expect, mock, test } from 'claude-code/testing'

import type { Found } from './register'
import { answerTexts, comments, emptyDb, normalize, pick, scanVerdict, tally } from './register'

const line = (o: unknown) => JSON.stringify(o)
const said = (text: string, at: string, more: Record<string, unknown> = {}) =>
  line({ type: 'assistant', isSidechain: false, timestamp: at, message: { content: [{ type: 'thinking', thinking: 'LoRA?' }, { type: 'text', text }] }, ...more })

test('answers come from the main thread only, without thinking, tool calls or a half-written last line', () => {
  const lines = [
    said('Use RAG here.', '2026-01-02T00:00:00Z'),
    said('A subagent says MLflow.', '2026-01-03T00:00:00Z', { isSidechain: true }),
    line({ type: 'user', message: { content: [{ type: 'text', text: 'what is Kafka' }] } }),
    line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }),
    '{"type":"assistant","message":{"content":[{"type":"text","text":"cut',
  ].join('\n')
  expect(answerTexts(lines)).toEqual([{ text: 'Use RAG here.', at: '2026-01-02T00:00:00Z' }])
})

test('code files give their comments only', () => {
  const ts = '// Retries with exponential backoff\nconst LoRA = 1 // not this\n/**\n * Uses the CRDT merge\n */\nfoo()'
  expect(comments(ts, 'ts')).toBe('Retries with exponential backoff\n\nUses the CRDT merge')
  expect(comments('#!/usr/bin/env python\n# Calls the OCR step\nx = 1', 'py')).toBe('Calls the OCR step')
  expect(comments('-- joins via CTE\nselect 1', 'sql')).toBe('joins via CTE')
  expect(comments('// RAG', 'png')).toBe('')
})

test('candidates count once per text, keep their earliest time, and the most used go first', () => {
  const found = new Map<string, Found>()
  tally(found, 'RAG and RAG again with LoRA.', '2026-03-01T00:00:00Z')
  tally(found, 'Then RAG met PyTorch.', '2026-01-01T00:00:00Z')
  const rag = found.get('rag')!
  expect([rag.n, rag.seen, rag.context]).toEqual([2, '2026-01-01T00:00:00Z', 'Then RAG met PyTorch.'])
  const db = { ...emptyDb(), ignored: [normalize('PyTorch')] }
  expect(pick(found.values(), db).map(f => f.word)).toEqual(['RAG', 'LoRA'])
  expect(pick(found.values(), db, w => w === 'LoRA', 1).map(f => f.word)).toEqual(['RAG'])
})

test('the record decides: none or a failed run lets it run, anything else refuses, an unreadable one too', () => {
  expect(scanVerdict(undefined, 'p')).toBeUndefined()
  expect(scanVerdict('{"state":"failed","at":"2026-01-01T00:00:00Z"}', 'p')).toBeUndefined()
  expect(scanVerdict('{"state":"done","at":"2026-01-05T09:00:00Z","queued":12}', 'p')).toContain('2026-01-05')
  expect(scanVerdict('{"state":"running","at":"2026-01-05T09:00:00Z","by":"x"}', '/r.json')).toContain('/r.json')
  expect(scanVerdict('{"stat', '/r.json')).toContain('/r.json')
  expect(scanVerdict('[]', '/r.json')).toContain('/r.json')
})

type Q = { word: string; seen: string; context: string }
const DB = '/home/.claude/phro-learning/terms.json'

/** A machine with one project, two sessions of it (a fork among them), a subagent run, and a few files. */
function machine(on: Parameters<Parameters<typeof test>[1]>[1]) {
  const at = (path: string) => path.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/')
  const T = '/home/.claude/projects/C--w' // the session folder C:\w, as Claude Code names its transcript folder
  const files = new Map<string, string>([
    [`${T}/s1.jsonl`, [said('We use RAG with LoRA.', '2026-02-01T00:00:00Z'), said('RAG again.', '2026-02-02T00:00:00Z')].join('\n') + '\n'],
    [`${T}/fork.jsonl`, said('The fork brought up MLflow.', '2026-02-03T00:00:00Z') + '\n'],
    [`${T}/s1/subagents/a.jsonl`, said('Only the subagent saw Kafka.', '2026-02-04T00:00:00Z') + '\n'],
    ['/w/README.md', '# Shop\n\nThe API serves GraphQL.\n'],
    ['/w/src/app.ts', '// Talks to the cache over RESP\nconst x = "WebSocket"\n'],
    ['/w/node_modules/x/README.md', 'Terraform here is a dependency.'],
    ['/w/.git/notes.md', 'Ansible is in a dot folder.'],
  ])
  const dirs = (path: string) => {
    const kids = new Map<string, 'file' | 'dir'>()
    for (const f of files.keys()) {
      if (!f.startsWith(path + '/')) continue
      const [name, ...rest] = f.slice(path.length + 1).split('/')
      kids.set(name!, rest.length ? 'dir' : 'file')
    }
    if (!kids.size) throw new Error('ENOENT')
    return [...kids].map(([name, kind]) => ({ name, kind, size: kind === 'file' ? new TextEncoder().encode(files.get(`${path}/${name}`)!).length : 0, mtimeMs: Date.parse('2026-01-01'), isLink: false }))
  }
  on('command.register', () => ({ value: { command: 'phro-learn' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'C:\\w' }) as never)
  on('session.root', () => ({ value: 'C:\\w' }) as never)
  on('ui.toast', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home' : undefined }))
  on('fs.list', (_, e) => ({ value: dirs(at(e.path)) }) as never)
  on('fs.stat', (_, e) => {
    if (!files.has(at(e.path))) throw new Error('ENOENT')
    return { value: { mtimeMs: files.get(at(e.path))!.length, size: 1, isFile: true, isDirectory: false } } as never
  })
  on('fs.read', (_, e) => {
    const text = files.get(at(e.path))
    if (text === undefined) throw new Error('ENOENT')
    if (e.as !== 'bytes') return { value: text }
    const bytes = new TextEncoder().encode(text).subarray(e.offset ?? 0, (e.offset ?? 0) + (e.length ?? Infinity))
    return { value: { base64: btoa(String.fromCharCode(...bytes)) } } as never
  })
  // what each write that grew the queue put in it: the judge drains the queue right after
  const queued: Q[][] = []
  on('fs.write', (_, e) => {
    const path = at(e.path)
    const was = path === DB ? queue() : []
    files.set(path, e.text)
    if (path === DB && queue().length > was.length) queued.push(queue())
    return { value: undefined }
  })
  const queue = (): Q[] => JSON.parse(files.get(DB) ?? '{"pending":[]}').pending
  let models = 0
  on('model.complete', () => {
    models++
    return { value: { isAnswered: true, text: '-', usage: { input_tokens: 1, output_tokens: 1 } } } as never
  })
  const record = () => [...files].find(([k]) => k.startsWith('/home/.claude/phro-learning/scans/'))
  return { files, record, queued, models: () => models }
}

const scan = (kind: string) => ({ command: 'phro-learn', args: 'scan', origin: { kind }, presentation: { isFullscreen: false, columns: 80 } }) as never

type Clock = { advance(ms: number): Promise<void> }
/** Runs the command while moving the clock on, so the claim's wait passes; `meanwhile` acts once the claim is written. */
async function run($: Parameters<Parameters<typeof test>[1]>[0], clock: Clock, kind: string, meanwhile?: () => boolean) {
  let reply: { text?: string } | undefined
  const going = $.command.run(scan(kind)).then(r => (reply = r as { text?: string }))
  let isDone = false
  for (let i = 0; i < 50 && !reply; i++) {
    if (!isDone && meanwhile) isDone = meanwhile()
    await clock.advance(50)
  }
  await going
  return reply!.text ?? ''
}

test('the first scan reads every session and fork and the project files, once; a second run is refused', { options: { language: 'en' } }, async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  const m = machine(on)
  await $.session.start({ cwd: 'C:\\w', surface: 'desktop', isInteractive: true })

  // a model, a plugin or a schedule cannot start it
  for (const kind of ['plugin', 'peer', 'scheduled-trigger', 'unclassified']) expect(await run($, clock, kind)).toContain('/phro-learn scan')
  expect(m.record()).toBeUndefined()

  expect(await run($, clock, 'composer')).toContain('3 answers')
  expect(m.queued.length).toBe(1)
  const words = m.queued[0]!.map(p => p.word)
  expect(words[0]).toBe('RAG')
  expect(words).toEqual(expect.arrayContaining(['LoRA', 'MLflow', 'GraphQL', 'RESP']))
  // a subagent's run, a dependency, a dot folder and code that is not a comment stay out
  for (const w of ['Kafka', 'Terraform', 'Ansible', 'WebSocket']) expect(words).not.toContain(w)
  expect(m.queued[0]!.find(p => p.word === 'RAG')).toMatchObject({ seen: '2026-02-01T00:00:00Z', context: 'We use RAG with LoRA.' })
  const [path, record] = m.record()!
  expect(path).toMatch(/\/scans\/w-[0-9a-f]{12}\.json$/)
  expect(JSON.parse(record)).toMatchObject({ state: 'done', queued: words.length, answers: 3, files: 2 })

  // again: refused with the day it ran, and nothing more is queued or judged
  const models = m.models()
  expect(models).toBeGreaterThan(0)
  expect(await run($, clock, 'composer')).toContain('already ran')
  expect(m.queued.length).toBe(1)
  expect(m.models()).toBe(models)
})

test('another session claiming at the same time, a run left unfinished or an unreadable record refuses; a failed run may run again', { options: { language: 'en' } }, async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  const m = machine(on)
  await $.session.start({ cwd: 'C:\\w', surface: 'desktop', isInteractive: true })

  // a second session writes its claim over this one's while this one waits
  const busy = await run($, clock, 'composer', () => {
    const r = m.record()
    if (!r) return false
    m.files.set(r[0], '{"state":"running","at":"2026-02-05T00:00:00Z","by":"other"}\n')
    return true
  })
  expect(busy).toContain('Another run')
  expect(m.queued).toEqual([])
  const [path] = m.record()!

  expect(await run($, clock, 'sdk')).toContain(path)
  m.files.set(path, 'not json')
  expect(await run($, clock, 'bridge')).toContain(path)
  expect(m.queued).toEqual([])

  m.files.set(path, '{"state":"failed","at":"2026-02-05T00:00:00Z"}\n')
  expect(await run($, clock, 'composer')).toContain('3 answers')
  expect(m.queued.length).toBe(1)
  expect(JSON.parse(m.record()![1]).state).toBe('done')
})
