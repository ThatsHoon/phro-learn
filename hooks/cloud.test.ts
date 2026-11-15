import { expect, mock, test } from 'claude-code/testing'

import type { Remote, Term } from '../types'
import { applyRemote, candidates, emptyDb, enqueue, isSecretLike, maskKeys, migrate, normalize } from './register'

const NOW = '2026-11-15T00:00:00.000Z'
const remote = (id: string, term: string, rest: Partial<Remote> = {}): Remote => ({
  id, key: normalize(term), term, status: 'todo', pending: false, kind: 'concept', meaning: '뜻', example: '예시', ...rest,
})

test('keys and tokens are not words; long plain words are', () => {
  for (const s of ['AKIAIOSFODNN7EXAMPLE', 'sk-abc123', 'a8Kd92LmQz71XyPw04RtBn6Vc']) expect(isSecretLike(s)).toBe(true)
  for (const s of ['RAG', 'beam search', 'internationalization', 'Electroencephalography']) expect(isSecretLike(s)).toBe(false)
})

test('the project\'s own names and .termboardignore lines are masked, and * turns collecting off', () => {
  const m = maskKeys('C:\\Users\\kim\\work\\Atlas', '[remote "origin"]\n\turl = https://github.com/AcmeCorp/atlas-api.git\n', '{"name":"@acme/atlas-web"}', 'name = "atlas_core"', 'Project Falcon\n')
  for (const k of ['atlas', 'acmecorp', 'atlasapi', 'atlasweb', 'atlascore', 'projectfalcon', 'kim']) expect(m.keys.has(k)).toBe(true)
  expect(m.keys.has('rag')).toBe(false)
  expect(m.isOff).toBe(false)
  expect(maskKeys('/w', '', '', '', '*').isOff).toBe(true)

  const db = enqueue(emptyDb(), '이 작업은 RAG 와 Atlas 를 함께 씁니다.', NOW, w => m.keys.has(normalize(w)))
  expect(db.pending.map(p => p.word)).toEqual(['RAG'])
})

test('server terms land in the local copy: new on top, same id or same key replaced, pending skipped', () => {
  const local: Term = { key: 'rag', term: 'RAG', aliases: ['retrievalaugmentedgeneration'], meaning: 'old', example: '', status: 'done' }
  let db = applyRemote({ ...emptyDb(), terms: [local] }, [
    remote('ut_1', 'RAG', { meaning: '검색으로 답을 보강' }),
    remote('ut_2', 'LoRA', { pending: true }),
    remote('ut_3', 'Kubernetes', { kind: 'tool', status: 'hidden' }),
  ])
  expect(db.terms.map(t => t.id)).toEqual(['ut_3', 'ut_1'])
  expect(db.terms[1]).toMatchObject({ meaning: '검색으로 답을 보강', aliases: ['retrievalaugmentedgeneration'], status: 'todo' })
  expect(db.terms[0]).toMatchObject({ kind: 'tool', status: 'todo' })

  db = applyRemote(db, [remote('ut_1', 'RAG(Retrieval-Augmented Generation)', { status: 'removed' })])
  expect(db.terms).toHaveLength(2)
  expect(db.terms[1]).toMatchObject({ term: 'RAG(Retrieval-Augmented Generation)', status: 'removed' })
})

test('a tab change not yet sent is kept over what the server still has', () => {
  const mine: Term = { key: 'rag', term: 'RAG', aliases: [], meaning: 'm', example: '', status: 'done', id: 'ut_1', push: true }
  const db = applyRemote({ ...emptyDb(), terms: [mine] }, [remote('ut_1', 'RAG')])
  expect(db.terms[0]).toMatchObject({ meaning: '뜻', example: '예시', status: 'done', push: true })
})

test('the connection survives a reload of terms.json', () => {
  expect(migrate({ cloud: { server: 'http://localhost:8000', plan: 'free' } }).cloud?.plan).toBe('free')
  expect(migrate({}).cloud).toBeUndefined()
})

// A stand-in for the service: device connection, ingest, bootstrap and one glossary page.
test('login connects, and from then on candidates go to the service and no model is called', { options: { language: 'ja' } }, async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  const files = new Map<string, string>()
  const sent: { url: string; body: any; auth?: string }[] = []
  let models = 0
  let account = 'ko'
  on('command.register', () => ({ value: { command: 'phro-learn' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/w' }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('ui.toast', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home' : undefined }))
  // a file that is not there: the plugin reads a throw as "no such file"
  on('fs.stat', (_, e) => {
    if (!files.has(e.path)) throw new Error('ENOENT')
    return { value: { mtimeMs: files.get(e.path)!.length, size: 1, isFile: true, isDirectory: false } } as never
  })
  on('fs.read', (_, e) => {
    if (!files.has(e.path)) throw new Error('ENOENT')
    return { value: files.get(e.path)! }
  })
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('model.complete', () => {
    models++
    throw new Error('no model in cloud mode')
  })
  on('http.fetch', (_, e) => {
    const path = e.url.replace('http://localhost:8000/v1', '')
    const body = e.init?.body ? JSON.parse(e.init.body as string) : undefined
    sent.push({ url: path, body, auth: e.init?.headers?.Authorization })
    const reply = (status: number, data: unknown) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(data) } })
    if (path === '/auth/device/code') return reply(200, { device_code: 'dc', user_code: 'KQ7M-XR2P', verification_uri: 'http://localhost:8000/#connect', expires_in: 600, interval: 5 })
    if (path === '/auth/device/token') return reply(200, { access_token: 'at', refresh_token: 'rt', expires_in: 900 })
    if (path === '/me/profile') return reply(200, { locale: (account = body.locale) })
    if (path === '/client/bootstrap') return reply(200, { plan: 'free', blur: { unlock_left: null }, ingest: true, locale: account, names: { etag: 'h-1' } })
    if (path === '/client/names') return reply(200, { etag: 'h-1', lang: 'ko', items: ['전환율', '귀무가설'], strings: {} })
    if (path === '/ingest') return reply(200, { known: [], queued: body.items.length, retry_after_ms: 0 })
    if (path === '/me/terms') return reply(200, { items: [remote('ut_1', 'RAG')], next: 'c1' })
    return reply(200, { items: [], next: 'c1' })
  })

  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  const out = await $.command.run({ command: 'phro-learn', args: 'login' })
  expect(JSON.stringify(out)).toContain('KQ7M-XR2P')
  await clock.advance(5000)

  await $.turn.complete({ reason: 'answer', answer: '이 구조는 LoRA 와 beam search 를 씁니다. 경로는 src/secret/file.ts 입니다.' } as never)
  await clock.advance(20000)
  const ingest = sent.find(s => s.url === '/ingest')
  expect(ingest?.auth).toBe('Bearer at')
  expect(ingest?.body.items.map((i: { t: string }) => i.t)).toEqual(['LoRA', 'beam search'])
  expect(JSON.stringify(ingest?.body)).not.toContain('secret')
  expect(models).toBe(0)

  const db = JSON.parse([...files.values()][0]!) // the one file written: terms.json under the home folder
  expect(db.terms.map((t: Term) => t.id)).toEqual(['ut_1'])
  expect(db.cloud).toMatchObject({ plan: 'free', cursor: 'c1' })
  expect(db.cloud.unlockLeft).toBeUndefined() // no daily cap: no count in the pane
  expect(db.pending).toEqual([])
  expect(db.ignored).toEqual(['lora', 'beamsearch'])

  // the sync above fetched the catalog's names once; an answer written only in Korean now yields them
  expect(sent.filter(s => s.url === '/client/names')).toHaveLength(1)
  // the language chosen at install is set on the account once; after that the account already has it
  expect(sent.filter(s => s.url === '/me/profile').map(s => s.body)).toEqual([{ locale: 'ja' }])
  sent.length = 0
  await $.turn.complete({ reason: 'answer', answer: '이 광고의 전환율이 낮습니다. 전환율을 다시 봅니다.' } as never)
  await clock.advance(20000)
  expect(sent.find(s => s.url === '/ingest')?.body.items.map((i: { t: string }) => i.t)).toEqual(['전환율'])
  expect(sent.some(s => s.url === '/client/names')).toBe(false) // same version: not fetched again
})

test('a Korean name is a candidate at the start of a word, not as the tail of another word', () => {
  const names = ['전환율', '금리', '고객 획득 비용']
  expect(candidates('전환율과 고객 획득 비용을 봅니다. 지금리뷰는 아닙니다.', emptyDb(), names)).toEqual(['전환율', '고객 획득 비용'])
  expect(candidates('기준 금리가 올랐습니다', emptyDb(), names)).toEqual(['금리'])
  expect(candidates('전환율', emptyDb())).toEqual([])
})

test('a name in Latin letters needs word edges; kana and Han names need none; width does not make a new term', () => {
  const names = ['tasa de conversión', 'ランダム化', '梯度下降']
  expect(candidates('La Tasa de conversión bajó. No es contasa de conversión.', emptyDb(), names)).toEqual(['tasa de conversión'])
  expect(candidates('完全ランダム化と梯度下降法を使う', emptyDb(), names)).toEqual(['ランダム化', '梯度下降'])
  expect(normalize('ＲＡＧ')).toBe('rag')
  expect(normalize('ｸﾗｳﾄﾞ')).toBe('クラウド')
})
