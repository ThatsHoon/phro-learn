import { expect, test } from 'claude-code/testing'

import type { Pending } from '../types'
import {
  addUsage,
  candidates,
  due,
  emptyDb,
  enqueue,
  formatUsage,
  initials,
  logCall,
  merge,
  migrate,
  normalize,
  parseReply,
  putBack,
  sameTerms,
  sentenceOf,
  visible,
} from './register'
import type { Parsed } from './register'

const NOW = '2026-11-13T00:00:00.000Z'
/** Candidates as the queue holds them, without a sentence. */
const ask = (...words: string[]): Pending[] => words.map(word => ({ word, key: normalize(word), context: '', seen: NOW }))
/** A reply line Haiku might give. */
const p = (term: string, rest: Partial<Parsed> = {}): Parsed => ({ picks: [], term, aliases: [], meaning: 'm', ...rest })

test('normalize folds case, spacing, punctuation and notes', async () => {
  expect(normalize('Hot reload')).toBe(normalize('hot-reload'))
  expect(normalize('API (Application Programming Interface)')).toBe('api')
  expect(normalize('CI/CD')).toBe('cicd')
})

test('candidates skip known terms, aliases, ignored and queued words', async () => {
  const db = merge(emptyDb(), ask('hot', 'reload', 'foo'), [p('Hot reload', { aliases: ['핫 리로드'] })]).db
  const text = '수정하면 `hot-reload` 로 반영되고 API 와 JSON 을 씁니다. foo 도 있음. 핫 리로드 는 빠름.'
  expect(candidates(text, db)).toEqual(['API', 'JSON'])
  expect(candidates(text, { ...db, pending: ask('JSON') })).toEqual(['API'])
  expect(candidates('짧은 답', db)).toEqual([])
})

test('parseReply keeps five-cell lines: numbers, term, kind, aliases, meaning', async () => {
  const reply = '1,3 | API | standard | Application Programming Interface;에이피아이 | 뜻\n-\nbad | line\n2 | X | weird |  | 뜻2\n | | concept | | z'
  expect(parseReply(reply)).toEqual([
    { picks: [1, 3], term: 'API', kind: 'standard', aliases: ['Application Programming Interface', '에이피아이'], meaning: '뜻' },
    { picks: [2], term: 'X', aliases: [], meaning: '뜻2' },
  ])
})

test('merge dedupes by key and alias, ignores unclaimed candidates', async () => {
  const first = merge(emptyDb(), ask('CI', 'xyz'), [p('CI', { picks: [1], aliases: ['Continuous Integration'] })])
  expect(first.added).toBe(1)
  expect(first.db.ignored).toEqual(['xyz'])

  const second = merge(first.db, ask('Continuous Integration'), [p('Continuous Integration', { picks: [1], meaning: 'm2' })])
  expect(second.added).toBe(0)
  expect(second.db.terms.length).toBe(1)
})

test('merge takes the example from the picked sentence, and every picked number counts as claimed', async () => {
  const asked = [{ ...ask('k8s')[0]!, context: 'k8s 로 서버를 늘립니다.' }, ...ask('Kubernetes', 'xyz')]
  const r = merge(emptyDb(), asked, [p('Kubernetes', { picks: [1, 2], kind: 'tool', meaning: '컨테이너를 여러 서버에 배치·관리하는 도구' })])
  const t = r.db.terms[0]!
  expect([t.key, t.example, t.kind, t.v]).toEqual(['kubernetes', 'k8s 로 서버를 늘립니다.', 'tool', 2])
  expect(r.db.ignored).toEqual(['xyz'])
  // no numbers in the reply: the candidate with the same name gives the sentence
  const named = merge(emptyDb(), [{ ...ask('RAG')[0]!, context: 'RAG 로 찾습니다.' }], [p('RAG(Retrieval-Augmented Generation)')])
  expect(named.db.terms[0]!.example).toBe('RAG 로 찾습니다.')
  expect(named.db.ignored).toEqual([])
})

test('a new term clears its other names from the queue', async () => {
  const queued = { ...emptyDb(), pending: ask('CI') }
  const r = merge(queued, ask('Continuous Integration'), [p('CI(Continuous Integration)', { picks: [1] })])
  expect(r.added).toBe(1)
  expect(r.db.pending).toEqual([])
})

test('answers queue their unseen candidates with the sentence; a full batch or a day-old one is due', async () => {
  const db = enqueue(emptyDb(), '이번엔 **RAG** 로 문서를 찾습니다. 그다음 API 를 부릅니다.', NOW)
  expect(db.pending.map(x => [x.word, x.context])).toEqual([
    ['RAG', '이번엔 RAG 로 문서를 찾습니다.'],
    ['API', '그다음 API 를 부릅니다.'],
  ])
  expect(enqueue(db, 'RAG 와 API 다시', NOW)).toBe(db)
  const t0 = Date.parse(NOW)
  expect(due(emptyDb(), t0)).toBe(false)
  expect(due(db, t0 + 1000)).toBe(false)
  expect(due(db, t0 + 24 * 3600 * 1000)).toBe(true)
  const full = { ...db, pending: Array.from({ length: 40 }, (_, i) => ({ ...db.pending[0]!, key: `k${i}` })) }
  expect(due(full, t0)).toBe(true)
})

test('a long sentence is cut around the word', async () => {
  const s = sentenceOf('가'.repeat(200) + ' LoRA ' + '나'.repeat(200), 'LoRA')
  expect(s.includes('LoRA') && s.startsWith('…') && s.endsWith('…') && s.length <= 122).toBe(true)
  expect(sentenceOf('- **LoRA** 는 작은 어댑터입니다.', 'LoRA')).toBe('LoRA 는 작은 어댑터입니다.')
})

test('a batch whose call failed goes back to the front, without duplicates', async () => {
  const db = enqueue(emptyDb(), 'RAG 와 API 와 GPU 를 씁니다', NOW)
  const batch = db.pending.slice(0, 2)
  expect(putBack({ ...db, pending: db.pending.slice(2) }, batch).pending.map(x => x.word)).toEqual(['RAG', 'API', 'GPU'])
  expect(putBack(db, batch).pending.length).toBe(3)
})

test('candidates skip code, URLs, paths, ids and identifier fragments', async () => {
  const text = [
    '커밋 27ea05f 와 a8b178c 를 https://github.com/ThatsHoon/phro 에 push 했고 CI/CD 와 OAuth 를 씁니다.',
    '`phro-demo-plugin` 와 hooks/register.tsx 수정, ThatsHoon/phro 저장소, --force 옵션.',
    '```bash',
    'claude plugin update phro-demo-plugin@phro',
    '```',
  ].join('\n')
  expect(candidates(text, emptyDb())).toEqual(['CI/CD', 'push', 'OAuth'])
})

test('usage adds up across calls, and the call log shows where the tokens went', async () => {
  const ok = { isAnswered: true, text: '', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } as const
  const u = addUsage(addUsage(undefined, ok as never), { ...ok, isAnswered: false, reason: 'empty-reply' } as never)
  expect([u.calls, u.failed, u.input, u.output]).toEqual([2, 1, 200, 40])
  expect(formatUsage(u)).toContain('avg 100 in / 20 out')
  const log = logCall(undefined, { ...ok, text: '-' } as never, 40, 0, NOW)
  expect(formatUsage(undefined, log, 7)).toContain('40 candidates, 0 kept, 100 input and 20 output tokens for a 1-character reply')
  expect(formatUsage(undefined, log, 7)).toContain('7 candidates waiting')
})

test('a reworded explanation or another name of a known term is no new term', async () => {
  const base = merge(emptyDb(), ask('API'), [p('API', { meaning: '프로그램끼리 대화하는 규약' })]).db
  const reworded = merge(base, ask('API'), [p('API', { meaning: '전혀 다른 설명' })])
  expect(reworded.added).toBe(0)
  expect(reworded.db.terms[0]!.meaning).toBe('프로그램끼리 대화하는 규약')

  const ci = merge(emptyDb(), ask('CI'), [p('CI')]).db
  expect(merge(ci, ask('x'), [p('Continuous Integration')]).added).toBe(0)
  expect(initials('Continuous Integration')).toBe('ci')
  expect(initials('API')).toBe(undefined)
})

test('an acronym written with its full name keeps the acronym as key and the full name as alias', async () => {
  const db = merge(emptyDb(), ask('WER'), [p('WER(Word Error Rate)')]).db
  expect(db.terms[0]!.key).toBe('wer')
  expect(db.terms[0]!.aliases).toEqual(['worderrorrate'])
  expect(initials('WER(Word Error Rate)')).toBe(undefined)
  expect(merge(db, ask('x'), [p('Word Error Rate')]).added).toBe(0)
  expect(candidates('WER 이 낮다', db)).toEqual([])
})

test('removed terms still count as known', async () => {
  const db = merge(emptyDb(), ask('CI'), [p('CI')]).db
  const removed = { ...db, terms: db.terms.map(t => ({ ...t, status: 'removed' as const })) }
  expect(merge(removed, ask('CI'), [p('ci', { meaning: 'm2' })]).added).toBe(0)
  expect(candidates('CI 를 씁니다', removed)).toEqual([])
})

test('migrate turns isDone into a status and adds an empty queue', async () => {
  const db = migrate({ terms: [
    { key: 'a', term: 'A', aliases: [], meaning: 'm', example: 'e', isDone: true } as never,
    { key: 'b', term: 'B', aliases: [], meaning: 'm', example: 'e', isDone: false } as never,
  ] })
  expect(db.terms.map(t => t.status)).toEqual(['done', 'todo'])
  expect('isDone' in db.terms[0]!).toBe(false)
  expect(db.pending).toEqual([])
})

test('a judgement that adds no term leaves the list as it was, so the pane is not redrawn', async () => {
  const db = merge(emptyDb(), ask('api'), [p('API(Application Programming Interface)')]).db
  const next = merge(db, ask('foo', 'bar'), []).db
  expect(next.ignored.length).toBe(db.ignored.length + 2)
  expect(sameTerms(next.terms, db.terms)).toBe(true)
  const more = merge(next, ask('ci'), [p('CI(Continuous Integration)')]).db
  expect(sameTerms(more.terms, next.terms)).toBe(false)
})

test('what Haiku is sent does not grow with the glossary', async () => {
  let db = emptyDb()
  for (let i = 0; i < 300; i++) db = merge(db, [], [p(`Term ${i} word`)]).db
  const words = Array.from({ length: 60 }, (_, i) => 'Q' + String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + Math.floor(i / 26)))
  expect(candidates('새 답변입니다 ' + words.join(' ') + ' 끝', db).length).toBe(40)
})

test('search matches term, meaning, example and other names; order sorts by time, abc or 가나다', async () => {
  const t = (term: string, aliases: string[], meaning: string) =>
    ({ key: normalize(term), term, aliases, meaning, example: 'e', status: 'todo' as const })
  // stored newest first
  const list = [
    t('WER(Word Error Rate)', ['worderrorrate', '단어오류율'], '음성 인식 오류 비율'),
    t('API(Application Programming Interface)', ['applicationprogramminginterface'], '프로그램끼리 부르는 약속'),
    t('Hot reload', ['핫리로드'], '고치면 바로 반영'),
    { ...t('CI', [], '자동 빌드'), status: 'done' as const },
  ]
  const names = (r: { term: string }[]) => r.map(x => x.term.split('(')[0])
  expect(names(visible(list, 'todo', '', 'time'))).toEqual(['WER', 'API', 'Hot reload'])
  expect(names(visible(list, 'todo', '', 'abc'))).toEqual(['API', 'Hot reload', 'WER'])
  expect(names(visible(list, 'todo', '', 'ganada'))).toEqual(['WER', 'Hot reload', 'API']) // 단어오류율, 핫리로드, 그 뒤 한글 이름 없는 API
  expect(names(visible(list, 'todo', 'error', 'time'))).toEqual(['WER'])
  expect(names(visible(list, 'todo', '핫 리로드', 'time'))).toEqual(['Hot reload'])
  expect(names(visible(list, 'todo', '반영', 'time'))).toEqual(['Hot reload'])
  expect(names(visible(list, 'todo', 'ci', 'time'))).toEqual([]) // other tab
  expect(names(visible(list, 'done', 'ci', 'time'))).toEqual(['CI'])
})

