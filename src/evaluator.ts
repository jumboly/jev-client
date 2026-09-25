import { evaluate as jevEvaluate, JevError, type Answer, type EvaluateOptions, type JevAuth, type JevProvider, type Question, type Usage } from './client.js'
import type { JevGate } from './gate.js'

/**
 * 「質問に答える役」の抽象。アプリは JEV を直接呼ばずこれを通す。
 * JEV が 429/503 で不安定なことがあるため、開発・テスト時に録画再生やダミーへ差し替え・連結できるようにする。
 * 本番では jev 単体で使い、JEV 以外の判断を混ぜる場合は source で区別すること。
 */

export type AnswerSource = 'jev' | 'replay' | 'mock'

export interface EvalResult {
  answers: Record<string, Answer>
  source: AnswerSource
  /** 実際に JEV を呼んだ場合のみ。録画再生・ダミーは課金されないので無し */
  usage?: Usage
  /** source が jev のときの経路。source は「JEV の判断か」を表すので経路は別の項目に分ける */
  provider?: JevProvider
}

export type Evaluator = (state: unknown, questions: Record<string, Question>, opts?: EvaluateOptions) => Promise<EvalResult>

/** gate を指定すると、この Evaluator の呼び出しは既定（経路ごとの defaultGates）ではなくそれを共有する。呼び出し時の opts.gate が優先 */
export function jevEvaluator(auth: JevAuth, defaults: { gate?: JevGate } = {}): Evaluator {
  return async (state, questions, opts) => {
    const r = await jevEvaluate(auth, state, questions, { ...opts, gate: opts?.gate ?? defaults.gate })
    return auth.mode === 'mock' ? { answers: r.answers, source: 'mock' } : { answers: r.answers, source: 'jev', usage: r.usage, provider: r.provider }
  }
}

export function mockEvaluator(opts: { avoidKeys?: string[] } = {}): Evaluator {
  return async (state, questions) => ({
    answers: (await jevEvaluate({ mode: 'mock', avoidKeys: opts.avoidKeys }, state, questions)).answers,
    source: 'mock',
  })
}

/** 録画の保存先。Node ではファイル、テストではメモリなど環境ごとに実装する */
export interface RecordingStore {
  get(key: string): Promise<Record<string, Answer> | undefined>
  set(key: string, answers: Record<string, Answer>): Promise<void>
}

export function memoryStore(): RecordingStore & { size(): number } {
  const m = new Map<string, Record<string, Answer>>()
  return { get: async (k) => m.get(k), set: async (k, v) => void m.set(k, v), size: () => m.size }
}

/** キーの揺れを防ぐため、オブジェクトのキー順を正規化してからハッシュする */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical)
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
    )
  return v
}

export async function recordingKey(state: unknown, questions: Record<string, Question>): Promise<string> {
  const text = JSON.stringify(canonical({ state, questions }))
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 成功した回答を保存する。同じ局面の再現（録画再生）に使う */
export function recording(inner: Evaluator, store: RecordingStore): Evaluator {
  return async (state, questions, opts) => {
    const r = await inner(state, questions, opts)
    if (r.source === 'jev') await store.set(await recordingKey(state, questions), r.answers)
    return r
  }
}

export class ReplayMissError extends Error {
  constructor() {
    super('録画に同じ局面がありません')
  }
}

export function replayEvaluator(store: RecordingStore): Evaluator {
  return async (state, questions) => {
    const answers = await store.get(await recordingKey(state, questions))
    if (!answers) throw new ReplayMissError()
    return { answers, source: 'replay' }
  }
}

/**
 * 先頭から順に試し、失敗したら次へ。中断（abort）は代替せずそのまま投げる。
 * 例: withFallback(jev, replay, mock) = JEV → 録画 → ダミー
 */
export function withFallback(...chain: Evaluator[]): Evaluator {
  return async (state, questions, opts) => {
    let last: unknown
    for (const ev of chain) {
      try {
        return await ev(state, questions, opts)
      } catch (e) {
        if (opts?.signal?.aborted) throw e
        last = e
      }
    }
    throw last
  }
}

/** 失敗理由がリトライ・代替で回復し得るか（UI の「再試行」表示判定用） */
export function isRecoverable(e: unknown): boolean {
  return !(e instanceof JevError) || e.retryable || e.status === 599
}
