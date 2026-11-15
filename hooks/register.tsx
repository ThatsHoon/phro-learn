import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteResult, Register } from 'claude-code'

import type { Auth, CallLog, Cloud, Kind, Order, Pending, Remote, Status, Term, TermsDb, Usage } from '../types'

const PANE = 'phro-learn'
const terms = atom({ plugin: 'phro-learn', key: 'terms' } as const, [])
const tab = atom({ plugin: 'phro-learn', key: 'tab' } as const, 'todo')
const query = atom({ plugin: 'phro-learn', key: 'query' } as const, '')
const order = atom({ plugin: 'phro-learn', key: 'order' } as const, 'time')
const limit = atom({ plugin: 'phro-learn', key: 'limit' } as const, 30)
// The desktop app reloads plugins about hourly and on every install; an unload drops the pane
// without telling this plugin. Kept in session state, which outlives the reload, so the fresh copy reopens it.
const isOpen = atom({ plugin: 'phro-learn', key: 'isOpen' } as const, false)

// the data folder keeps the plugin's old name (before 0.15) so existing terms are still found
const DB_PATH = '.claude/phro-learning/terms.json'
// The file is the one source of truth shared by every session; each polls its mtime.
const POLL_MS = 3000
const MAX_CANDIDATES = 40
// Candidates are queued and judged 40 at a time. Until 0.10 each answer was judged alone:
// ~3 candidates per call, and 96% of the input was this prompt sent again (1,598 calls measured).
const BATCH = MAX_CANDIDATES
const MAX_WAIT_MS = 24 * 60 * 60 * 1000
const MAX_PENDING = 200
const MAX_NEW = 15
// leaves room for the model's own thinking, which output_tokens counts; a cut reply would ignore good terms
const MAX_REPLY_TOKENS = 4000
const MAX_IGNORED = 5000
const MAX_SCAN_BATCHES = 5
const MAX_LOG = 200
const CONTEXT_CHARS = 120
// stamped on each new term as `v`, so terms from different prompts can be told apart when judging quality
const PROMPT_VERSION = 2
// Rows drawn at once. Every redraw rebuilds the whole tree; with 164 removed terms a burst of
// tab presses queued redraws of ~650 elements each and the pane stopped answering.
const PAGE = 30

// Cloud mode (0.12): connected to the phrolearn.com service, this plugin calls no model. It sends
// candidate words only and receives the glossary back. Never the answer text,
// a sentence, a path, the project's name or the session.
const CLIENT_VERSION = '0.13.0'
// ponytail: the local development server; becomes the service's address once it is hosted
const DEFAULT_SERVER = 'http://localhost:8000'
// One session per PC (the lead) talks to the server, so several open sessions cost one session's requests
// and never spend the same refresh token twice. Others only queue candidates and read terms.json.
const TICK_MS = 20_000
const LEAD_MS = 90_000
const SYNC_MS = 5 * 60_000
const MAX_RETRY_MS = 5 * 60_000

const STOPWORDS = new Set(
  'the and or of to in on for is are be it this that with as at by from an a if not no yes ok vs etc e g i e via per'.split(' '),
)

const KINDS: readonly Kind[] = ['concept', 'method', 'metric', 'model', 'tool', 'standard', 'org']

// The text a member reads. Korean is built in: it is what local mode shows, and what a connected PC shows
// until its first sync. Connected, the service sends the member's language with the catalog names
// (GET /client/names) and that replaces this table.
const KO: Record<string, string> = {
  kind_concept: "개념",
  kind_method: "기법",
  kind_metric: "지표",
  kind_model: "모델",
  kind_tool: "도구",
  kind_standard: "표준",
  kind_org: "조직",
  judged: "📘 후보 {asked}개 판정, 용어 {added}개 추가",
  nothing_to_judge: "판정할 후보가 없습니다.",
  open_on_web: "웹에서 열기",
  disconnected: "phro-learn: 연결이 끊겼습니다. /phro-learn login 으로 다시 연결하세요.",
  full: "용어집이 가득 찼습니다 (요금제 한도). 새 후보는 이 PC에만 쌓입니다.",
  update_needed: "phro-learn 업데이트가 필요합니다: claude plugin update phro-learn@phro",
  code_expired: "phro-learn: 연결 코드가 만료됐습니다. /phro-learn login 을 다시 실행하세요.",
  connect_failed: "phro-learn: 연결하지 못했습니다. 다시 시도하세요.",
  connected: "📘 phro-learn 연결됨 — 이제 용어 판정은 서비스가 합니다.",
  code: "phro-learn 연결 코드: {code}",
  file_error: "phro-learn: {path} 를 읽거나 쓰지 못했습니다 ({err})",
  order_time: "시간순(최신 먼저)",
  order_abc: "abc순",
  order_local: "가나다순",
  tab_todo: "배울 용어",
  tab_done: "보관",
  tab_removed: "제거",
  empty_todo: "아직 용어가 없습니다. /phro-learn scan 으로 이 세션을 훑어보세요.",
  empty_done: "보관한 용어가 없습니다.",
  empty_removed: "제거한 용어가 없습니다. 제거한 용어는 다시 추가되지 않습니다.",
  added: "📘 용어 {n}개 추가 — /phro-learn",
  search: "검색",
  search_ph: "용어, 뜻, 예시, 현지 이름",
  find: "찾기",
  sort: "정렬",
  clear_search: "검색 지우기",
  connecting: "연결 중",
  unlock_left: "오늘 열기 {n}개 남음",
  sending: "전송 대기 {n}개",
  judge_waiting: "판정 대기 {n}개 (40개가 차거나 하루가 지나면 판정)",
  judge_now: "지금 판정",
  results: "\"{q}\" 검색 결과 {n}개",
  no_match: "검색과 맞는 용어가 없습니다.",
  restore: "복원",
  remove: "제거",
  eg: "예)",
  more: "더 보기 ({n}개 남음)",
}
let strings = KO
let lang = 'ko'
// the language chosen when the plugin was installed (userConfig); 'account' leaves the account's language as it is
let wantLang = 'account'
const tr = (key: string, vars: Record<string, unknown> = {}): string =>
  (strings[key] ?? KO[key] ?? key).replace(/\{(\w+)\}/g, (_, n: string) => String(vars[n] ?? ''))

// Haiku sees only numbered unknown candidates, never the answer text or the known list.
// Pipe lines instead of JSON: fewer output tokens, and one bad line costs one term.
// The example is the answer sentence the term came from, kept locally, so Haiku writes none.
const SYSTEM = `You curate a glossary of AI and IT knowledge for a learner who works with engineers.
Input: numbered candidate words taken from an AI coding assistant's answers, one per line.
Rules:
- Keep terms worth learning across AI and IT: AI/ML concepts and methods (e.g. LoRA, RAG, quantization, beam search), metrics, model types, data and infra, networking, security, dev-process jargon, protocols and standards, and widely used technologies, frameworks and services (e.g. Kubernetes, MLflow, CUDA).
- Drop names that only matter inside one project (its repos, files, variables, functions, internal model or run names), CLI commands and subcommands (e.g. "plugin update", "marketplace add"), generic English words, numbers.
- Use only the given candidates; never add terms that are not among them.
- Merge candidates that name the same thing (e.g. "hot", "reload" -> "Hot reload"; "CI" + "Continuous Integration") into one term and list all their numbers.
- At most ${MAX_NEW} terms. Output nothing else.
- Write an acronym or abbreviation with its English full name in parentheses, no space: "WER(Word Error Rate)", "bf16(Brain Floating Point 16)". A term already spelled out ("Hot reload") stays as is.
Format, one term per line:
numbers | term | kind | aliases | meaning
- numbers: the candidate numbers the term covers, comma-separated, e.g. 3,7
- kind: one of ${KINDS.join(', ')}
- aliases: separated by ; - the full name, the Korean name Korean engineers use (e.g. 양자화), spelling variants; may be empty
- meaning: Korean, at most 50 characters: what it is and what it is for, in words a non-engineer understands. Never define a term by its own name or full name.
If none qualify, output a single line: -`

/** The dedup key: case, spaces, punctuation and a parenthesized note never make a term new. */
export function normalize(s: string): string {
  return s
    .normalize('NFKC') // full-width and half-width forms are one term
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')
    .replace(/[\s\-_./·:'"`]/g, '')
}

export function emptyDb(): TermsDb {
  return { version: 1, terms: [], ignored: [], pending: [] }
}

/** Every key already known: terms in any tab, their other names, ignored and queued candidates. */
function seenKeys(db: TermsDb): Set<string> {
  const seen = new Set(db.ignored)
  for (const p of db.pending) seen.add(p.key)
  for (const t of db.terms) {
    seen.add(t.key)
    for (const a of t.aliases) seen.add(a)
    const short = initials(t.term) // terms saved before initials became aliases
    if (short) seen.add(short)
  }
  return seen
}

/** Prose only: code, inline code, URLs and paths name things, they do not explain them. */
export function prose(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\]\([^)]*\)/g, '] ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
    // paths: two or more separators, or one plus a file extension ("CI/CD" stays)
    .replace(/(?:[\w.~:-]*[\\/]){2,}[\w.-]*|[\w.-]+[\\/][\w-]*\.\w+/g, ' ')
}

// Lookarounds keep a token whole: one glued to a word character, slash, @, $, dash or
// a ".ext" is part of an identifier (repo/name, --flag, file.ts, 27ea05f) and is skipped.
const ACRONYM = /(?<![\w/@$.-])[A-Z][A-Z0-9]{1,5}(?:\/[A-Z]{1,5})?(?=s?(?![\w/@(]|\.\w))/g
const ENGLISH_RUN = /(?<![\w/@$.-])[A-Za-z][A-Za-z0-9+#]*(?:[ -][A-Za-z][A-Za-z0-9+#]*){0,2}(?![\w/@(]|\.\w)/g

/** A commit hash or similar id: hex only, with a digit. */
function isIdLike(word: string): boolean {
  return /\d/.test(word) && /^[0-9a-f]{5,}$/i.test(word)
}

/**
 * True when the name stands in the text as a word. A Latin name needs a word edge on both sides, case ignored.
 * A Hangul name must not follow a Hangul syllable (there it is the tail of another word). Kana and Han
 * have no word edges, so being in the text is enough.
 */
function hasName(body: string, name: string): boolean {
  const isLatin = /^[\u0000-\u024f]/.test(name)
  const hay = isLatin ? body.toLowerCase() : body
  const needle = isLatin ? name.toLowerCase() : name
  const inWord = isLatin ? /[\p{L}\p{N}]/u : /[가-힣]/
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    if (!inWord.test(hay[at - 1] ?? '') && !(isLatin && inWord.test(hay[at + needle.length] ?? ''))) return true
  }
  return false
}

// ponytail: regex candidates catch acronyms, and English runs inside Korean, Japanese or Chinese prose. A concept
// written in the member's own language (멱등성, tasa de conversión) is caught only when its name is in `names`,
// the names the service sends; a name not on that list is missed — add a noun pass per
// language if that matters
export function candidates(text: string, db: TermsDb, names: readonly string[] = []): string[] {
  const body = prose(text)
  const found = [...body.matchAll(ACRONYM)].map(m => m[0])
  const local = (body.match(/[가-힣ぁ-ヿ一-鿿]/g) ?? []).length
  if (local > body.length * 0.15) found.push(...[...body.matchAll(ENGLISH_RUN)].map(m => m[0]))
  // ponytail: one scan of the answer per name; build one matcher for the list when it passes tens of thousands
  found.push(...names.filter(name => hasName(body, name)))

  const seen = seenKeys(db)
  const out: string[] = []
  for (const raw of found) {
    const word = raw.trim()
    const key = normalize(word)
    if (key.length < 2 || key.length > 40 || /^\d+$/.test(key) || isIdLike(word)) continue
    if (STOPWORDS.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push(word)
    if (out.length === MAX_CANDIDATES) break
  }
  return out
}

/** The prose sentence a word was used in, markdown marks dropped, cut around the word when long. */
export function sentenceOf(body: string, word: string): string {
  const line = body.split(/\n+|(?<=[.!?。])\s+/).find(x => x.includes(word)) ?? ''
  const s = line.replace(/^[\s#>*|\-\d.]+/, '').replace(/\*\*|__|\|/g, ' ').replace(/\s+/g, ' ').trim()
  if (s.length <= CONTEXT_CHARS) return s
  const at = Math.max(0, Math.min(s.indexOf(word) - Math.floor((CONTEXT_CHARS - word.length) / 2), s.length - CONTEXT_CHARS))
  return (at > 0 ? '…' : '') + s.slice(at, at + CONTEXT_CHARS).trim() + (at + CONTEXT_CHARS < s.length ? '…' : '')
}

/** Queues an answer's unseen candidates with the sentence each came from; the sentence never leaves terms.json. */
export function enqueue(db: TermsDb, text: string, now: string, skip?: (word: string) => boolean, names?: readonly string[]): TermsDb {
  const room = MAX_PENDING - db.pending.length
  if (room <= 0) return db
  const body = prose(text)
  const fresh = candidates(text, db, names)
    .filter(word => !skip?.(word))
    .slice(0, room)
    .map((word): Pending => ({ word, key: normalize(word), context: sentenceOf(body, word), seen: now }))
  return fresh.length ? { ...db, pending: [...db.pending, ...fresh] } : db
}

/** A full batch is waiting, or the oldest candidate has waited a day. */
export function due(db: TermsDb, nowMs: number): boolean {
  const oldest = db.pending[0]
  return db.pending.length >= BATCH || (oldest !== undefined && nowMs - Date.parse(oldest.seen) >= MAX_WAIT_MS)
}

/** A batch that was claimed but not judged goes back to the front of the queue. */
export function putBack(db: TermsDb, batch: readonly Pending[]): TermsDb {
  const known = seenKeys(db)
  return { ...db, pending: [...batch.filter(p => !known.has(p.key)), ...db.pending] }
}

export type Parsed = { picks: number[]; term: string; kind?: Kind; aliases: string[]; meaning: string }

/** Lines of "numbers | term | kind | aliases | meaning"; anything else is skipped. */
export function parseReply(text: string): Parsed[] {
  const out: Parsed[] = []
  for (const line of text.split('\n')) {
    const cells = line.split('|').map(c => c.trim())
    if (cells.length !== 5) continue
    const [nums, term, kind, aliases, meaning] = cells as [string, string, string, string, string]
    if (!term || !meaning) continue
    out.push({
      picks: (nums.match(/\d+/g) ?? []).map(Number),
      term,
      ...((KINDS as readonly string[]).includes(kind) ? { kind: kind as Kind } : {}),
      aliases: aliases.split(';').map(a => a.trim()).filter(Boolean),
      meaning,
    })
  }
  return out
}

/** "Continuous Integration" -> "ci": lets an acronym and its spelled-out form meet. */
// ponytail: initials can collide (Hot reload vs HR); fine for a glossary, drop if it misfires
export function initials(term: string): string | undefined {
  // "WER(Word Error Rate)": the name is WER; its full name becomes an alias in merge()
  const words = term.replace(/\([^)]*\)/g, ' ').split(/[\s-]+/).filter(w => /^[A-Za-z]/.test(w))
  return words.length >= 2 && words.length <= 6 ? words.map(w => w[0]!.toLowerCase()).join('') : undefined
}

/**
 * Adds the new terms and ignores every asked candidate no term claimed. A term is new only when
 * none of its names (key, aliases, initials) is already known in any tab, removed included;
 * the meaning Haiku wrote never matters, so a reworded explanation is no new term.
 * The example is the sentence the first picked candidate came from.
 */
export function merge(db: TermsDb, asked: readonly Pending[], parsed: readonly Parsed[]): { db: TermsDb; added: number } {
  const seen = seenKeys({ ...db, pending: [] })
  const fresh: Term[] = []
  const claimed = new Set<string>()
  for (const p of parsed) {
    const key = normalize(p.term)
    const spelled = [...p.term.matchAll(/\(([^)]*)\)/g)].map(m => normalize(m[1]!)) // "WER(Word Error Rate)" -> worderrorrate
    const names = [...p.aliases.map(normalize), ...spelled, initials(p.term) ?? '']
    const aliases = [...new Set(names)].filter(a => a && a !== key)
    const byNumber = p.picks.map(n => asked[n - 1]).filter((a): a is Pending => a !== undefined)
    const picked = byNumber.length ? byNumber : asked.filter(a => a.key === key || aliases.includes(a.key))
    for (const k of [key, ...aliases, ...picked.map(a => a.key)]) claimed.add(k)
    if (!key || [key, ...aliases].some(k => seen.has(k))) continue
    for (const k of [key, ...aliases]) seen.add(k)
    const example = picked.find(a => a.context)?.context ?? ''
    fresh.push({ key, term: p.term, aliases, meaning: p.meaning, example, status: 'todo', ...(p.kind ? { kind: p.kind } : {}), v: PROMPT_VERSION })
  }
  const words = (s: string) => s.toLowerCase().split(/[ -]/).map(normalize)
  const claimedWords = new Set(parsed.flatMap(p => words(p.term)))
  const rejected = asked.map(a => a.key).filter(k => !claimed.has(k) && !claimedWords.has(k) && !seen.has(k))
  const known = new Set([...seen, ...claimed, ...rejected])
  return {
    db: {
      version: 1,
      terms: [...fresh, ...db.terms],
      ignored: [...db.ignored, ...rejected].slice(-MAX_IGNORED),
      pending: db.pending.filter(p => !known.has(p.key)),
    },
    added: fresh.length,
  }
}

export function addUsage(total: Usage | undefined, r: ModelCompleteResult): Usage {
  const t = total ?? { calls: 0, failed: 0, input: 0, output: 0, since: new Date().toISOString().slice(0, 10) }
  return {
    ...t,
    calls: t.calls + 1,
    failed: t.failed + (r.isAnswered ? 0 : 1),
    input: t.input + r.usage.input_tokens + r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens,
    output: t.output + r.usage.output_tokens,
  }
}

/** Appends one answered call: output tokens next to reply characters show how much went to thinking. */
export function logCall(log: readonly CallLog[] | undefined, r: ModelCompleteResult, asked: number, kept: number, at: string): CallLog[] {
  const input = r.usage.input_tokens + r.usage.cache_read_input_tokens + r.usage.cache_creation_input_tokens
  return [...(log ?? []), { at, asked, kept, input, output: r.usage.output_tokens, chars: r.isAnswered ? r.text.length : 0 }].slice(-MAX_LOG)
}

export function formatUsage(u: Usage | undefined, log: readonly CallLog[] = [], waiting = 0): string {
  const per = (n: number) => Math.round(n / Math.max(1, u?.calls ?? 1))
  const parts = [
    u
      ? `Since ${u.since}: ${u.calls} Haiku calls (${u.failed} failed), ` +
        `${u.input} input + ${u.output} output tokens (avg ${per(u.input)} in / ${per(u.output)} out per call).`
      : 'No Haiku calls yet.',
  ]
  if (log.length) {
    const avg = (f: (c: CallLog) => number) => Math.round(log.reduce((s, c) => s + f(c), 0) / log.length)
    parts.push(
      `Last ${log.length} judging calls, per call: ${avg(c => c.asked)} candidates, ${avg(c => c.kept)} kept, ` +
        `${avg(c => c.input)} input and ${avg(c => c.output)} output tokens for a ${avg(c => c.chars)}-character reply.`,
    )
  }
  if (waiting) parts.push(`${waiting} candidates waiting to be judged.`)
  return parts.join(' ')
}

async function dbPath($: EngineInterface): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (!home) throw new Error('neither USERPROFILE nor HOME is set')
  return `${home}/${DB_PATH}`
}

/** Older files carried `isDone` instead of `status`, and no queue. */
type StoredTerm = Omit<Term, 'status'> & { status?: Status; isDone?: boolean }

export function migrate(raw: { terms?: StoredTerm[]; ignored?: string[]; pending?: Pending[]; cloud?: Cloud }): TermsDb {
  const terms = (raw.terms ?? []).map(({ isDone, status, ...t }): Term => ({
    ...t,
    status: status ?? (isDone ? 'done' : 'todo'),
  }))
  return { version: 1, terms, ignored: raw.ignored ?? [], pending: raw.pending ?? [], ...(raw.cloud ? { cloud: raw.cloud } : {}) }
}

const isFile = ($: EngineInterface, path: string) =>
  $.fs.stat(path).then(
    () => true,
    () => false,
  )

// Candidates queued as this session last read or wrote the file; the pane shows it on its next redraw.
let waiting = 0
// The connection as the file last had it: the pane's head line in cloud mode.
let cloudInfo: Cloud | undefined

async function load($: EngineInterface): Promise<TermsDb> {
  const path = await dbPath($)
  // a corrupt file throws here, so nothing below ever overwrites it with an empty list
  const db = (await isFile($, path)) ? migrate(JSON.parse(await $.fs.read(path))) : emptyDb()
  waiting = db.pending.length
  cloudInfo = db.cloud
  return db
}

// mtime of the file as this session last read or wrote it; another session's write moves it
let lastMtime = -1

async function mtime($: EngineInterface): Promise<number> {
  return $.fs.stat(await dbPath($)).then(
    s => s.mtimeMs,
    () => 0,
  )
}

/** Same terms in the same order: then a redraw would change nothing on screen. */
export function sameTerms(a: readonly Term[], b: readonly Term[]): boolean {
  return a.length === b.length && JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Redraws the pane only when the list changed. Every redraw hands the surface new button
 * handles, so a press already on its way lands on a dead handle ("ui_press not handled").
 * Most file writes change only `ignored` or `pending`, and every session polls the file,
 * so redrawing on each write voided presses all day.
 */
async function show($: EngineInterface, list: Term[]) {
  if (!sameTerms(await read($, terms), list)) await update($, terms, () => list)
}

async function save($: EngineInterface, db: TermsDb) {
  await $.fs.write(await dbPath($), JSON.stringify(db, null, 1) + '\n')
  waiting = db.pending.length
  cloudInfo = db.cloud
  lastMtime = await mtime($)
  await show($, db.terms)
}

// One read-modify-write at a time within this session.
// ponytail: in-process queue; two sessions writing at once can still race in the ms between
// load and write (the Haiku call is outside that window) — a file lock if that ever bites
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => undefined)
  return run
}

/** Picks up what another session wrote: the pane redraws when the file's terms changed. */
function refresh($: EngineInterface): Promise<void> {
  return serial(async () => {
    const now = await mtime($)
    if (now === lastMtime) return
    lastMtime = now // set first: a corrupt file is reported once per change, not every poll
    await show($, (await load($)).terms)
  })
}

/** Queues the unseen candidates of an answer; returns how many were queued. No model call. */
function collect($: EngineInterface, text: string): Promise<number> {
  return serial(async () => {
    const mask = (await auth($)) ? await masks($) : undefined
    if (mask?.isOff) return 0
    const db = await load($)
    const next = enqueue(db, text, new Date().toISOString(), mask && (w => isSecretLike(w) || mask.keys.has(normalize(w))),
      mask && (await catalogNames($)))
    if (next === db) return 0
    await save($, next)
    return next.pending.length - db.pending.length
  })
}

/**
 * Judges one claimed batch. It left the file before the call, so another session cannot judge
 * it too, and goes back when the call fails. A reply in neither shape judges nothing and ignores
 * nothing: those words are queued again when an answer uses them.
 */
async function judgeBatch($: EngineInterface, batch: Pending[]): Promise<number> {
  let r: ModelCompleteResult
  try {
    r = await $.model.complete({
      model: 'haiku',
      system: SYSTEM,
      prompt: batch.map((p, i) => `${i + 1}. ${p.word}`).join('\n'),
      maxTokens: MAX_REPLY_TOKENS,
      effort: 'low',
      timeoutMs: 60000,
    })
  } catch (err) {
    await serial(async () => save($, putBack(await load($), batch)))
    throw err
  }
  const parsed = r.isAnswered ? parseReply(r.text) : []
  const added = await serial(async () => {
    const db = await load($)
    if (!r.isAnswered) await save($, putBack(db, batch))
    if (!r.isAnswered || (parsed.length === 0 && r.text.trim() !== '-')) return 0
    const m = merge(db, batch, parsed)
    await save($, m.db)
    return m.added
  })
  await serial(async () => {
    await $.store.set('usage', addUsage((await $.store.get('usage')) as Usage | undefined, r))
    if (r.isAnswered) {
      await $.store.set('calls', logCall((await $.store.get('calls')) as CallLog[] | undefined, r, batch.length, added, new Date().toISOString()))
    }
  })
  return added
}

// One judging run at a time in this session; other sessions are kept off by the claim in the file.
let judging = false

/** Judges the queue when it is due, or everything waiting when `all` (a scan or a press). */
async function judge($: EngineInterface, all = false): Promise<{ asked: number; added: number }> {
  // the one gate that keeps cloud mode at zero model calls: every judging path comes through here
  if (judging || (await auth($))) return { asked: 0, added: 0 }
  judging = true
  let asked = 0
  let added = 0
  try {
    for (let i = 0; i < MAX_SCAN_BATCHES; i++) {
      const batch = await serial(async () => {
        const db = await load($)
        if (!(all ? db.pending.length > 0 : due(db, Date.now()))) return []
        await save($, { ...db, pending: db.pending.slice(BATCH) })
        return db.pending.slice(0, BATCH)
      })
      if (batch.length === 0) break
      asked += batch.length
      added += await judgeBatch($, batch)
    }
  } finally {
    judging = false
  }
  return { asked, added }
}

function judgeNow($: EngineInterface): Promise<void> {
  return judge($, true)
    .then(r => $.ui.toast(r.asked ? tr('judged', r) : tr('nothing_to_judge')))
    .then(() => $.ui.invalidate('ui.render'))
    .catch(err => reportFailure($, err))
}

/** Moves one term to a tab; idempotent, so a press on a stale row never flips it back. */
function setStatus($: EngineInterface, key: string, status: Status): Promise<void> {
  return serial(async () => {
    const db = await load($)
    // a term the server knows is marked, and the lead session tells the server on its next tick
    await save($, { ...db, terms: db.terms.map(t => (t.key === key ? { ...t, status, ...(t.id && db.cloud ? { push: true } : {}) } : t)) })
  })
}

// ---------- cloud mode ----------

const auth = async ($: EngineInterface) => (await $.store.get('auth')) as Auth | undefined

/** A key or token, not a word: known prefixes, or a long string too random to be a name (a long plain word such as "Electroencephalography" has no digit and no capital inside). */
// An e-mail, an IP, a phone or an id number never becomes a candidate: one starts with a letter and holds no @ or dot.
export function isSecretLike(word: string): boolean {
  if (/^(sk-|AKIA|gh[pousr]_|xox[abprs]-)/.test(word)) return true
  return word.split(/[ -]/).some(w => {
    if (w.length < 20 || !/\d|.[A-Z]/.test(w)) return false
    const counts = new Map<string, number>()
    for (const c of w) counts.set(c, (counts.get(c) ?? 0) + 1)
    let bits = 0
    for (const n of counts.values()) bits -= (n / w.length) * Math.log2(n / w.length)
    return bits >= 3.5
  })
}

/** The session's own names, never sent: the folder path's parts, the git remote's owner and repository, the package name, .termboardignore lines. */
export function maskKeys(cwd: string, gitConfig: string, packageJson: string, pyproject: string, ignore: string): { keys: Set<string>; isOff: boolean } {
  const names = cwd.split(/[\\/]/)
  for (const m of gitConfig.matchAll(/url\s*=\s*(\S+)/g)) names.push(...m[1]!.replace(/\.git$/, '').split(/[/:@]/).slice(-2))
  try {
    names.push(...String(JSON.parse(packageJson).name ?? '').split('/'))
  } catch {
    // no package.json, or not JSON: it names nothing
  }
  names.push(/^name\s*=\s*["']([^"']+)["']/m.exec(pyproject)?.[1] ?? '')
  const lines = ignore.split('\n').map(l => l.trim()).filter(Boolean)
  return { keys: new Set([...names, ...lines].map(normalize).filter(k => k.length >= 2)), isOff: lines.includes('*') }
}

let maskCache: Promise<{ keys: Set<string>; isOff: boolean }> | undefined
function masks($: EngineInterface) {
  return (maskCache ??= (async () => {
    const cwd = await $.session.cwd()
    const file = (name: string) => $.fs.read(`${cwd}/${name}`).catch(() => '')
    return maskKeys(cwd, await file('.git/config'), await file('package.json'), await file('pyproject.toml'), await file('.termboardignore'))
  })())
}

const STATUSES: readonly string[] = ['todo', 'done', 'removed']

/** Puts the server's terms into the local copy: by id, else over a local term of the same key. Terms still being judged are skipped. */
export function applyRemote(db: TermsDb, items: readonly Remote[]): TermsDb {
  let terms = db.terms
  for (const r of items) {
    if (r.pending) continue
    let at = terms.findIndex(t => t.id === r.id)
    if (at < 0) at = terms.findIndex(t => !t.id && t.key === r.key)
    const old = terms[at]
    const term: Term = {
      key: r.key,
      term: r.term,
      aliases: old?.aliases ?? [],
      meaning: r.meaning,
      example: r.example,
      // a tab change not yet sent wins over what the server still has
      status: old?.push ? old.status : STATUSES.includes(r.status) ? (r.status as Status) : (old?.status ?? 'todo'),
      ...((KINDS as readonly string[]).includes(r.kind ?? '') ? { kind: r.kind as Kind } : {}),
      id: r.id,
      ...(old?.push ? { push: true } : {}),
    }
    terms = at < 0 ? [term, ...terms] : terms.map((t, i) => (i === at ? term : t))
  }
  return { ...db, terms }
}

type Reply = { status: number; data: Record<string, any> }

async function call($: EngineInterface, server: string, method: string, path: string, body?: unknown, token?: string): Promise<Reply> {
  const r = await $.http.fetch(`${server}/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Client-Version': CLIENT_VERSION, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  let data = {}
  try {
    data = JSON.parse(r.text)
  } catch {
    // a 304 or a proxy's error page has no JSON; the status says enough
  }
  return { status: r.status, data }
}

// The access token lives 15 minutes and only in memory.
let access: { token: string; until: number } | undefined

/** A request as this PC's connection; a rejected access token is renewed once. Undefined when signed out. */
async function authed($: EngineInterface, method: string, path: string, body?: unknown): Promise<Reply | undefined> {
  for (const isFirst of [true, false]) {
    const a = await auth($)
    if (!a?.refresh) return undefined
    if (!access || access.until < Date.now()) {
      const r = await call($, a.server, 'POST', '/auth/refresh', { refresh_token: a.refresh })
      if (r.status === 401) {
        // the queue stays; the member logs in again
        await $.store.set('auth', { ...a, refresh: '' })
        $.ui.toast(tr('disconnected'))
        return undefined
      }
      if (r.status !== 200) return r
      await $.store.set('auth', { ...a, refresh: r.data.refresh_token })
      access = { token: r.data.access_token, until: Date.now() + (r.data.expires_in - 60) * 1000 }
    }
    const r = await call($, a.server, method, path, body, access.token)
    if (r.status !== 401 || !isFirst) return r
    access = undefined
  }
  return undefined
}

// The catalog's names in the member's language, with the plugin's text in that language. The lead session
// fetches them when bootstrap names a new version (a new catalog term, or the member changed language);
// every session reads them from the store, again after an hour so what the lead fetched reaches them.
type Names = { etag: string; lang: string; items: string[]; strings: Record<string, string> }
const NAMES_MS = 60 * 60_000
let catalog: { items: string[]; at: number } | undefined

function useNames(n: Names | undefined): string[] {
  catalog = { items: n?.items ?? [], at: Date.now() }
  if (n?.strings) strings = n.strings
  if (n?.lang) lang = n.lang
  return catalog.items
}

async function catalogNames($: EngineInterface): Promise<string[]> {
  if (catalog && Date.now() - catalog.at <= NAMES_MS) return catalog.items
  return useNames((await $.store.get('names')) as Names | undefined)
}

async function syncNames($: EngineInterface, etag: unknown): Promise<void> {
  if (typeof etag !== 'string' || ((await $.store.get('names')) as Names | undefined)?.etag === etag) return
  const r = await authed($, 'GET', '/client/names')
  if (r?.status !== 200 || !Array.isArray(r.data.items)) return
  const text = Object.entries((r.data.strings ?? {}) as Record<string, unknown>).filter((x): x is [string, string] => typeof x[1] === 'string')
  const names: Names = {
    etag: String(r.data.etag ?? etag),
    lang: typeof r.data.lang === 'string' ? r.data.lang : 'ko',
    items: (r.data.items as unknown[]).filter((x): x is string => typeof x === 'string'),
    strings: Object.fromEntries(text),
  }
  await $.store.set('names', names)
  useNames(names)
}

const ME = Math.random().toString(36).slice(2)

/** True when this session is the one that talks to the server; takes the role when nobody holds it, or when asked by hand. */
async function isLead($: EngineInterface, isForced = false): Promise<boolean> {
  const lead = (await $.store.get('lead')) as { id: string; until: number } | undefined
  if (!isForced && lead && lead.id !== ME && lead.until > Date.now()) return false
  await $.store.set('lead', { id: ME, until: Date.now() + LEAD_MS })
  return true
}

let fails = 0
let retryAt = 0
// ticks left on which to fetch the glossary soon after a send
let syncSoon = 0
let lastSync = 0

/** Sends one batch of waiting candidates. It leaves the file first, so no session sends it twice, and goes back when the send fails. */
// ponytail: no Idempotency-Key; a resend after a lost reply only counts a sighting twice
async function flush($: EngineInterface): Promise<void> {
  if (Date.now() < retryAt) return
  const batch = await serial(async () => {
    const db = await load($)
    if (!db.cloud || db.cloud.notice || db.pending.length === 0) return []
    await save($, { ...db, pending: db.pending.slice(BATCH) })
    return db.pending.slice(0, BATCH)
  })
  if (batch.length === 0) return
  const hold = (notice?: string) =>
    serial(async () => {
      const db = putBack(await load($), batch)
      await save($, notice && db.cloud ? { ...db, cloud: { ...db.cloud, notice } } : db)
    })
  let r: Reply | undefined
  try {
    r = await authed($, 'POST', '/ingest', { at: new Date().toISOString(), lang, items: batch.map(p => ({ t: p.word, n: 1 })) })
  } catch (err) {
    await hold()
    retryAt = Date.now() + Math.min(MAX_RETRY_MS, 1000 * 2 ** fails++)
    throw err
  }
  if (r?.status === 200) {
    fails = 0
    // sent words are never sent again; the glossary comes back through sync
    await serial(async () => {
      const db = await load($)
      await save($, { ...db, ignored: [...db.ignored, ...batch.map(p => p.key)].slice(-MAX_IGNORED) })
    })
    syncSoon = 3
    return
  }
  if (r?.status === 403 && r.data.type === 'plan_limit') return hold(tr('full'))
  if (r?.status === 426) return hold(tr('update_needed'))
  await hold()
  if (r) retryAt = Date.now() + Math.max(Number(r.data.retry_after_ms) || 0, Math.min(MAX_RETRY_MS, 1000 * 2 ** fails++))
}

/** Tells the server the tab changes made here. */
async function pushStatus($: EngineInterface): Promise<void> {
  const dirty = (await serial(() => load($))).terms.filter(t => t.push && t.id)
  for (const t of dirty) {
    const r = await authed($, 'PATCH', `/me/terms/${t.id}`, { status: t.status })
    // 404: the term is gone on the server; nothing left to tell
    if (r?.status !== 200 && r?.status !== 404) return
    await serial(async () => {
      const db = await load($)
      // a tab changed again meanwhile keeps its mark and goes out on the next round
      await save($, { ...db, terms: db.terms.map(x => (x.id === t.id && x.status === t.status ? (({ push, ...rest }) => rest)(x) : x)) })
    })
  }
}

/** Fetches the plan and the glossary changes since the last sync; returns how many terms changed, or undefined when it could not. */
async function sync($: EngineInterface): Promise<number | undefined> {
  let boot = await authed($, 'GET', '/client/bootstrap')
  if (boot?.status !== 200) return undefined
  // the account follows the language set here
  if (wantLang !== 'account' && boot.data.locale !== wantLang) {
    const set = await authed($, 'PATCH', '/me/profile', { locale: wantLang })
    if (set?.status === 200) boot = (await authed($, 'GET', '/client/bootstrap')) ?? boot
    if (boot.status !== 200) return undefined
  }
  await syncNames($, boot.data.names?.etag)
  let changed = 0
  for (let page = 0; page < 20; page++) {
    const cursor = (await serial(() => load($))).cloud?.cursor
    const r = await authed($, 'GET', `/me/terms${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
    if (r?.status !== 200) break
    const items = (r.data.items ?? []) as Remote[]
    await serial(async () => {
      const db = await load($)
      if (!db.cloud) return
      const cloud: Cloud = { server: db.cloud.server, plan: boot.data.plan, at: new Date().toISOString(), ...(r.data.next ? { cursor: r.data.next } : {}) }
      if (typeof boot.data.blur?.unlock_left === 'number') cloud.unlockLeft = boot.data.blur.unlock_left // absent: no daily cap
      await save($, { ...applyRemote(db, items), cloud })
    })
    changed += items.filter(t => !t.pending).length
    if (items.length === 0) break
  }
  lastSync = Date.now()
  return changed
}

let isTicking = false
/** The lead session's round: send what waits, tell tab changes, fetch the glossary when due. */
async function tick($: EngineInterface, isForced = false): Promise<number | undefined> {
  if (isTicking || !(await auth($))?.refresh) return undefined
  await catalogNames($) // every connected session, lead or not, shows the member's language
  if (!(await isLead($, isForced))) return undefined
  isTicking = true
  try {
    await flush($)
    await pushStatus($)
    if (!isForced && syncSoon <= 0 && !((await read($, isOpen)) && Date.now() - lastSync >= SYNC_MS)) return undefined
    syncSoon--
    const changed = await sync($)
    if (changed) $.ui.invalidate('ui.render')
    return changed
  } finally {
    isTicking = false
  }
}

/** Starts the device connection: shows the code to enter on the web, then asks the server until the member approves. */
async function login($: EngineInterface, server: string): Promise<string> {
  if (!/^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(server)) return 'The server address must be https (http only for localhost).'
  const name = (await $.env.get('COMPUTERNAME')) ?? (await $.env.get('HOSTNAME')) ?? 'Claude Code'
  const r = await call($, server, 'POST', '/auth/device/code', { device_name: name.slice(0, 80), client_version: CLIENT_VERSION })
  if (r.status !== 200) return `Could not reach ${server} (${r.status}).`
  const wait = Math.max(1, Number(r.data.interval) || 5) * 1000
  const ask = (left: number): void => {
    if (left <= 0) return void $.ui.toast(tr('code_expired'))
    $.clock.after(wait, () => {
      call($, server, 'POST', '/auth/device/token', { device_code: r.data.device_code })
        .then(async t => {
          if (t.status !== 200) {
            if (t.data.type === 'authorization_pending' || t.data.type === 'slow_down') return ask(left - wait)
            return void $.ui.toast(tr('connect_failed'))
          }
          await $.store.set('auth', { server, refresh: t.data.refresh_token })
          access = { token: t.data.access_token, until: Date.now() + (t.data.expires_in - 60) * 1000 }
          await serial(async () => save($, { ...(await load($)), cloud: { server } }))
          $.ui.toast(tr('connected'))
          await tick($, true)
        })
        .catch(() => ask(left - wait)) // offline for a moment: keep asking until the code expires
    })
  }
  ask((Number(r.data.expires_in) || 600) * 1000)
  $.ui.toast(tr('code', { code: r.data.user_code }))
  return `Open ${r.data.verification_uri} and enter the code ${r.data.user_code} (valid ${Math.round((Number(r.data.expires_in) || 600) / 60)} minutes).`
}

/** Ends the connection: the server drops this PC's tokens, the queue is emptied, and judging goes back to this PC. */
async function logout($: EngineInterface): Promise<string> {
  if (!(await auth($))) return 'Not connected.'
  await isLead($, true)
  await authed($, 'POST', '/auth/logout', {}).catch(() => undefined) // offline: the token still ends here, and expires there
  await $.store.delete('auth')
  access = undefined
  await serial(async () => {
    const { cloud, ...db } = await load($)
    await save($, { ...db, pending: [] })
  })
  return 'Disconnected. phro-learn judges on this PC again (local mode).'
}

async function status($: EngineInterface): Promise<string> {
  const a = await auth($)
  const db = await serial(() => load($))
  if (!a) return `Local mode: terms are judged on this PC with Haiku. ${db.pending.length} candidates waiting. "/phro-learn login" connects to the service.`
  if (!a.refresh) return `Cloud mode, signed out of ${a.server}: run "/phro-learn login". ${db.pending.length} candidates kept.`
  const c = db.cloud
  return (
    `Cloud mode: ${a.server}, plan ${c?.plan ?? 'unknown'}, ${db.pending.length} candidates waiting to be sent, ` +
    `last sync ${c?.at ?? 'never'}.${c?.notice ? ` On hold: ${c.notice}` : ''} No model calls are made on this PC.`
  )
}

function reportFailure($: EngineInterface, err: unknown) {
  $.ui.toast(tr('file_error', { path: DB_PATH, err: String(err).slice(0, 120) }))
}

// "ganada" is the stored name of the order by local name; its label follows the member's language
const ORDERS: { value: Order; label: string }[] = [
  { value: 'time', label: 'order_time' },
  { value: 'abc', label: 'order_abc' },
  { value: 'ganada', label: 'order_local' },
]

// ponytail: "local" = written outside the Latin script (Hangul, kana, Han). For a member whose language is
// written in Latin letters the local order is the abc order by that language's rules
const LOCAL = /[^\u0000-\u024f]/
const en = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

/** The name in the member's own script given as an alias ("핫리로드"), else the term itself. */
function localName(t: Term): string {
  return t.aliases.find(a => LOCAL.test(a)) ?? t.term
}

/**
 * The rows a tab shows: those matching the search (term, its other names, meaning or example,
 * case and spacing ignored), in the chosen order. Terms are stored newest first, so "time"
 * keeps the stored order. "abc" puts Latin names first, "ganada" names in the member's own script first.
 */
export function visible(list: readonly Term[], status: Status, q: string, by: Order): Term[] {
  const needle = q.trim().toLowerCase()
  const key = normalize(q)
  const hit = (t: Term) =>
    !needle ||
    [t.term, t.meaning, t.example].some(s => s.toLowerCase().includes(needle)) ||
    (key !== '' && [t.key, ...t.aliases].some(a => a.includes(key)))
  const rows = list.filter(t => t.status === status && hit(t))
  if (by === 'time') return rows
  const name = by === 'abc' ? (t: Term) => t.term : localName
  const first = (s: string) => (LOCAL.test(s[0] ?? '') === (by === 'ganada') ? 0 : 1)
  const cmp = by === 'abc' ? en : new Intl.Collator(lang, { sensitivity: 'base', numeric: true })
  return rows.sort((a, b) => first(name(a)) - first(name(b)) || cmp.compare(name(a), name(b)))
}

/** The text an Input handler got: the value itself, or an event carrying it. */
const text = (v: unknown): string =>
  typeof v === 'string' ? v : typeof (v as { value?: unknown })?.value === 'string' ? (v as { value: string }).value : ''

const TABS: { status: Status; label: string; empty: string }[] = [
  { status: 'todo', label: 'tab_todo', empty: 'empty_todo' },
  { status: 'done', label: 'tab_done', empty: 'empty_done' },
  { status: 'removed', label: 'tab_removed', empty: 'empty_removed' },
]

// The engine may replace this module's copy mid-session (the hooks worker was lost): the
// fresh copy keeps no timers, and the pane on screen still holds the dead copy's button
// handles, so every press is "ui_press not handled" and a reopened pane can stay at
// "Nothing to show yet". The first hook in a fresh copy restarts the poll and redraws.
let isLive = false
function revive($: EngineInterface) {
  if (isLive) return
  isLive = true
  $.clock.every(POLL_MS, () => {
    refresh($).catch(err => reportFailure($, err))
  })
  $.clock.every(TICK_MS, () => {
    tick($).catch(() => undefined) // offline or the server is down: flush() set the next try
  })
  // a connected PC draws in the member's language from the start, not from the first tick
  tick($).catch(() => undefined)
  $.ui.invalidate('ui.render')
}

export const register: Register = (on, options) => {
  if (typeof options?.language === 'string') wantLang = options.language
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'phro-learn',
      description:
        'Open the AI/IT term board ("scan" queues and judges this session\'s terms, "judge" judges the waiting candidates now, ' +
        '"stats" shows Haiku token use, ' +
        '"login" connects to the phrolearn.com service so it judges instead of Haiku, "logout", "status", "sync")',
      argumentHint: '[scan|judge|stats|login|logout|status|sync]',
    })
    await refresh($).catch(err => reportFailure($, err))
    revive($)
    if (await read($, isOpen)) void $.ui.open({ id: PANE, title: 'phro-learn' })
    return next(e)
  })

  // Heard only for a close by hand or by a plugin; an unload skips the opener's hooks.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) await update($, isOpen, () => false)
    return next(e)
  }).catch(($, e, next) => next(e)) // a failed write never keeps the pane from closing

  on('command.run', { command: 'phro-learn' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'stats') {
      const db = await serial(() => load($))
      return { text: formatUsage((await $.store.get('usage')) as Usage | undefined, ((await $.store.get('calls')) ?? []) as CallLog[], db.pending.length) }
    }
    if (arg === 'login' || arg.startsWith('login ')) return { text: await login($, (arg.slice(5).trim() || DEFAULT_SERVER).replace(/\/+$/, '')) }
    if (arg === 'logout') return { text: await logout($) }
    if (arg === 'status') return { text: await status($) }
    if (arg === 'sync') {
      if (!(await auth($))?.refresh) return { text: 'Not connected. Run "/phro-learn login".' }
      const changed = await tick($, true)
      return { text: changed === undefined ? 'Could not sync now.' : `Synced: ${changed} terms changed.` }
    }
    if (arg === 'judge') {
      const r = await judge($, true)
      return { text: r.asked ? `Judged ${r.asked} candidates: ${r.added} new terms.` : 'No candidates waiting.' }
    }

    revive($)
    await $.ui.open({ id: PANE, title: 'phro-learn' })
    await update($, isOpen, () => true)
    $.ui.invalidate('ui.render') // an already open pane draws again with live handles
    if (arg !== 'scan') return { text: 'Term board opened.' }

    const answers = (await $.session.messages())
      .filter(m => m.role === 'assistant' && m.text)
      .map(m => m.text)
      .join('\n\n')
    let queued = 0
    for (let i = 0; i < MAX_SCAN_BATCHES; i++) {
      const n = await collect($, answers) // each pass queues the next unseen 40
      if (n === 0) break
      queued += n
    }
    if (await auth($)) {
      await tick($, true)
      return { text: `Scanned this session: ${queued} candidates queued for the service.` }
    }
    const r = await judge($, true)
    return { text: `Scanned this session: ${queued} candidates queued, ${r.asked} judged, ${r.added} new terms.` }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    revive($)
    if (e.agentId === undefined && e.reason === 'answer' && e.answer) {
      const answer = e.answer
      $.clock.after(0, () => {
        collect($, answer)
          .then(() => judge($))
          .then(r => (r.added > 0 ? $.ui.toast(tr('added', { n: r.added })) : undefined))
          .catch(err => reportFailure($, err))
      })
    }
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text, Input, Select, Link } = $.ui.resolve(e)
    const list = await read($, terms)
    const current = await read($, tab)
    const q = await read($, query)
    const by = await read($, order)
    const shown = visible(list, current, q, by)
    const max = await read($, limit)
    // A press that changes nothing writes nothing, so repeated presses queue no redraws.
    // A new tab, search or order starts again from the first page.
    const fresh = (write: () => Promise<unknown>) => update($, limit, () => PAGE).then(write)
    const search = (v: unknown) => (text(v) === q ? undefined : fresh(() => update($, query, () => text(v))))
    const move = (key: string, status: Status) => () => setStatus($, key, status).catch(err => reportFailure($, err))

    return (
      <Box flexDirection="column">
        <Box>
          {TABS.map(t => (
            <Button
              key={`tab-${t.status}`}
              label={`${tr(t.label)} (${list.filter(x => x.status === t.status).length})`}
              variant={t.status === current ? 'primary' : 'secondary'}
              onPress={() => (t.status === current ? undefined : fresh(() => update($, tab, () => t.status)))}
            />
          ))}
        </Box>
        <Box>
          <Input key="search" label={tr('search')} placeholder={tr('search_ph')} value={q} submitLabel={tr('find')} onInput={search} onSubmit={search} />
          <Select key="order" label={tr('sort')} options={ORDERS.map(o => ({ value: o.value, label: tr(o.label) }))} value={by} onSelect={(v: unknown) => {
            const o = ORDERS.find(x => x.value === text(v))?.value ?? 'time'
            return o === by ? undefined : fresh(() => update($, order, () => o))
          }} />
          {q && <Button key="clear" label={tr('clear_search')} onPress={() => fresh(() => update($, query, () => ''))} />}
        </Box>
        {cloudInfo && (
          <Box>
            <Text dimColor>
              [{cloudInfo.plan ?? tr('connecting')}]{cloudInfo.unlockLeft === undefined ? '' : ` ${tr('unlock_left', { n: cloudInfo.unlockLeft })}`}
              {waiting > 0 ? ` · ${tr('sending', { n: waiting })}` : ''}{' '}
            </Text>
            <Link key="web" href={cloudInfo.server} label={tr('open_on_web')} />
          </Box>
        )}
        {cloudInfo?.notice && <Text dimColor>{cloudInfo.notice}</Text>}
        {waiting > 0 && !cloudInfo && (
          <Box>
            <Text dimColor>{tr('judge_waiting', { n: waiting })} </Text>
            <Button key="judge" label={tr('judge_now')} onPress={() => judgeNow($)} />
          </Box>
        )}
        {q && <Text dimColor>{tr('results', { q, n: shown.length })}</Text>}
        {shown.length === 0 && <Text dimColor>{tr(q ? 'no_match' : TABS.find(t => t.status === current)!.empty)}</Text>}
        {shown.slice(0, max).map(t => (
          <Box key={`row-${t.key}`} flexDirection="column" marginTop={1}>
            <Box>
              {current === 'removed' ? (
                <Text bold>✕ {t.term} </Text>
              ) : (
                <Button key={`check-${t.key}`} plain onPress={move(t.key, current === 'todo' ? 'done' : 'todo')}>
                  {current === 'done' ? '☑ ' : '☐ '}
                  <Text bold>{t.term}</Text>
                </Button>
              )}
              {t.kind && <Text dimColor> {tr(`kind_${t.kind}`)} </Text>}
              {current === 'removed' ? (
                <Button key={`restore-${t.key}`} label={tr('restore')} onPress={move(t.key, 'todo')} />
              ) : (
                <Button key={`remove-${t.key}`} label={tr('remove')} onPress={move(t.key, 'removed')} />
              )}
            </Box>
            <Text>  {t.meaning}</Text>
            {t.example && <Text dimColor>  {tr('eg')} {t.example}</Text>}
          </Box>
        ))}
        {shown.length > max && (
          <Button key="more" label={tr('more', { n: shown.length - max })} onPress={() => update($, limit, () => max + PAGE)} />
        )}
      </Box>
    )
  })
}
