#!/usr/bin/env node
/**
 * JEV（AI Gateway）のエラー傾向を実測する（ゲートを通さず生の応答を記録）。
 * 429/503 の傾向（上限の値・連続性・retry-after の意味）は時期で変わり得るので、判断の前にこれで再計測する。
 *   npm run probe -- --mode gateway --minutes 6 --interval 1000 --burst 4 --out .cache/probe.jsonl
 *   npm run probe -- --mode typesafe                                 # TypeSafe の直接 API（TYPESAFE_API_KEY）
 *   npm run probe -- --mode gateway --url https://my-proxy/v1/evaluate  # 透過プロキシ経由（キーはプロキシ側が付与するなら不要）
 * 経路ごとに傾向が違い得るので、実際に使う経路で計測すること。
 * 1 行 1 リクエストの JSONL: 送信時刻・バースト番号・HTTP ステータス・retry-after・所要時間・
 * Gateway 内部のプロバイダ試行（digitalocean → typesafe-ai のフォールバック等）。
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'
import { GATEWAY_EVALUATE_URL, JEV_MODEL, TYPESAFE_EVALUATE_URL, TYPESAFE_MODEL } from './client.js'

const { values: a } = parseArgs({
  options: {
    minutes: { type: 'string', default: '6' },
    interval: { type: 'string', default: '1000' },
    // 1 回に同時に送る数（複数の呼び出し元の同時実行を模す）
    burst: { type: 'string', default: '4' },
    out: { type: 'string', default: '.cache/probe.jsonl' },
    // 経路で傾向が違い得るので、どの経路を測るかは毎回明示させる
    mode: { type: 'string' },
    url: { type: 'string' },
  },
})
if (a.mode !== 'gateway' && a.mode !== 'typesafe') throw new Error(`--mode gateway か --mode typesafe を指定すること（指定: ${a.mode ?? 'なし'}）`)
const gateway = a.mode === 'gateway'

try {
  process.loadEnvFile('.env')
} catch {
  /* 環境変数を使う */
}
const keyName = gateway ? 'AI_GATEWAY_API_KEY' : 'TYPESAFE_API_KEY'
const key = process.env[keyName]
// 透過プロキシがキーを付与する構成もあるため、url 指定時はキー無しを許す
if (!key && !a.url) throw new Error(`${keyName} がありません`)
const url = a.url ?? (gateway ? GATEWAY_EVALUATE_URL : TYPESAFE_EVALUATE_URL)

const body = JSON.stringify({
  model: gateway ? JEV_MODEL : TYPESAFE_MODEL,
  state: { goal: '大坂城周辺（半径2km）', currentArticle: '大阪府' },
  questions: { move: { type: 'choice', instructions: 'ゴールに近づくリンクを選べ', criteria: { L1: '大阪市', L2: '近畿地方', L3: '1868年' } } },
})

async function one(burst: number, idx: number) {
  const t = Date.now()
  let status = 0
  let retryAfter: string | null = null
  let retryAfterMs: string | null = null
  let shouldRetry: string | null = null
  let providers: unknown = null
  let error: string | undefined
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...(key && { authorization: `Bearer ${key}` }), 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(30000),
    })
    status = res.status
    retryAfter = res.headers.get('retry-after')
    retryAfterMs = res.headers.get('retry-after-ms')
    shouldRetry = res.headers.get('x-should-retry')
    const json: any = await res.json().catch(() => null)
    providers = json?.providerMetadata?.gateway?.routing?.modelAttempts?.[0]?.providerAttempts?.map((p: any) => `${p.provider}:${p.statusCode ?? (p.success ? 200 : '?')}`)
    if (!res.ok) error = (json?.error?.message ?? json?.detail?.message ?? JSON.stringify(json?.detail ?? null))?.slice(0, 120)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  const rec = { t, burst, idx, status, ms: Date.now() - t, retryAfter, retryAfterMs, shouldRetry, providers, error }
  await appendFile(a.out!, JSON.stringify(rec) + '\n')
  return rec
}

async function main() {
  await mkdir(dirname(a.out!), { recursive: true })
  const end = Date.now() + Number(a.minutes) * 60000
  const n = Number(a.burst)
  for (let b = 0; Date.now() < end; b++) {
    const start = Date.now()
    const recs = await Promise.all(Array.from({ length: n }, (_, i) => one(b, i)))
    console.log(`#${b} ${recs.map((r) => r.status + (r.retryAfter ? `(ra${r.retryAfter})` : '')).join(' ')}`)
    const wait = Number(a.interval) - (Date.now() - start)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
