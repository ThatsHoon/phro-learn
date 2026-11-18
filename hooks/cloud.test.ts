import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import type { Remote, Term } from '../types'
import {
  applyRemote, attachIds, batchKey, candidates, emptyDb, enqueue, isSecretLike, localOnly, maskKeys, migrate, normalize, putBack, SEND_WAIT_MS, upload, uploadAsk,
} from './register'

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
  const local: Term = { key: 'rag', term: 'RAG', aliases: ['retrievalaugmentedgeneration'], meaning: 'old', example: '', status: 'review' }
  let db = applyRemote({ ...emptyDb(), terms: [local] }, [
    remote('ut_1', 'RAG', { meaning: '검색으로 답을 보강', status: 'done', ver: 2 }),
    remote('ut_2', 'LoRA', { pending: true }),
    remote('ut_3', 'Kubernetes', { kind: 'tool', status: 'hidden' }),
  ])
  expect(db.terms.map(t => t.id)).toEqual(['ut_3', 'ut_1'])
  expect(db.terms[1]).toMatchObject({ meaning: '검색으로 답을 보강', aliases: ['retrievalaugmentedgeneration'], status: 'done', ver: 2 })
  expect(db.terms[0]).toMatchObject({ kind: 'tool', status: 'todo' })

  db = applyRemote(db, [remote('ut_1', 'RAG(Retrieval-Augmented Generation)', { status: 'removed' })])
  expect(db.terms).toHaveLength(2)
  expect(db.terms[1]).toMatchObject({ term: 'RAG(Retrieval-Augmented Generation)', status: 'removed' })
})

test('a local term met on the server keeps the further tab, and the server is told', () => {
  const local: Term = { key: 'rag', term: 'RAG', aliases: [], meaning: 'old', example: '', status: 'done' }
  const db = applyRemote({ ...emptyDb(), terms: [local] }, [remote('ut_1', 'RAG', { status: 'review', ver: 4 })])
  expect(db.terms[0]).toMatchObject({ id: 'ut_1', status: 'done', push: true, ver: 4 })
})

test('rows the service deleted come as gone and leave this PC; two rows of one term may stay until then', () => {
  let db = applyRemote(emptyDb(), [remote('ut_5', 'MLflow'), remote('ut_6', 'MLflow')])
  expect(db.terms).toHaveLength(2)
  db = applyRemote(db, [remote('ut_5', 'MLflow', { meaning: '실험 기록 도구' })], ['ut_6', 'ut_404'])
  expect(db.terms.map(t => [t.id, t.meaning])).toEqual([['ut_5', '실험 기록 도구']])
})

test('a tab change not yet sent is kept over what the server still has, with the number it was made from', () => {
  const mine: Term = { key: 'rag', term: 'RAG', aliases: [], meaning: 'm', example: '', status: 'done', id: 'ut_1', push: true, ver: 3 }
  let db = applyRemote({ ...emptyDb(), terms: [mine] }, [remote('ut_1', 'RAG', { status: 'review', ver: 5 })])
  expect(db.terms[0]).toMatchObject({ meaning: '뜻', example: '예시', status: 'done', push: true, ver: 3 })
  // the server came to the same tab: nothing left to tell
  db = applyRemote(db, [remote('ut_1', 'RAG', { status: 'done', ver: 6 })])
  expect(db.terms[0]!.push).toBeUndefined()
  expect(db.terms[0]!.ver).toBe(6)
})

test('upload: learned first, then review, then to learn, newest first, through the send filters, up to the room left', () => {
  const t = (term: string, status: Term['status'], rest: Partial<Term> = {}): Term => ({ key: normalize(term), term, aliases: [], meaning: 'm', example: '', status, ...rest })
  const db = {
    ...emptyDb(),
    account: 'a1',
    cloud: { server: 's', room: 3 },
    terms: [
      t('MLflow', 'todo'), t('LoRA', 'review'), t('RAG', 'done'), t('Atlas', 'done'), t('me@corp.com', 'done'),
      t('BERT', 'done', { id: 'ut_1' }), t('CUDA', 'removed'), t('beam search', 'review'),
    ],
  }
  const r = upload(db, NOW, w => normalize(w) === 'atlas')
  expect(r.db.pending.map(p => [p.word, p.up])).toEqual([['RAG', true], ['LoRA', true], ['beam search', true]])
  expect(r.db.uploadAsked).toBe('a1')
  expect(uploadAsk(r.db)).toBe(0)
  expect(localOnly(r.db).map(x => x.term)).toEqual(['MLflow', 'Atlas', 'me@corp.com'])
  // an upload sent but not answered goes back to the queue although its term is here
  expect(putBack({ ...r.db, pending: [] }, r.db.pending).pending).toHaveLength(3)
  expect(uploadAsk({ ...db, uploadAsked: 'a0' })).toBe(6)
})

test('ingest ids tie local terms to their rows; a row still being judged waits to be told the tab', async () => {
  const db = attachIds(
    { ...emptyDb(), terms: [{ key: 'rag', term: 'RAG', aliases: [], meaning: 'm', example: '', status: 'done' }, { key: 'lora', term: 'LoRA', aliases: [], meaning: 'm', example: '', status: 'todo' }] },
    [{ k: 'rag', id: 'ut_1', pending: true }, { k: 'lora', id: 'ut_2' }, { k: 'mlflow', id: 'ut_3', pending: true }],
  )
  expect(db.terms).toMatchObject([{ id: 'ut_1', pending: true, push: true }, { id: 'ut_2' }])
  expect(db.terms[1]!.push).toBeUndefined()
  // judged: the row comes through sync and the tab chosen here goes out from its number
  const next = applyRemote(db, [remote('ut_1', 'RAG', { ver: 0 })])
  expect(next.terms[0]).toMatchObject({ status: 'done', push: true, ver: 0 })
  expect(next.terms[0]!.pending).toBeUndefined()
  // the same batch sent again carries the same key
  const batch = [{ word: 'RAG', key: 'rag', context: '', seen: NOW }]
  expect(await batchKey(batch)).toBe(await batchKey([...batch]))
  expect(await batchKey(batch)).not.toBe(await batchKey([{ ...batch[0]!, seen: '2026-11-16T00:00:00.000Z' }]))
})

test('review comes from the server; a removal made here stays, as it is never sent', () => {
  const gone: Term = { key: 'rag', term: 'RAG', aliases: [], meaning: 'm', example: '', status: 'removed', id: 'ut_1' }
  const db = applyRemote({ ...emptyDb(), terms: [gone] }, [remote('ut_1', 'RAG', { status: 'done' }), remote('ut_2', 'LoRA', { status: 'review' })])
  expect(db.terms.map(t => [t.id, t.status])).toEqual([['ut_2', 'review'], ['ut_1', 'removed']])
})

test('the connection survives a reload of terms.json', () => {
  expect(migrate({ cloud: { server: 'http://localhost:8000', plan: 'free' } }).cloud?.plan).toBe('free')
  expect(migrate({}).cloud).toBeUndefined()
  expect(migrate({ account: 'a1', uploadAsked: 'a1' })).toMatchObject({ account: 'a1', uploadAsked: 'a1' })
})

type Sent = { url: string; body: any; auth?: string; idem?: string }
type Route = (path: string, body: any) => { status: number; data: unknown } | undefined

/** A stand-in for the engine around the plugin and for the service: device connection, then `route` answers the rest. */
function service(on: Parameters<TestBody>[1], route: Route, files = new Map<string, string>()) {
  const sent: Sent[] = []
  // the engine hands the hooks an absolute path of this machine ("C:\home\..." on Windows)
  const at = (path: string) => path.replace(/^[A-Za-z]:/, '').replaceAll('\\', '/')
  on('command.register', () => ({ value: { command: 'phro-learn' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/w' }) as never)
  on('turn.complete', () => ({ text: '' }) as never)
  on('ui.toast', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home' : undefined }))
  on('fs.stat', (_, e) => {
    if (!files.has(at(e.path))) throw new Error('ENOENT')
    return { value: { mtimeMs: files.get(at(e.path))!.length, size: 1, isFile: true, isDirectory: false } } as never
  })
  on('fs.read', (_, e) => {
    if (!files.has(at(e.path))) throw new Error('ENOENT')
    return { value: files.get(at(e.path))! }
  })
  on('fs.write', (_, e) => {
    files.set(at(e.path), e.text)
    return { value: undefined }
  })
  on('http.fetch', (_, e) => {
    const path = e.url.replace('http://localhost:8000/v1', '')
    const body = e.init?.body ? JSON.parse(e.init.body as string) : undefined
    const headers = (e.init?.headers ?? {}) as Record<string, string>
    sent.push({ url: path, body, auth: headers.Authorization, idem: headers['Idempotency-Key'] })
    const reply = (status: number, data: unknown) => ({ value: { status, ok: status < 300, headers: {}, text: JSON.stringify(data) } })
    if (path === '/auth/device/code') return reply(200, { device_code: 'dc', user_code: 'KQ7M-XR2P', verification_uri: 'http://localhost:8000/settings', expires_in: 600, interval: 5 })
    if (path === '/auth/device/token') return reply(200, { access_token: 'at', refresh_token: 'rt', expires_in: 900 })
    const r = route(path, body)
    return r ? reply(r.status, r.data) : reply(200, { items: [], next: 'c1', gone: [] })
  })
  return { sent, files, db: () => JSON.parse(files.get('/home/.claude/phro-learning/terms.json')!) }
}

test('several PCs: the whole glossary first, deleted rows dropped, an older view loses, another account starts clean', async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  on('model.complete', () => {
    throw new Error('no model in cloud mode')
  })
  let account = 'acc-1'
  let page: Remote[] = [remote('ut_1', 'RAG', { status: 'review', ver: 4 }), remote('ut_2', 'Kubernetes', { kind: 'tool' })]
  let gone: string[] = []
  const local = (term: string, status: Term['status'], id?: string): Term => ({ key: normalize(term), term, aliases: [], meaning: 'm', example: '', status, ...(id ? { id } : {}) })
  const files = new Map([['/home/.claude/phro-learning/terms.json', JSON.stringify({
    version: 1, ignored: [], pending: [],
    // RAG and LoRA were judged here before connecting; ut_9 is a row the service deleted before it kept a record
    terms: [local('RAG', 'done'), local('LoRA', 'review'), local('Old', 'todo', 'ut_9')],
  })]])
  const { sent, db } = service(on, (path, body) => {
    if (path === '/client/bootstrap') return { status: 200, data: { account, plan: 'free', used: 498, limits: { cloud_terms: 500 }, blur: null, locale: 'ko', names: { etag: 'h-1' } } }
    if (path === '/client/names') return { status: 200, data: { etag: 'h-1', lang: 'ko', items: [], strings: {} } }
    if (path === '/me/terms') return { status: 200, data: { items: page, next: 'c1', gone: [] } }
    if (path === '/me/terms?cursor=c1') return { status: 200, data: { items: [], next: 'c1', gone } }
    // the web moved RAG to review again since this PC last looked
    if (path === '/me/terms/ut_1') return { status: 409, data: { type: 'conflict', current: 'review', ver: 6, body } }
    return undefined
  }, files)

  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'phro-learn', args: 'login http://localhost:8000' })
  await clock.advance(5000)
  // the first sync took the whole glossary, kept the further tab of RAG, and dropped the row the service no longer has
  expect(db().account).toBe('acc-1')
  expect(db().terms.map((t: Term) => [t.term, t.id, t.status])).toEqual([['Kubernetes', 'ut_2', 'todo'], ['RAG', 'ut_1', 'done'], ['LoRA', undefined, 'review']])
  expect(db().terms[1]).toMatchObject({ push: true, ver: 4 })
  expect(db().cloud.room).toBe(2)
  expect(uploadAsk(db())).toBe(1)

  // RAG's tab goes out from number 4; the web changed it since, so the web's tab stands here too
  page = []
  await $.command.run({ command: 'phro-learn', args: 'sync' })
  expect(sent.filter(s => s.url === '/me/terms/ut_1').map(s => s.body)).toEqual([{ status: 'done', ver: 4 }])
  expect(db().terms[1]).toMatchObject({ status: 'review', ver: 6 })
  expect(db().terms[1].push).toBeUndefined()

  // a row the service deleted since the last sync leaves this PC
  gone = ['ut_2']
  await $.command.run({ command: 'phro-learn', args: 'sync' })
  expect(db().terms.map((t: Term) => t.term)).toEqual(['RAG', 'LoRA'])

  // the language is set on the account once; the default leaves it alone
  expect(sent.some(s => s.url === '/me/profile')).toBe(false)

  // another account on this PC: the first account's rows go, local terms and the upload question stay for the new one
  await $.command.run({ command: 'phro-learn', args: 'logout' })
  expect(db().account).toBe('acc-1')
  account = 'acc-2'
  gone = []
  await $.command.run({ command: 'phro-learn', args: 'login http://localhost:8000' })
  await clock.advance(5000)
  expect(db().account).toBe('acc-2')
  expect(db().terms.map((t: Term) => t.term)).toEqual(['LoRA'])
  expect(uploadAsk(db())).toBe(1)
})

test('login connects, and from then on candidates go to the service and no model is called', { options: { language: 'ja' } }, async ($, on) => {
  mock.store(on)
  const clock = mock.clock(on)
  const files = new Map<string, string>()
  const sent: Sent[] = []
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
    if (path === '/auth/device/code') return reply(200, { device_code: 'dc', user_code: 'KQ7M-XR2P', verification_uri: 'http://localhost:8000/settings', expires_in: 600, interval: 5 })
    if (path === '/auth/device/token') return reply(200, { access_token: 'at', refresh_token: 'rt', expires_in: 900 })
    if (path === '/me/profile') return reply(200, { locale: (account = body.locale) })
    if (path === '/client/bootstrap') return reply(200, { plan: 'free', blur: { unlock_left: null }, ingest: true, locale: account, names: { etag: 'h-1' } })
    if (path === '/client/names') return reply(200, { etag: 'h-1', lang: 'ko', items: ['전환율', '귀무가설'], strings: {} })
    if (path === '/ingest') {
      // a word the service already explained comes back at once; a new one is judged within the time it gives
      const known = body.items.filter((i: { t: string }) => i.t === '전환율').map((i: { t: string }) => ({ k: normalize(i.t), id: 'ut_2' }))
      return reply(200, { known, queued: body.items.length - known.length, retry_after_ms: 0, ready_in_ms: 100_000 })
    }
    if (path === '/me/terms') return reply(200, { items: [remote('ut_1', 'RAG')], next: 'c1' })
    return reply(200, { items: [], next: 'c1' })
  })

  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  const out = await $.command.run({ command: 'phro-learn', args: 'login http://localhost:8000' })
  expect(JSON.stringify(out)).toContain('KQ7M-XR2P')
  await clock.advance(5000)

  await $.turn.complete({ reason: 'answer', answer: '이 구조는 LoRA 와 beam search 를 씁니다. 경로는 src/secret/file.ts 입니다.' } as never)
  await clock.advance(20000)
  expect(sent.some(s => s.url === '/ingest')).toBe(false) // two words wait for more, or for two minutes
  await clock.advance(SEND_WAIT_MS)
  const ingest = sent.find(s => s.url === '/ingest')
  expect(ingest?.auth).toBe('Bearer at')
  expect(ingest?.body.items.map((i: { t: string }) => i.t)).toEqual(['LoRA', 'beam search'])
  expect(JSON.stringify(ingest?.body)).not.toContain('secret')
  expect(models).toBe(0)
  // new words: no fetch right after the send, one when the service said they would be judged
  const fetchedAfter = () => sent.slice(sent.indexOf(ingest!)).some(s => s.url.startsWith('/me/terms'))
  expect(fetchedAfter()).toBe(false)
  await clock.advance(100_000)
  expect(fetchedAfter()).toBe(true)

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
  await clock.advance(SEND_WAIT_MS + 20000)
  expect(sent.find(s => s.url === '/ingest')?.body.items.map((i: { t: string }) => i.t)).toEqual(['전환율'])
  // a term the service already had: fetched on the same round as the send
  const i = sent.findIndex(s => s.url === '/ingest')
  expect(sent.slice(i, i + 3).map(s => s.url.split('?')[0])).toEqual(['/ingest', '/client/bootstrap', '/me/terms'])
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
  expect(normalize('Straße')).toBe(normalize('STRASSE'))
  expect(normalize('サーバー')).toBe('サーバ')
  expect(normalize('ユーザー・インターフェース')).toBe('ユーザインターフェース')
  expect(normalize('データベース')).toBe('データベース')
})

test('a file written under the old key rule takes the new keys and still knows the old ones', () => {
  const db = migrate({
    terms: [{ key: 'サーバー', term: 'サーバー', aliases: ['straße'], meaning: '', example: '', status: 'todo' }],
    ignored: ['コンピューター'],
    pending: [{ word: 'Straße', key: 'straße', context: '', seen: NOW }],
  })
  expect(db.terms[0]).toMatchObject({ key: 'サーバ', aliases: ['straße', 'サーバー', 'strasse'] })
  expect(db.ignored).toEqual(['コンピューター', 'コンピュータ'])
  expect(db.pending[0]!.key).toBe('strasse')
  expect(migrate(db)).toEqual(db)
})
