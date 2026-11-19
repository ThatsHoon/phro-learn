/** Which tab a term sits in: to learn, archived, or removed. Removed terms stay for dedup. */
export type Status = 'todo' | 'review' | 'done' | 'removed'

/** What a term names; the pane labels it. */
export type Kind = 'concept' | 'method' | 'metric' | 'model' | 'tool' | 'standard' | 'org'

export type Term = {
  /** normalize(term): the dedup key */
  key: string
  term: string
  /** normalized other names (full name, Korean name, spelling variants, initials) */
  aliases: string[]
  meaning: string
  /** from 0.11: the answer sentence the term was met in; before, a use Haiku wrote */
  example: string
  status: Status
  kind?: Kind
  /** version of the judging prompt that added the term; absent = before 0.11 */
  v?: number
  /** cloud mode: the server's id of this term ("ut_91"); absent = a term judged on this PC */
  id?: string
  /** cloud mode: the tab was changed here and the server has not been told yet */
  push?: boolean
  /** cloud mode: the server's change number of the tab, sent back with a change so an older view loses */
  ver?: number
  /** cloud mode: the server is still judging this uploaded term; its tab is sent once it is judged */
  pending?: true
}

/** A candidate waiting to be judged with others, so the prompt is paid once per batch. */
export type Pending = {
  word: string
  key: string
  /** the answer sentence it came from; stays in this file, never sent */
  context: string
  /** ISO time it was queued */
  seen: string
  /** a local term the member chose to upload: it goes out although a term of its key is already here */
  up?: true
  /** the name of the folder the session ran in (never the path), sent with the word unless the project option is off */
  p?: string
}

/** ~/.claude/phro-learning/terms.json */
export type TermsDb = {
  version: 1
  terms: Term[]
  /** normalized candidates Haiku already judged not worth keeping; never sent again */
  ignored: string[]
  /** oldest first */
  pending: Pending[]
  /** present while this PC is connected to the service (cloud mode) */
  cloud?: Cloud
  /** the account the terms with an id belong to; kept after logout, so another account's login starts clean */
  account?: string
  /** the account for which the member answered whether to upload this PC's local terms */
  uploadAsked?: string
}

/** What the pane's head line shows in cloud mode, and where the glossary sync stands. */
export type Cloud = {
  server: string
  plan?: string
  /** the daily count the service reports, shown as is in the pane */
  unlockLeft?: number
  /** the sync position the server gave last */
  cursor?: string
  /** ISO time of the last sync */
  at?: string
  /** why sending is on hold (plan limit, outdated client); cleared by the next sync */
  notice?: string
  /** how many more terms the plan holds; absent = no cap */
  room?: number
}

/** One term as GET /v1/me/terms gives it. */
export type Remote = {
  id: string
  key: string
  term: string
  status: string
  pending: boolean
  kind?: string | null
  meaning: string
  example: string
  ver?: number
}

/** The refresh token of this PC's connection, kept in $.store under "auth". An empty token = signed out, log in again. */
export type Auth = { server: string; refresh: string }

/** How the pane sorts a tab: newest first (stored order), Latin names A-Z first, Korean names 가-힣 first. */
export type Order = 'time' | 'abc' | 'ganada'

/** Cumulative Haiku spend, kept in $.store under "usage". */
export type Usage = { calls: number; failed: number; input: number; output: number; since: string }

/** One Haiku call, kept in $.store under "calls" (the latest 200): where its tokens went. */
export type CallLog = { at: string; asked: number; kept: number; input: number; output: number; chars: number }

declare module 'claude-code' {
  interface PluginState {
    'phro-learn': { terms: Term[]; tab: Status; query: string; order: Order; limit: number; isOpen: boolean }
  }
}
