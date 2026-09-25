import { GateWaitTooLongError, JevGate } from './gate'

/**
 * JEV (typesafe-ai/jev) を Vercel AI Gateway のネイティブ HTTP API（/v1/evaluate）で呼ぶ。
 * AI Gateway は CORS を許可しているため、ブラウザからユーザー自身のキーで直接呼べる。
 * 開発時は dev サーバーのプロキシにキーを付与させる（proxy モード）ことで、キーをバンドルに入れない。
 */

export const JEV_MODEL = 'typesafe-ai/jev'
export const GATEWAY_EVALUATE_URL = 'https://ai-gateway.vercel.sh/v1/evaluate'

export type Question =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'boolean'; instructions: string; criteria?: { true?: string; false?: string } }

export interface Answer {
  type: 'choice' | 'score' | 'boolean'
  choice?: string
  score?: number
  probability?: number
  probabilities?: Record<string, number>
  confidence?: number
}

export type JevAuth =
  /** AI Gateway API キーで直接呼ぶ */
  | { mode: 'key'; apiKey: string }
  /** 認証をサーバー側で付与するプロキシ経由（例: Vite dev proxy）。url は /v1/evaluate 相当のフル URL */
  | { mode: 'proxy'; url: string }
  /** API を呼ばず一様乱数で答える。avoidKeys の選択肢は低確率にする（例: ゲームの「戻る」） */
  | { mode: 'mock'; avoidKeys?: string[] }

export class JevError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message)
  }
}

export interface EvaluateOptions {
  signal?: AbortSignal
  /** リトライ待機のたびに呼ばれる。UI に「混雑中・再試行中」を出すため */
  onRetry?: (info: { attempt: number; waitMs: number; status: number }) => void
  /** 最大試行回数。代替の判断役がある場合は小さくして早めに切り替える */
  maxAttempts?: number
  /** 共有の待機がこれより長ければ待たずに失敗させる（代替の判断役へ早く切り替えるため） */
  maxWaitMs?: number
  /** 1 リクエストの打ち切り時間（既定 20 秒） */
  timeoutMs?: number
  /** 流量制御を共有する単位。既定は defaultGate（プロセス / Worker 内で 1 つ） */
  gate?: JevGate
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  /** AI Gateway が返す定価ベースの料金（USD）。無い場合は公表単価からの概算 */
  costUsd: number
}

export interface EvaluateResponse {
  answers: Record<string, Answer>
  usage: Usage
}

/** 公表単価 $0.042 / 1M 入力トークン（出力は課金なし）。Gateway が料金を返さない場合の概算用 */
const PRICE_PER_INPUT_TOKEN = 0.042 / 1_000_000
// 送信ペースと待機は gate が制御するので、混雑が続いても一時停止しにくいよう多めにする
const MAX_ATTEMPTS = 20

/** 実測（2026-09）で応答が返らず固まる呼び出しがあった（成功時の p90 は 0.5 秒）ため、打ち切って再試行する */
const DEFAULT_TIMEOUT_MS = 20000

/** プロセス / Worker 内の全 JEV 呼び出しで共有する流量制御。UI は subscribe して待機状況を表示する */
export const defaultGate = new JevGate(3)

export async function evaluate(
  auth: JevAuth,
  state: unknown,
  questions: Record<string, Question>,
  opts: EvaluateOptions = {},
): Promise<EvaluateResponse> {
  if (auth.mode === 'mock') return { answers: await mockEvaluate(questions, auth.avoidKeys ?? []), usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }
  const gate = opts.gate ?? defaultGate
  const url = auth.mode === 'key' ? GATEWAY_EVALUATE_URL : auth.url
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (auth.mode === 'key') headers.authorization = `Bearer ${auth.apiKey}`
  const body = JSON.stringify({
    model: JEV_MODEL,
    state,
    questions,
    // zeroDataRetention は Vercel Pro 以上限定で Hobby だと 403 になるため指定しない
  })

  for (let attempt = 1; ; attempt++) {
    try {
      await gate.acquire(opts.signal, opts.maxWaitMs)
    } catch (e) {
      if (e instanceof GateWaitTooLongError) throw new JevError(e.message, 429, true)
      throw e
    }
    let res: Response
    try {
      const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      res = await fetch(url, { method: 'POST', headers, body, signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout })
    } catch (e) {
      gate.release()
      if (opts.signal?.aborted) throw e
      // ネットワーク断・時間切れは一時的なことが多いのでリトライ対象
      res = new Response(null, { status: 599 })
    }
    if (res.ok) {
      const json = await res.json().finally(() => gate.release())
      gate.onSuccess()
      return { answers: normalize(json), usage: extractUsage(json) }
    }
    if (res.status !== 599) gate.release()
    const shouldRetryHeader = res.headers.get('x-should-retry')
    const retryable =
      shouldRetryHeader === 'true' ||
      (shouldRetryHeader !== 'false' && (res.status === 429 || res.status >= 500 || res.status === 408))
    const msg = await res.text().catch(() => '')
    if (!retryable) throw new JevError(`JEV ${res.status}: ${extractMessage(msg)}`, res.status, false)
    const ra = Number(res.headers.get('retry-after'))
    // 1 件の失敗で全員を待たせる。次の試行は acquire() が共有の待機時刻まで止める
    const waitMs = gate.onTransientFailure(res.status, ra > 0 ? ra * 1000 : null)
    if (attempt >= (opts.maxAttempts ?? MAX_ATTEMPTS)) throw new JevError(`JEV ${res.status}: ${extractMessage(msg)}`, res.status, true)
    opts.onRetry?.({ attempt, waitMs, status: res.status })
  }
}

function extractUsage(json: any): Usage {
  const inputTokens = Number(json.usage?.inputTokens ?? 0)
  const outputTokens = Number(json.usage?.outputTokens ?? 0)
  const market = Number(json.providerMetadata?.gateway?.marketCost)
  return { inputTokens, outputTokens, costUsd: market > 0 ? market : inputTokens * PRICE_PER_INPUT_TOKEN }
}

function extractMessage(text: string): string {
  try {
    return JSON.parse(text).error?.message ?? text
  } catch {
    return text.slice(0, 200)
  }
}

function normalize(json: any): Record<string, Answer> {
  const conf = json.providerMetadata?.typesafe?.confidence ?? {}
  const out: Record<string, Answer> = {}
  for (const [k, v] of Object.entries<any>(json.answers ?? {})) out[k] = { ...v, confidence: v.confidence ?? conf[k] }
  return out
}

/** 開発・テスト用。API を消費せずに動作確認するため、一様乱数で答える */
function mockEvaluate(questions: Record<string, Question>, avoidKeys: string[]): Promise<Record<string, Answer>> {
  const out: Record<string, Answer> = {}
  for (const [k, q] of Object.entries(questions)) {
    if (q.type === 'choice') {
      const keys = Object.keys(q.criteria)
      // 避けたい選択肢（例: 「戻る」）ばかり選ばれると動作確認にならないので低確率にする
      const preferred = keys.filter((x) => !avoidKeys.includes(x))
      const pool = preferred.length && Math.random() < 0.95 ? preferred : keys
      const choice = pool[Math.floor(Math.random() * pool.length)]
      out[k] = { type: 'choice', choice, probabilities: { [choice]: 1 }, confidence: 0 }
    } else if (q.type === 'score') {
      const score = Math.floor(Math.random() * q.criteria.length)
      out[k] = { type: 'score', score, probabilities: { [String(score)]: 1 } }
    } else {
      out[k] = { type: 'boolean', probability: Math.random() }
    }
  }
  return new Promise((r) => setTimeout(() => r(out), 150 + Math.random() * 300))
}
