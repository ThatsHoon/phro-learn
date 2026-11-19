import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteResult, Register } from 'claude-code'

import { TEXT } from './text'
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
const PROMPT_VERSION = 3
// Rows drawn at once. Every redraw rebuilds the whole tree; with 164 removed terms a burst of
// tab presses queued redraws of ~650 elements each and the pane stopped answering.
const PAGE = 30

// Cloud mode (0.12): connected to the workphro service, this plugin calls no model. It sends
// candidate words only and receives the glossary back. Never the answer text,
// a sentence, a path, the project's name or the session.
// The server turns away a client older than its minimum, so this is the manifest's own version, read once.
let clientVersion: Promise<string> | undefined
const version = ($: EngineInterface) => clientVersion ??=
  $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`).then(s => String(JSON.parse(s).version), () => '0')
// the hosted service
const DEFAULT_SERVER = 'https://work.phro.net'
// One session per PC (the lead) talks to the server, so several open sessions cost one session's requests
// and never spend the same refresh token twice. Others only queue candidates and read terms.json.
const TICK_MS = 20_000
const LEAD_MS = 90_000
const SYNC_MS = 5 * 60_000
// connected: candidates go out once this many wait or the oldest has waited this long, not on every answer
export const SEND_MIN = 10
export const SEND_WAIT_MS = 2 * 60_000
const MAX_RETRY_MS = 5 * 60_000

const STOPWORDS = new Set(
  'the and or of to in on for is are be it this that with as at by from an a if not no yes ok vs etc e g i e via per'.split(' '),
)

const KINDS: readonly Kind[] = ['concept', 'method', 'metric', 'model', 'tool', 'standard', 'org']

// The text a member reads, built in for every language the service has (text.ts is written from the service's
// language files). Local mode shows the language chosen at install; a connected PC shows it until its first sync,
// then the service sends the member's language with the catalog names (GET /client/names) and that replaces it.
let strings = TEXT.en!.strings
let lang = 'en'
// the language chosen when the plugin was installed (userConfig); 'account' leaves the account's language as it is
let wantLang = 'account'
// the project option: off keeps the session folder's name on this PC
let sendProject = true

/** The language local mode uses: the one chosen at install, else the system's when built in, else English. */
export function localLang(want: string, system = Intl.DateTimeFormat().resolvedOptions().locale): string {
  if (TEXT[want]) return want
  const sys = system.split('-')[0]!.toLowerCase()
  return TEXT[sys] ? sys : 'en'
}

/** Local mode's text: at load, and again at logout so the service's language does not linger. */
function useLocal(): void {
  lang = localLang(wantLang)
  strings = TEXT[lang]!.strings
}

const tr = (key: string, vars: Record<string, unknown> = {}): string =>
  (strings[key] ?? TEXT[lang]?.strings[key] ?? TEXT.en!.strings[key] ?? key).replace(/\{(\w+)\}/g, (_, n: string) => String(vars[n] ?? ''))

// Haiku sees only numbered unknown candidates, never the answer text or the known list.
// Pipe lines instead of JSON: fewer output tokens, and one bad line costs one term.
// The example is the answer sentence the term came from, kept locally, so Haiku writes none.
// The aliases and the meaning are written in the language local mode shows (localLang).
// ponytail: 50 characters is the Korean and Japanese length; other languages get 100, as their words are longer
export const system = (code: string): string => {
  const language = TEXT[code]?.language ?? 'English'
  const chars = code === 'ko' || code === 'ja' ? 50 : 100
  return `You curate a glossary of AI and IT knowledge for a learner who works with engineers.
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
- aliases: separated by ; - the full name, the ${language} name ${language}-speaking engineers use when it differs from the term, spelling variants; may be empty
- meaning: ${language}, at most ${chars} characters: what it is and what it is for, in words a non-engineer understands. Never define a term by its own name or full name.
If none qualify, output a single line: -`
}

/** The dedup key: case, spaces, punctuation, a parenthesized note, ß/ss and a word-final ー never make a term new. */
export function normalize(s: string): string {
  return s
    .normalize('NFKC') // full-width and half-width forms are one term
    .toLowerCase()
    .replaceAll('ß', 'ss')
    .replace(/\([^)]*\)/g, '')
    .replace(/ー+(?=[\s\-_./·・:'"`]|$)/g, '') // サーバー and サーバ are one word
    .replace(/[\s\-_./·・:'"`]/g, '')
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
// A name with a capital inside (LoRA, PyTorch, OAuth, MLflow): in any language's prose it is a name, not a plain word.
const MIXED_CASE = /(?<![\w/@$.-])(?=[A-Za-z0-9+#]*(?:[a-z][A-Z]|[A-Z]{2}[a-z]))[A-Za-z][A-Za-z0-9+#]*(?![\w/@(]|\.\w)/g
// What the answer itself marks in bold (**tasa de conversión**), up to four words; a bold label ("**Note:**") is not one.
const BOLD = /\*\*([^*\n]{2,40}?)\*\*(?!:)/g
const isBoldName = (s: string) => !/[:.!?。,]$/.test(s.trim()) && s.trim().split(/\s+/).length <= 4

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

// ponytail: regex candidates catch acronyms and mixed-case names in any language, every English run inside Korean,
// Japanese or Chinese prose, and bold words in other prose. A plain word in Latin-script prose (quantization, tasa de conversión)
// is caught only when it is bold or in `names`, the names the service sends; others are missed — add a noun pass
// per language if that matters
export function candidates(text: string, db: TermsDb, names: readonly string[] = []): string[] {
  const seen = seenKeys(db)
  const out: string[] = []
  for (const raw of words(prose(text), names)) {
    const word = raw.trim()
    const key = normalize(word)
    if (!isTermKey(word, key) || seen.has(key)) continue
    seen.add(key)
    out.push(word)
    if (out.length === MAX_CANDIDATES) break
  }
  return out
}

/** A word that can be a term: not too short or long, not a number, an id or a stopword. */
const isTermKey = (word: string, key: string) =>
  key.length >= 2 && key.length <= 40 && !/^\d+$/.test(key) && !isIdLike(word) && !STOPWORDS.has(key)

/** Every candidate-shaped word in prose, repeats included. */
function words(body: string, names: readonly string[]): string[] {
  const found = [...body.matchAll(ACRONYM)].map(m => m[0])
  const local = (body.match(/[가-힣ぁ-ヿ一-鿿]/g) ?? []).length
  const isCjk = local > body.length * 0.15
  if (isCjk) found.push(...[...body.matchAll(ENGLISH_RUN)].map(m => m[0]))
  found.push(...[...body.matchAll(MIXED_CASE)].map(m => m[0]))
  // Korean and Japanese answers bold their headings and labels; their terms already come from the English runs
  if (!isCjk) found.push(...[...body.matchAll(BOLD)].map(m => m[1]!).filter(isBoldName))
  // ponytail: one scan of the answer per name; build one matcher for the list when it passes tens of thousands
  found.push(...names.filter(name => hasName(body, name)))
  return found
}

/** The prose sentence a word was used in, markdown marks dropped, cut around the word when long. */
export function sentenceOf(body: string, word: string): string {
  const line = body.split(/\n+|(?<=[.!?。])\s+/).find(x => x.includes(word)) ?? ''
  const s = line.replace(/^[\s#>*|\-\d.]+/, '').replace(/\*\*|__|\|/g, ' ').replace(/\s+/g, ' ').trim()
  if (s.length <= CONTEXT_CHARS) return s
  const at = Math.max(0, Math.min(s.indexOf(word) - Math.floor((CONTEXT_CHARS - word.length) / 2), s.length - CONTEXT_CHARS))
  return (at > 0 ? '…' : '') + s.slice(at, at + CONTEXT_CHARS).trim() + (at + CONTEXT_CHARS < s.length ? '…' : '')
}

/** Queues an answer's unseen candidates with the sentence each came from; the sentence never leaves terms.json.
 * `project` is the session folder's own name, sent with each word so the service shows where it came up. */
export function enqueue(db: TermsDb, text: string, now: string, skip?: (word: string) => boolean, names?: readonly string[], project?: string): TermsDb {
  const room = MAX_PENDING - db.pending.length
  if (room <= 0) return db
  const body = prose(text)
  const fresh = candidates(text, db, names)
    .filter(word => !skip?.(word))
    .slice(0, room)
    .map((word): Pending => ({ word, key: normalize(word), context: sentenceOf(body, word), seen: now, ...(project ? { p: project } : {}) }))
  return fresh.length ? { ...db, pending: [...db.pending, ...fresh] } : db
}

/** A full batch is waiting, or the oldest candidate has waited long enough (a day for the local judge). */
export function due(db: TermsDb, nowMs: number, min = BATCH, waitMs = MAX_WAIT_MS): boolean {
  const oldest = db.pending[0]
  return db.pending.length >= min || (oldest !== undefined && nowMs - Date.parse(oldest.seen) >= waitMs)
}

/** A batch that was claimed but not judged goes back to the front of the queue; an upload goes back although its term is here. */
export function putBack(db: TermsDb, batch: readonly Pending[]): TermsDb {
  const known = seenKeys(db)
  return { ...db, pending: [...batch.filter(p => p.up || !known.has(p.key)), ...db.pending] }
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
      ...db,
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

export function migrate(raw: { terms?: StoredTerm[]; ignored?: string[]; pending?: Pending[]; cloud?: Cloud; account?: string; uploadAsked?: string }): TermsDb {
  // keys written under an older normalize() take the current one; the old keys stay as names, so nothing seen is new
  const again = (keys: string[]) => [...new Set([...keys, ...keys.map(normalize)])]
  const terms = (raw.terms ?? []).map(({ isDone, status, ...t }): Term => {
    const key = normalize(t.key)
    return {
      ...t,
      key,
      aliases: again([...t.aliases, t.key]).filter(a => a !== key),
      status: status ?? (isDone ? 'done' : 'todo'),
    }
  })
  const pending = (raw.pending ?? []).map(p => ({ ...p, key: normalize(p.word) }))
  return {
    version: 1,
    terms,
    ignored: again(raw.ignored ?? []),
    pending,
    ...(raw.cloud ? { cloud: raw.cloud } : {}),
    ...(raw.account ? { account: raw.account } : {}),
    ...(raw.uploadAsked ? { uploadAsked: raw.uploadAsked } : {}),
  }
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
// Cloud mode: how many local terms the pane asks to upload, and the keys of the terms only this PC has.
let toAsk = 0
let onlyHere = new Set<string>()

function remember(db: TermsDb) {
  waiting = db.pending.length
  cloudInfo = db.cloud
  toAsk = uploadAsk(db)
  onlyHere = new Set(db.cloud ? localOnly(db).map(t => t.key) : [])
}

async function load($: EngineInterface): Promise<TermsDb> {
  const path = await dbPath($)
  // a corrupt file throws here, so nothing below ever overwrites it with an empty list
  const db = (await isFile($, path)) ? migrate(JSON.parse(await $.fs.read(path))) : emptyDb()
  remember(db)
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
  remember(db)
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
    const next = enqueue(db, text, new Date(await $.clock.now()).toISOString(), mask && (w => isSecretLike(w) || mask.keys.has(normalize(w))),
      mask && (await catalogNames($)), mask?.project)
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
      system: system(lang),
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
        if (!(all ? db.pending.length > 0 : due(db, await $.clock.now()))) return []
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
    // a term the server knows is marked, and the lead session tells the server on its next tick;
    // removing stays on this PC: the server keeps the term as it was
    const isSent = (t: Term) => t.id && db.cloud && status !== 'removed'
    await save($, { ...db, terms: db.terms.map(t => (t.key === key ? { ...(({ push, ...rest }) => rest)(t), status, ...(isSent(t) ? { push: true } : {}) } : t)) })
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

/**
 * The name the service shows as a term's project: the session folder's own name, never the path above it.
 * None for the home folder or a folder above it, whose name is the person's, not a project's.
 */
export function projectName(cwd: string, home: string): string | undefined {
  const parts = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const c = parts(cwd), h = parts(home)
  if (!c || h === c || h.startsWith(c + '/')) return undefined
  const name = cwd.split(/[\\/]/).filter(Boolean).pop()?.trim().slice(0, 100)
  return name && !/^[a-z]:$/i.test(name) && !isSecretLike(name) && !PERSONAL.test(name) ? name : undefined
}

/** The session's own names, never sent as words: the folder path's parts, the git remote's owner and repository, the package name, .termboardignore lines. */
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

let maskCache: Promise<{ keys: Set<string>; isOff: boolean; project?: string }> | undefined
function masks($: EngineInterface) {
  return (maskCache ??= (async () => {
    const cwd = await $.session.cwd()
    const file = (name: string) => $.fs.read(`${cwd}/${name}`).catch(() => '')
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
    return {
      ...maskKeys(cwd, await file('.git/config'), await file('package.json'), await file('pyproject.toml'), await file('.termboardignore')),
      project: sendProject ? projectName(cwd, home) : undefined,
    }
  })())
}

// ---------- first scan: once per project, typed by the person ----------

// The scan reads every past answer of the project and its documents, and what it queues is judged by a model:
// costly, so it runs once per project and never from a model's or a plugin's command run.
const TYPED: ReadonlySet<string> = new Set(['composer', 'bridge', 'sdk'])
const SCAN_DIR = '.claude/phro-learning/scans'
// ponytail: the 600 words used most; a long project has more, and later answers bring the rest one by one
const SCAN_MAX = 600
const READ_BYTES = 4 * 1024 * 1024
const MAX_FILE_BYTES = 1024 * 1024
const MAX_FILES = 3000
const MAX_DEPTH = 6
const CLAIM_MS = 300
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'coverage', '__pycache__', 'venv', 'site-packages'])
const DOCS = new Set(['md', 'mdx', 'markdown', 'txt', 'rst', 'adoc'])
// ponytail: line comments and block-comment lines only; a Python docstring or a comment after code is not read
const SLASH = /^\s*(?:\/\/+!?|\/\*+!?|\*+(?!\/))\s?(.*?)(?:\*\/)?\s*$/
const HASH = /^\s*#+(?![!\[])\s?(.*)$/
const DASH = /^\s*--\s?(.*)$/
const COMMENT: Record<string, RegExp> = {
  ...Object.fromEntries('ts tsx js jsx mjs cjs go rs java kt kts c h cc cpp hpp cs swift scala php dart vue svelte'.split(' ').map(x => [x, SLASH])),
  ...Object.fromEntries('py sh bash zsh rb yml yaml toml ps1 r pl'.split(' ').map(x => [x, HASH])),
  ...Object.fromEntries('sql lua hs'.split(' ').map(x => [x, DASH])),
}

/** A file's comment text, one comment block per paragraph. */
export function comments(src: string, ext: string): string {
  const line = COMMENT[ext]
  if (!line) return ''
  return src
    .split('\n')
    .map(l => line.exec(l)?.[1] ?? '')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** The main thread's answers in transcript lines, with their time. Tool calls, thinking and subagent turns stay out. */
export function answerTexts(lines: string): { text: string; at: string }[] {
  const out: { text: string; at: string }[] = []
  for (const line of lines.split('\n')) {
    if (!line.includes('"assistant"') || !line.includes('"text"')) continue
    let row: { type?: unknown; isSidechain?: unknown; timestamp?: unknown; message?: { content?: unknown } }
    try {
      row = JSON.parse(line)
    } catch {
      continue // the open session's last line can be half written
    }
    if (row.type !== 'assistant' || row.isSidechain || !Array.isArray(row.message?.content)) continue
    const text = (row.message.content as { type?: unknown; text?: unknown }[])
      .flatMap(c => (c?.type === 'text' && typeof c.text === 'string' ? [c.text] : []))
      .join('\n\n')
    if (text) out.push({ text, at: typeof row.timestamp === 'string' ? row.timestamp : '' })
  }
  return out
}

export type Found = { word: string; key: string; n: number; seen: string; context: string }

/** Counts each candidate once per text it is in, keeping its earliest time and the sentence it had then. */
export function tally(into: Map<string, Found>, text: string, at: string, names: readonly string[] = []): void {
  const body = prose(text)
  const here = new Set<string>()
  for (const raw of words(body, names)) {
    const word = raw.trim()
    const key = normalize(word)
    if (here.has(key) || !isTermKey(word, key)) continue
    here.add(key)
    const f = into.get(key)
    if (!f) into.set(key, { word, key, n: 1, seen: at, context: sentenceOf(body, word) })
    else {
      f.n++
      if (at && (!f.seen || at < f.seen)) Object.assign(f, { word, seen: at, context: sentenceOf(body, word) })
    }
  }
}

/** The words to queue: not seen before, not masked, the most used first. */
export function pick(found: Iterable<Found>, db: TermsDb, skip?: (word: string) => boolean, max = SCAN_MAX): Found[] {
  const seen = seenKeys(db)
  return [...found]
    .filter(f => !seen.has(f.key) && !skip?.(f.word))
    .sort((a, b) => b.n - a.n || a.seen.localeCompare(b.seen))
    .slice(0, max)
}

/**
 * Whether the scan may run, from this project's record (`undefined`: no record). The reply when it may not.
 * A record that cannot be read refuses: a scan that runs twice costs more than one that waits for a deleted file.
 */
export function scanVerdict(record: string | undefined, path: string): string | undefined {
  if (record === undefined) return undefined
  let m: { state?: unknown; at?: unknown; queued?: unknown } | undefined
  try {
    m = JSON.parse(record)
  } catch {
    m = undefined
  }
  const day = String(m?.at ?? '').slice(0, 10)
  if (m?.state === 'failed') return undefined
  if (m?.state === 'done') return tr('scan_done', { day, n: Number(m.queued) || 0 })
  if (m?.state === 'running') return tr('scan_running', { day, path })
  return tr('scan_unreadable', { path })
}

const hex = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].slice(0, 6).map(b => b.toString(16).padStart(2, '0')).join('')

/** This project's scan record: one file per project root, kept apart from terms.json so no reset or account change clears it. */
async function scanRecord($: EngineInterface): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (!home) throw new Error('neither USERPROFILE nor HOME is set')
  const root = (await $.session.root()).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const name = (root.split('/').pop() || 'root').replace(/[^\w.-]/g, '_').slice(0, 40)
  return `${home}/${SCAN_DIR}/${name}-${await hex(root)}.json`
}

const readRecord = async ($: EngineInterface, path: string) => ((await isFile($, path)) ? $.fs.read(path) : undefined)

declare global {
  // the engine has it (its docs decode `$.fs.read` bytes with it); the es2023 lib the hooks are typed against does not name it yet
  interface Uint8ArrayConstructor {
    fromBase64(base64: string): Uint8Array
  }
}

/** Calls `each` with whole lines of a file of any size, 4 MiB at a time. */
async function eachLines($: EngineInterface, path: string, size: number, each: (lines: string) => void): Promise<void> {
  const utf8 = new TextDecoder()
  let rest = new Uint8Array(0)
  for (let at = 0; at < size; at += READ_BYTES) {
    const got = Uint8Array.fromBase64((await $.fs.read(path, { as: 'bytes', offset: at, length: READ_BYTES })).base64)
    const buf = new Uint8Array(rest.length + got.length)
    buf.set(rest)
    buf.set(got, rest.length)
    const end = buf.lastIndexOf(10) + 1 // a newline byte is never inside a UTF-8 character
    if (end) each(utf8.decode(buf.subarray(0, end)))
    rest = buf.slice(end)
    if (got.length < READ_BYTES) break
  }
  if (rest.length) each(utf8.decode(rest))
}

/** Documents and code files under the root, breadth first, leaving dot folders, links and build output. */
async function projectFiles($: EngineInterface, root: string): Promise<{ path: string; ext: string; at: string }[]> {
  const out: { path: string; ext: string; at: string }[] = []
  const dirs: [string, number][] = [[root, 0]]
  for (let i = 0; i < dirs.length && out.length < MAX_FILES; i++) {
    const [dir, depth] = dirs[i]!
    const entries = await $.fs.list(dir).catch(err => {
      if (depth === 0) throw err
      return [] // a folder this user may not open
    })
    for (const e of entries) {
      if (e.name.startsWith('.') || e.isLink) continue
      const path = `${dir}/${e.name}`
      if (e.kind === 'dir') {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(e.name.toLowerCase())) dirs.push([path, depth + 1])
        continue
      }
      const ext = e.name.includes('.') ? e.name.split('.').pop()!.toLowerCase() : ''
      if (e.kind === 'file' && e.size <= MAX_FILE_BYTES && (DOCS.has(ext) || COMMENT[ext])) out.push({ path, ext, at: new Date(e.mtimeMs).toISOString() })
      if (out.length >= MAX_FILES) break
    }
  }
  return out
}

/**
 * The folder Claude Code keeps this project's transcripts in: the session folder's path, every character but a letter or
 * digit made "-". Worked out rather than asked, since `$.session.info()` is missing from older engines, where naming it
 * keeps the whole module from loading. ponytail: a path long enough that Claude Code shortens its folder name is not found
 */
async function transcripts($: EngineInterface): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${home}/.claude`
  return `${config}/projects/${(await $.session.cwd()).replace(/[^a-zA-Z0-9]/g, '-')}`
}

const isDir = ($: EngineInterface, path: string) =>
  $.fs.list(path).then(
    () => true,
    () => false,
  )

/** Reads the project's past answers (forks included) and its documents and code comments into candidate counts. */
async function gather($: EngineInterface, names: readonly string[]): Promise<{ found: Map<string, Found>; answers: number; files: number }> {
  const found = new Map<string, Found>()
  let answers = 0
  const dir = await transcripts($)
  if (await isDir($, dir)) {
    // every session and fork of this project is a .jsonl here; subagents' runs sit in folders and stay out
    for (const e of await $.fs.list(dir)) {
      if (e.kind !== 'file' || !e.name.endsWith('.jsonl')) continue
      await eachLines($, `${dir}/${e.name}`, e.size, lines => {
        for (const a of answerTexts(lines)) {
          answers++
          tally(found, a.text, a.at, names)
        }
      })
    }
  }
  const files = await projectFiles($, await $.session.root())
  for (const f of files) {
    const src = await $.fs.read(f.path)
    const text = DOCS.has(f.ext) ? src : comments(src, f.ext)
    for (const part of text.split(/\n\s*\n/)) if (part.trim()) tally(found, part, f.at, names)
  }
  return { found, answers, files: files.length }
}

let scanning = false

/** The first scan, run once per project. Every refusal is a reply; nothing is queued twice. */
async function firstScan($: EngineInterface, origin: string): Promise<string> {
  if (!TYPED.has(origin)) return tr('scan_typed')
  if (scanning) return tr('scan_busy')
  scanning = true
  try {
    const path = await scanRecord($)
    const refused = scanVerdict(await readRecord($, path), path)
    if (refused) return refused
    const mask = (await auth($)) ? await masks($) : undefined
    if (mask?.isOff) return tr('scan_off')

    // claim, then look again: of two sessions that claimed at once, the last write holds it
    const by = Math.random().toString(36).slice(2)
    await $.fs.write(path, JSON.stringify({ state: 'running', at: new Date(await $.clock.now()).toISOString(), by }) + '\n')
    await new Promise<void>(done => $.clock.after(CLAIM_MS, done))
    if (JSON.parse((await readRecord($, path)) ?? '{}').by !== by) return tr('scan_busy')

    let queued: number, answers: number, files: number
    try {
      const names = mask ? await catalogNames($) : []
      const g = await gather($, names)
      answers = g.answers
      files = g.files
      queued = await serial(async () => {
        const db = await load($)
        const now = new Date(await $.clock.now()).toISOString()
        const fresh = pick(g.found.values(), db, mask && (w => isSecretLike(w) || mask.keys.has(normalize(w))))
          .map((f): Pending => ({ word: f.word, key: f.key, context: f.context, seen: f.seen || now, ...(mask?.project ? { p: mask.project } : {}) }))
        if (fresh.length) await save($, { ...db, pending: [...db.pending, ...fresh] })
        return fresh.length
      })
    } catch (err) {
      // nothing was queued: the record lets the scan run again
      await $.fs.write(path, JSON.stringify({ state: 'failed', at: new Date(await $.clock.now()).toISOString(), error: String(err).slice(0, 200) }) + '\n')
      return tr('scan_failed', { err: String(err).slice(0, 200) })
    }
    // ponytail: a crash between the queue's save and this write leaves "running", which refuses until the file is deleted
    await $.fs.write(path, JSON.stringify({ state: 'done', at: new Date(await $.clock.now()).toISOString(), queued, answers, files }) + '\n')

    if (await auth($)) {
      void tick($, true).catch(err => reportFailure($, err))
      return tr('scan_sent', { n: queued, answers, files })
    }
    $.clock.after(0, () => {
      void judgeAll($)
        .then(r => (r.asked ? $.ui.toast(tr('judged', r)) : undefined))
        .catch(err => reportFailure($, err))
    })
    return tr('scan_local', { n: queued, answers, files })
  } finally {
    scanning = false
  }
}

/** Judges batch after batch until nothing waits, or another run in this session holds the judge. */
async function judgeAll($: EngineInterface): Promise<{ asked: number; added: number }> {
  const total = { asked: 0, added: 0 }
  for (;;) {
    const r = await judge($, true)
    if (!r.asked) return total
    total.asked += r.asked
    total.added += r.added
  }
}

const STATUSES: readonly string[] = ['todo', 'review', 'done', 'removed']

const RANK: Record<Status, number> = { todo: 0, review: 1, done: 2, removed: 3 }

/**
 * Puts the server's terms into the local copy: by id, else over a local term of the same key, and drops the rows
 * the server deleted (`gone`). Terms still being judged are skipped.
 * A tab change not yet sent wins over what the server has, and goes out with the change number it was made from.
 * A term met for the first time (a local term of the same key, or an uploaded one) keeps the further of the two tabs.
 * A removal never goes to the server, so it stays.
 */
export function applyRemote(db: TermsDb, items: readonly Remote[], gone: readonly string[] = []): TermsDb {
  const dropped = new Set(gone)
  let terms = dropped.size ? db.terms.filter(t => !t.id || !dropped.has(t.id)) : db.terms
  for (const r of items) {
    if (r.pending || dropped.has(r.id)) continue
    let at = terms.findIndex(t => t.id === r.id)
    if (at < 0) at = terms.findIndex(t => !t.id && t.key === r.key)
    const old = terms[at]
    const remote: Status = STATUSES.includes(r.status) ? (r.status as Status) : (old?.status ?? 'todo')
    const isFirst = old && (!old.id || (old.push && old.ver === undefined))
    const status: Status =
      !old ? remote
      : old.status === 'removed' ? 'removed'
      : isFirst ? (RANK[old.status] > RANK[remote] ? old.status : remote)
      : old.push ? old.status
      : remote
    const push = status !== 'removed' && status !== remote
    const ver = push && old?.ver !== undefined ? old.ver : r.ver
    const term: Term = {
      key: r.key,
      term: r.term,
      aliases: old?.aliases ?? [],
      meaning: r.meaning,
      example: r.example,
      status,
      ...((KINDS as readonly string[]).includes(r.kind ?? '') ? { kind: r.kind as Kind } : {}),
      id: r.id,
      ...(push ? { push: true } : {}),
      ...(ver !== undefined ? { ver } : {}),
    }
    terms = at < 0 ? [term, ...terms] : terms.map((t, i) => (i === at ? term : t))
  }
  return { ...db, terms }
}

/** Terms judged on this PC that the server does not have: no id, not removed, not on their way up. */
export function localOnly(db: TermsDb): Term[] {
  const going = new Set(db.pending.filter(p => p.up).map(p => p.key))
  return db.terms.filter(t => !t.id && t.status !== 'removed' && !going.has(t.key))
}

/** How many local terms the pane asks to upload: only while connected and not yet answered for this account. */
export function uploadAsk(db: TermsDb): number {
  return db.cloud && db.account && db.uploadAsked !== db.account ? localOnly(db).length : 0
}

// An e-mail, an IP address or a phone number is a person's, not a term
const PERSONAL = /@|\b\d{1,3}(\.\d{1,3}){3}\b|\+?\d[\d ()-]{7,}\d/

/**
 * Queues this PC's local terms in front of the waiting candidates, through the same filters a candidate passes:
 * learned first, then in review, then to learn, newest first in each, up to the plan's room. The local meaning
 * and other names stay here; the service's text replaces them when the term comes back.
 */
export function upload(db: TermsDb, now: string, skip: (word: string) => boolean = () => false): { db: TermsDb; n: number } {
  const order = (t: Term) => (t.status === 'done' ? 0 : t.status === 'review' ? 1 : 2)
  const words = localOnly(db)
    .sort((a, b) => order(a) - order(b)) // stable: newest first stays within each tab
    .map(t => {
      const short = t.term.length > 40 ? t.term.replace(/\([^)]*\)/g, '').trim() : t.term // the server takes 2 to 40 characters
      return { word: short, key: t.key }
    })
    .filter(w => w.word.length >= 2 && w.word.length <= 40 && normalize(w.word) === w.key && !PERSONAL.test(w.word) && !isSecretLike(w.word) && !skip(w.word))
    .slice(0, db.cloud?.room ?? Infinity)
    .map((w): Pending => ({ ...w, context: '', seen: now, up: true }))
  return { db: { ...db, pending: [...words, ...db.pending], ...(db.account ? { uploadAsked: db.account } : {}) }, n: words.length }
}

type Reply = { status: number; data: Record<string, any> }

async function call($: EngineInterface, server: string, method: string, path: string, body?: unknown, token?: string, extra: Record<string, string> = {}): Promise<Reply> {
  const r = await $.http.fetch(`${server}/v1${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Client-Version': await version($), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
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
async function authed($: EngineInterface, method: string, path: string, body?: unknown, extra?: Record<string, string>): Promise<Reply | undefined> {
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
    const r = await call($, a.server, method, path, body, access.token, extra)
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
    lang: typeof r.data.lang === 'string' ? r.data.lang : lang,
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
// one fetch of the glossary after a send: at once when the server already had terms (syncNow), and at the time
// it gave for judging its new words (syncAt). ponytail: module variables, lost on reload; the pane's own sync
// every SYNC_MS covers that
let syncNow = false
let syncAt = 0
let lastSync = 0

/** One key per batch: the same batch sent again after a lost reply gets the first reply back, ids included. */
export async function batchKey(batch: readonly Pending[]): Promise<string> {
  const text = batch.map(p => `${p.key}\t${p.seen}`).join('\n')
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))
  return [...hash.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** Ties local terms to the rows the server gave for their keys; a row still being judged is marked, so its tab waits. */
export function attachIds(db: TermsDb, ids: readonly { k: string; id: string; pending?: boolean }[]): TermsDb {
  const byKey = new Map(ids.map(x => [x.k, x]))
  return {
    ...db,
    terms: db.terms.map(t => {
      const x = !t.id && byKey.get(t.key)
      // the tab goes out once the row comes back through sync with its change number
      return x ? { ...t, id: x.id, ...(x.pending ? { pending: true as const } : {}), ...(t.status !== 'todo' && t.status !== 'removed' ? { push: true } : {}) } : t
    }),
  }
}

/** Sends one batch of waiting candidates. It leaves the file first, so no session sends it twice, and goes back when the send fails. */
async function flush($: EngineInterface, isForced = false): Promise<void> {
  if (Date.now() < retryAt) return
  const batch = await serial(async () => {
    const db = await load($)
    if (!db.cloud || db.cloud.notice || db.pending.length === 0) return []
    if (!isForced && !due(db, await $.clock.now(), SEND_MIN, SEND_WAIT_MS)) return []
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
    r = await authed($, 'POST', '/ingest', { at: new Date().toISOString(), lang, items: batch.map(p => ({ t: p.word, n: 1, s: p.seen, ...(p.p ? { p: p.p } : {}) })) }, { 'Idempotency-Key': await batchKey(batch) })
  } catch (err) {
    await hold()
    retryAt = Date.now() + Math.min(MAX_RETRY_MS, 1000 * 2 ** fails++)
    throw err
  }
  if (r?.status === 200) {
    fails = 0
    // sent words are never sent again; the glossary comes back through sync
    const ids = Array.isArray(r.data.ids) ? (r.data.ids as { k: string; id: string; pending?: boolean }[]) : []
    await serial(async () => {
      const db = await load($)
      await save($, attachIds({ ...db, ignored: [...db.ignored, ...batch.map(p => p.key)].slice(-MAX_IGNORED) }, ids))
    })
    // rows the server already had moved with this send, so the next sync brings them
    if (r.data.known?.length || ids.some(x => !x.pending)) syncNow = true
    if (r.data.queued) syncAt = Math.max(syncAt, (await $.clock.now()) + (Number(r.data.ready_in_ms) || SYNC_MS))
    return
  }
  if (r?.status === 403 && r.data.type === 'plan_limit') return hold(tr('full'))
  if (r?.status === 426) return hold(tr('update_needed'))
  await hold()
  if (r) retryAt = Date.now() + Math.max(Number(r.data.retry_after_ms) || 0, Math.min(MAX_RETRY_MS, 1000 * 2 ** fails++))
}

/**
 * Tells the server the tab changes made here, each with the change number it was made from. A term still being
 * judged, or not yet seen through sync, waits. 409: another PC or the web changed it since; theirs stands.
 */
async function pushStatus($: EngineInterface): Promise<void> {
  const dirty = (await serial(() => load($))).terms.filter(t => t.push && t.id && !t.pending && t.ver !== undefined)
  for (const t of dirty) {
    const r = await authed($, 'PATCH', `/me/terms/${t.id}`, { status: t.status, ver: t.ver })
    // 404: the term is gone on the server; the next sync drops it
    if (r?.status !== 200 && r?.status !== 404 && r?.status !== 409) return
    const ver = typeof r.data.ver === 'number' ? r.data.ver : undefined
    const theirs = r.status === 409 && STATUSES.includes(r.data.current) ? (r.data.current as Status) : undefined
    await serial(async () => {
      const db = await load($)
      const terms = db.terms.map(x => {
        if (x.id !== t.id) return x
        const { push, ver: _, ...rest } = x
        const base = ver === undefined ? { ...rest, ...(x.ver !== undefined ? { ver: x.ver } : {}) } : { ...rest, ver }
        // a tab changed again here meanwhile goes out on the next round, from the new number; a removal stays here
        if (x.status !== t.status) return x.status === 'removed' ? base : { ...base, push: true }
        return theirs ? { ...base, status: theirs } : base
      })
      await save($, { ...db, terms })
    })
  }
}

/** Fetches the plan and the glossary changes since the last sync; returns how many terms changed, or undefined when it could not. */
async function sync($: EngineInterface): Promise<number | undefined> {
  let boot = await authed($, 'GET', '/client/bootstrap')
  if (boot?.status !== 200) return undefined
  const account = typeof boot.data.account === 'string' ? boot.data.account : undefined
  // the language chosen here goes to the account once after it changes; the last one changed, here or on the web, stands
  const sent = (await $.store.get('langSent')) as { account?: string; lang: string } | undefined
  if (wantLang !== 'account' && (sent?.account !== account || sent?.lang !== wantLang)) {
    const set = await authed($, 'PATCH', '/me/profile', { locale: wantLang })
    if (set?.status === 200) {
      await $.store.set('langSent', { account, lang: wantLang })
      boot = (await authed($, 'GET', '/client/bootstrap')) ?? boot
    }
    if (boot.status !== 200) return undefined
  }
  await syncNames($, boot.data.names?.etag)
  // A first sync (or another account, or a cursor the server no longer covers) fetches the whole glossary, and
  // then drops the rows of the copy the server no longer has.
  let seen: Set<string> | undefined
  await serial(async () => {
    const db = await load($)
    if (!db.cloud || !account || db.account === account) return
    seen = new Set()
    const { cursor, ...cloud } = db.cloud
    // another account's rows leave this PC; local terms and waiting candidates stay
    const terms = db.account ? db.terms.filter(t => !t.id) : db.terms
    await save($, { ...db, terms, cloud, account })
    $.ui.invalidate('ui.render') // the upload question is for this account
  })
  const cap = boot.data.limits?.cloud_terms
  let changed = 0
  let isDone = false
  for (let page = 0; page < 20; page++) {
    const cursor = (await serial(() => load($))).cloud?.cursor
    if (!cursor) seen ??= new Set()
    const r = await authed($, 'GET', `/me/terms${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`)
    if (r?.status !== 200) {
      isDone = r?.status === 304
      break
    }
    const items = (r.data.items ?? []) as Remote[]
    const gone = (r.data.gone ?? []) as string[]
    if (r.data.reset) seen = new Set()
    for (const t of items) seen?.add(t.id)
    await serial(async () => {
      const db = await load($)
      if (!db.cloud) return
      const next = r.data.reset ? undefined : (r.data.next ?? cursor)
      const cloud: Cloud = { server: db.cloud.server, plan: boot.data.plan, at: new Date().toISOString(), ...(next ? { cursor: next } : {}) }
      if (typeof boot.data.blur?.unlock_left === 'number') cloud.unlockLeft = boot.data.blur.unlock_left // absent: no daily cap
      if (typeof cap === 'number') cloud.room = Math.max(0, cap - (Number(boot.data.used) || 0))
      await save($, applyRemote({ ...db, cloud }, items, gone))
    })
    changed += items.filter(t => !t.pending).length + gone.length
    if (items.length === 0 && !r.data.reset) {
      isDone = true
      break
    }
  }
  if (isDone && seen) {
    const kept = seen
    await serial(async () => {
      const db = await load($)
      const terms = db.terms.filter(t => !t.id || kept.has(t.id))
      changed += db.terms.length - terms.length
      if (terms.length !== db.terms.length) await save($, { ...db, terms })
    })
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
    await flush($, isForced)
    await pushStatus($)
    const isJudged = syncAt > 0 && (await $.clock.now()) >= syncAt
    if (!isForced && !syncNow && !isJudged && !((await read($, isOpen)) && Date.now() - lastSync >= SYNC_MS)) return undefined
    const changed = await sync($)
    if (changed !== undefined) {
      syncNow = false
      if (isJudged) syncAt = 0
    }
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
  const r = await call($, server, 'POST', '/auth/device/code', { device_name: name.slice(0, 80), client_version: await version($) })
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

/** The answer to the pane's upload question: queue this PC's local terms for the service, or keep them here. */
async function answerUpload($: EngineInterface, isUp: boolean): Promise<void> {
  const mask = isUp ? await masks($) : undefined
  const n = await serial(async () => {
    const db = await load($)
    if (!db.account) return 0
    if (!isUp || mask?.isOff) {
      await save($, { ...db, uploadAsked: db.account })
      return 0
    }
    const r = upload(db, new Date(await $.clock.now()).toISOString(), w => mask!.keys.has(normalize(w)))
    await save($, r.db)
    return r.n
  })
  if (isUp) $.ui.toast(tr('uploading', { n }))
  $.ui.invalidate('ui.render')
}

/** Ends the connection: the server drops this PC's tokens, the queue is emptied, and judging goes back to this PC. */
async function logout($: EngineInterface): Promise<string> {
  if (!(await auth($))) return 'Not connected.'
  await isLead($, true)
  await authed($, 'POST', '/auth/logout', {}).catch(() => undefined) // offline: the token still ends here, and expires there
  await $.store.delete('auth')
  access = undefined
  catalog = undefined
  useLocal()
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

// a check moves a term one tab on: to learn, then review, then learned; unchecking a learned term sends it back to review
const TABS: { status: Status; label: string; empty: string; next?: Status }[] = [
  { status: 'todo', label: 'tab_todo', empty: 'empty_todo', next: 'review' },
  { status: 'review', label: 'tab_review', empty: 'empty_review', next: 'done' },
  { status: 'done', label: 'tab_done', empty: 'empty_done', next: 'review' },
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
  sendProject = options?.project !== 'off'
  useLocal()
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'phro-learn',
      description:
        'Open the AI/IT term board ("scan" reads this project\'s past sessions and documents once, the first time only; ' +
        '"judge" judges the waiting candidates now, ' +
        '"stats" shows Haiku token use, ' +
        '"login" connects to the workphro service so it judges instead of Haiku, "logout", "status", "sync", ' +
        '"upload" asks again whether to upload the terms judged on this PC)',
      argumentHint: '[scan|judge|stats|login|logout|status|sync|upload]',
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
    if (arg === 'upload') {
      if (!(await auth($))?.refresh) return { text: 'Not connected. Run "/phro-learn login".' }
      const n = await serial(async () => {
        const db = await load($)
        const { uploadAsked, ...rest } = db
        await save($, rest)
        return uploadAsk(rest)
      })
      revive($)
      await $.ui.open({ id: PANE, title: 'phro-learn' })
      await update($, isOpen, () => true)
      $.ui.invalidate('ui.render')
      return { text: n ? `${n} local terms are on this PC only: the pane asks whether to upload them.` : 'No local terms to upload (or the first sync has not run yet).' }
    }
    if (arg === 'sync') {
      if (!(await auth($))?.refresh) return { text: 'Not connected. Run "/phro-learn login".' }
      const changed = await tick($, true)
      return { text: changed === undefined ? 'Could not sync now.' : `Synced: ${changed} terms changed.` }
    }
    if (arg === 'judge') {
      const r = await judge($, true)
      return { text: r.asked ? `Judged ${r.asked} candidates: ${r.added} new terms.` : 'No candidates waiting.' }
    }

    if (arg === 'scan') return { text: await firstScan($, e.origin.kind) }

    revive($)
    await $.ui.open({ id: PANE, title: 'phro-learn' })
    await update($, isOpen, () => true)
    $.ui.invalidate('ui.render') // an already open pane draws again with live handles
    return { text: 'Term board opened.' }
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
          {TABS.map(t => {
            const button = (
              <Button
                key={`tab-${t.status}`}
                label={`${tr(t.label)} (${list.filter(x => x.status === t.status).length})`}
                variant={t.status === current ? 'primary' : 'secondary'}
                onPress={() => (t.status === current ? undefined : fresh(() => update($, tab, () => t.status)))}
              />
            )
            // the removed tab sits on red, apart from the three study tabs
            return t.status === 'removed' ? <Box key="tab-removed-bg" backgroundColor="error">{button}</Box> : button
          })}
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
        {toAsk > 0 && (
          <Box>
            <Text>
              {tr('upload_ask', { n: toAsk })}
              {cloudInfo?.room === undefined ? '' : tr('upload_room', { n: cloudInfo.room })}{' '}
            </Text>
            <Button key="upload" label={tr('upload')} variant="primary" onPress={() => answerUpload($, true).catch(err => reportFailure($, err))} />
            <Button key="upload-keep" label={tr('upload_keep')} onPress={() => answerUpload($, false).catch(err => reportFailure($, err))} />
          </Box>
        )}
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
                <Button key={`check-${t.key}`} plain onPress={move(t.key, TABS.find(x => x.status === current)!.next!)}>
                  {current === 'done' ? '☑ ' : '☐ '}
                  <Text bold>{t.term}</Text>
                </Button>
              )}
              {t.kind && <Text dimColor> {tr(`kind_${t.kind}`)} </Text>}
              {onlyHere.has(t.key) && <Text dimColor> {tr('only_here')} </Text>}
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
