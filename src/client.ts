import { GateWaitTooLongError, JevGate } from './gate.js'

/**
 * JEV を呼ぶ。経路は 2 つあり、URL・モデル名・質問/回答の形が異なるため、ここで吸収する。
 *  - gateway: Vercel AI Gateway のネイティブ HTTP API（/v1/evaluate）。CORS を許可しており、
 *    ブラウザからユーザー自身のキーで直接呼べる。料金（marketCost）も返る
 *  - typesafe: TypeSafe AI の API を直接（/v1/systemone）。boolean は "noul"、usage は snake_case
 * どちらも url を差し替えれば透過プロキシ（開発時の dev サーバーや、キーを付与する中継）経由で呼べる。
 * 回答は常に gateway 形式（boolean は probability）へ揃えるので、利用側と録画は経路に依存しない。
 */

export const JEV_MODEL = 'typesafe-ai/jev'
export const GATEWAY_EVALUATE_URL = 'https://ai-gateway.vercel.sh/v1/evaluate'
export const TYPESAFE_MODEL = 'jev-latest'
export const TYPESAFE_EVALUATE_URL = 'https://api.typesafe.ai/v1/systemone'

export type Question =
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'boolean'; instructions: string; criteria?: { true?: string; false?: string } }

export interface ChoiceAnswer<K extends string = string> {
  type: 'choice'
  choice: K
  probabilities: Record<K, number>
  confidence?: number
}

export interface ScoreAnswer {
  type: 'score'
  /** 段階間の連続値（0 〜 段階数 - 1） */
  score: number
  /** キーは段階番号（"0", "1", …） */
  probabilities: Record<string, number>
  confidence?: number
  /** typesafe 経路でのみ返る。段階番号 → criteria の説明 */
  legend?: Record<string, string>
}

export interface BooleanAnswer {
  type: 'boolean'
  /** 真である確率 */
  probability: number
}

export type Answer = ChoiceAnswer | ScoreAnswer | BooleanAnswer

/**
 * 質問 1 つに対する回答の型。choice は criteria のキーを選択肢の型にする。
 * T を裸で使って union に分配させる（既定の Record<string, Question> では Answer 全体になる）
 */
export type AnswerOf<T extends Question> = T extends { type: 'choice'; criteria: infer C }
  ? ChoiceAnswer<Extract<keyof C, string>>
  : T extends { type: 'score' }
    ? ScoreAnswer
    : BooleanAnswer

/** 質問の集まりに対する回答の型。利用側で undefined の確認や型の絞り込みを書かずに済むよう、質問の形から決める */
export type AnswersOf<Q extends Record<string, Question>> = { [K in keyof Q]: AnswerOf<Q[K]> }

export type JevProvider = 'gateway' | 'typesafe'

export type JevAuth =
  /**
   * JEV を HTTP で呼ぶ。経路で形式が変わるため mode は省略できない（既定の経路は持たない）。url を省略すると mode の公式エンドポイント。
   * apiKey を省略すると Authorization を付けない（認証を付与する透過プロキシ経由の場合）
   */
  | { mode: JevProvider; apiKey?: string; url?: string }
  /** API を呼ばず一様乱数で答える。avoidKeys の選択肢は低確率にする（例: 「戻る」のような、選ばれ続けると動作確認にならない選択肢） */
  | { mode: 'mock'; avoidKeys?: string[] }

export class JevError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message)
    // ログや console で Error ではなく JevError と表示されるようにする
    this.name = 'JevError'
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
  /**
   * 流量制御を共有する単位。既定は経路ごとの defaultGates[mode]。
   * 透過プロキシの先が同じ上流なら、同じ gate を渡して待機を共有させる
   */
  gate?: JevGate
}

export interface Usage {
  inputTokens: number
  outputTokens: number
  /** AI Gateway が返す定価ベースの料金（USD）。無い場合は公表単価からの概算 */
  costUsd: number
}

export interface EvaluateResponse<Q extends Record<string, Question> = Record<string, Question>> {
  answers: AnswersOf<Q>
  usage: Usage
  /** 実際に呼んだ経路。mock では無し。経路で結果や料金（typesafe は概算）が違い得るので、後から区別できるようにする */
  provider?: JevProvider
}

/**
 * AI Gateway の公表単価 $0.042 / 1M 入力トークン（出力は課金なし）。料金が返らない場合（TypeSafe の直接 API など）の概算用。
 * 直接 API の単価は未確認のため、あくまで目安
 */
const PRICE_PER_INPUT_TOKEN = 0.042 / 1_000_000
// 送信ペースと待機は gate が制御するので、混雑が続いても一時停止しにくいよう多めにする
const MAX_ATTEMPTS = 20

/** 実測（2026-09）で応答が返らず固まる呼び出しがあった（成功時の p90 は 0.5 秒）ため、打ち切って再試行する */
const DEFAULT_TIMEOUT_MS = 20000

/**
 * 一度も HTTP 応答を得ていない URL への接続失敗は、この回数で打ち切る。
 * CORS による拒否や URL の誤りは再試行しても直らないが、ブラウザではネットワーク断と区別できないため、
 * MAX_ATTEMPTS まで待機を伸ばしながら続けると、設定の誤りに気付くまで数分かかる
 */
const UNREACHED_MAX_ATTEMPTS = 3
/** HTTP 応答（ステータスを問わない）を一度でも受け取った URL。届くと分かっている URL の接続失敗は一時的とみなす */
const reachedUrls = new Set<string>()

/**
 * プロセス / Worker 内の JEV 呼び出しで共有する流量制御。UI は subscribe して待機状況を表示する。
 * 経路ごとに回数上限も障害も別なので分ける（片方の 429 で空いている経路まで止めないため）
 */
export const defaultGates: Record<JevProvider, JevGate> = { gateway: new JevGate(3), typesafe: new JevGate(3) }
/** gateway 経路の既定の流量制御（defaultGates.gateway と同じもの） */
export const defaultGate = defaultGates.gateway

export async function evaluate<Q extends Record<string, Question>>(
  auth: JevAuth,
  state: unknown,
  questions: Q,
  opts: EvaluateOptions = {},
): Promise<EvaluateResponse<Q>> {
  if (auth.mode === 'mock') return { answers: (await mockEvaluate(questions, auth.avoidKeys ?? [])) as AnswersOf<Q>, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } }
  const { provider, url, apiKey } = resolveEndpoint(auth)
  const gate = opts.gate ?? defaultGates[provider]
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey) headers.authorization = `Bearer ${apiKey}`
  const body = JSON.stringify(
    provider === 'gateway'
      ? // zeroDataRetention は Vercel Pro 以上限定で Hobby だと 403 になるため指定しない
        { model: JEV_MODEL, state, questions }
      : { model: TYPESAFE_MODEL, state, questions: toTypesafeQuestions(questions) },
  )

  for (let attempt = 1; ; attempt++) {
    try {
      await gate.acquire(opts.signal, opts.maxWaitMs)
    } catch (e) {
      if (e instanceof GateWaitTooLongError) throw new JevError(e.message, 429, true)
      throw e
    }
    let res: Response
    // 599（接続できなかった）の理由。サーバーの本文が無いので、代わりにこれをメッセージにする
    let connectError: { reason: string; timedOut: boolean } | undefined
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const timeout = AbortSignal.timeout(timeoutMs)
    try {
      res = await fetch(url, { method: 'POST', headers, body, signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout })
      reachedUrls.add(url)
    } catch (e) {
      gate.release()
      if (opts.signal?.aborted) throw e
      // ネットワーク断・時間切れは一時的なことが多いのでリトライ対象。
      // CORS による拒否もブラウザではここに来る（fetch が TypeError になり、ネットワーク断と区別できない）
      connectError = timeout.aborted
        ? { reason: `時間切れ（${timeoutMs}ms 応答なし）`, timedOut: true }
        : { reason: `ネットワーク断または CORS による拒否（${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}）`, timedOut: false }
      res = new Response(null, { status: 599 })
    }
    if (res.ok) {
      const json = await res.json().finally(() => gate.release())
      gate.onSuccess()
      return { answers: normalize(json) as AnswersOf<Q>, usage: extractUsage(json), provider }
    }
    // 接続失敗は catch で解放済み。ステータスで判定すると、サーバーが本当に 599 を返したときに解放されず枠が減り続ける
    if (!connectError) gate.release()
    const shouldRetryHeader = res.headers.get('x-should-retry')
    const retryable =
      shouldRetryHeader === 'true' ||
      (shouldRetryHeader !== 'false' && (res.status === 429 || res.status >= 500 || res.status === 408))
    const msg = connectError?.reason ?? extractMessage(await res.text().catch(() => ''))
    if (!retryable) throw new JevError(`JEV ${res.status}: ${msg}`, res.status, false)
    // 1 件の失敗で全員を待たせる。次の試行は acquire() が共有の待機時刻まで止める
    const waitMs = gate.onTransientFailure(res.status, retryAfterMs(res.headers))
    const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS
    // 時間切れは相手に届いている可能性があるので、打ち切りの対象は接続そのものの失敗だけにする
    const unreached = connectError && !connectError.timedOut && !reachedUrls.has(url)
    if (unreached && attempt >= Math.min(maxAttempts, UNREACHED_MAX_ATTEMPTS))
      throw new JevError(`JEV ${res.status}: ${msg}。${url} からはまだ一度も応答が無いため ${attempt} 回で打ち切った（URL・CORS・ネットワークを確認すること）`, res.status, true)
    if (attempt >= maxAttempts) throw new JevError(`JEV ${res.status}: ${msg}`, res.status, true)
    opts.onRetry?.({ attempt, waitMs, status: res.status })
  }
}

function resolveEndpoint(auth: Exclude<JevAuth, { mode: 'mock' }>): { provider: JevProvider; url: string; apiKey?: string } {
  const url = auth.url ?? (auth.mode === 'gateway' ? GATEWAY_EVALUATE_URL : TYPESAFE_EVALUATE_URL)
  return { provider: auth.mode, url, apiKey: auth.apiKey }
}

/** TypeSafe の直接 API は boolean を "noul" と呼ぶ */
function toTypesafeQuestions(questions: Record<string, Question>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(questions).map(([k, q]) => [k, q.type === 'boolean' ? { ...q, type: 'noul' } : q]))
}

function extractUsage(json: any): Usage {
  // gateway は camelCase、TypeSafe の直接 API は snake_case
  const inputTokens = Number(json.usage?.inputTokens ?? json.usage?.input_tokens ?? 0)
  const outputTokens = Number(json.usage?.outputTokens ?? json.usage?.output_tokens ?? 0)
  const market = Number(json.providerMetadata?.gateway?.marketCost)
  return { inputTokens, outputTokens, costUsd: market > 0 ? market : inputTokens * PRICE_PER_INPUT_TOKEN }
}

/** typesafe 経路は秒単位の retry-after に加えてミリ秒単位の retry-after-ms も公開しているので、あれば精度の高い方を使う */
function retryAfterMs(headers: Headers): number | null {
  const ms = Number(headers.get('retry-after-ms'))
  if (ms > 0) return ms
  const sec = Number(headers.get('retry-after'))
  return sec > 0 ? sec * 1000 : null
}

function extractMessage(text: string): string {
  try {
    const json = JSON.parse(text)
    // gateway は { error: { message } }、typesafe は { detail: { message } }（FastAPI 形式で detail が文字列のこともある）
    const detail = json.detail
    const known = json.error?.message ?? detail?.message ?? (typeof detail === 'string' ? detail : undefined)
    if (known !== undefined) return known
  } catch {
    // JSON でなければ下で本文をそのまま使う
  }
  // 既知の形でない本文（HTML のエラーページなど）は長いことがあり、メッセージが読めなくなるので切る
  return text.slice(0, 200)
}

function normalize(json: any): Record<string, Answer> {
  const conf = json.providerMetadata?.typesafe?.confidence ?? {}
  const out: Record<string, Answer> = {}
  for (const [k, v] of Object.entries<any>(json.answers ?? {})) {
    // TypeSafe の直接 API の noul（{ type: 'noul', noul: 0..1 }）を gateway の boolean 形式に揃える
    const a = v.type === 'noul' ? (({ noul, ...rest }) => ({ ...rest, type: 'boolean', probability: noul }))(v) : v
    const confidence = a.confidence ?? conf[k]
    // 値が無いときにキーだけ足すと、console.log や JSON に confidence: undefined が出てしまう
    out[k] = confidence === undefined ? a : { ...a, confidence }
  }
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
      // 実際の応答と同じく全選択肢のキーを持たせる（利用側が probabilities[key] を undefined なしで読めるように）
      out[k] = { type: 'choice', choice, probabilities: Object.fromEntries(keys.map((x) => [x, x === choice ? 1 : 0])), confidence: 0 }
    } else if (q.type === 'score') {
      const score = Math.floor(Math.random() * q.criteria.length)
      out[k] = { type: 'score', score, probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), i === score ? 1 : 0])) }
    } else {
      out[k] = { type: 'boolean', probability: Math.random() }
    }
  }
  return new Promise((r) => setTimeout(() => r(out), 150 + Math.random() * 300))
}
