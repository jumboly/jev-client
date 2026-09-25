/**
 * JEV（AI Gateway）のエラー傾向を実測する（ゲートを通さず生の応答を記録）。
 * 429/503 の傾向（上限の値・連続性・retry-after の意味）は時期で変わり得るので、判断の前にこれで再計測する。
 *   npm run probe -- --minutes 6 --interval 1000 --burst 4 --out .cache/probe.jsonl
 * 1 行 1 リクエストの JSONL: 送信時刻・バースト番号・HTTP ステータス・retry-after・所要時間・
 * Gateway 内部のプロバイダ試行（digitalocean → typesafe-ai のフォールバック等）。
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'

const { values: a } = parseArgs({
  options: {
    minutes: { type: 'string', default: '6' },
    interval: { type: 'string', default: '1000' },
    // 1 回に同時に送る数（複数 Runner の同時実行を模す）
    burst: { type: 'string', default: '4' },
    out: { type: 'string', default: '.cache/probe.jsonl' },
  },
})

try {
  process.loadEnvFile('.env')
} catch {
  /* 環境変数を使う */
}
const key = process.env.AI_GATEWAY_API_KEY
if (!key) throw new Error('AI_GATEWAY_API_KEY がありません')

const body = JSON.stringify({
  model: 'typesafe-ai/jev',
  state: { goal: '大坂城周辺（半径2km）', currentArticle: '大阪府' },
  questions: { move: { type: 'choice', instructions: 'ゴールに近づくリンクを選べ', criteria: { L1: '大阪市', L2: '近畿地方', L3: '1868年' } } },
})

async function one(burst: number, idx: number) {
  const t = Date.now()
  let status = 0
  let retryAfter: string | null = null
  let shouldRetry: string | null = null
  let providers: unknown = null
  let error: string | undefined
  try {
    const res = await fetch('https://ai-gateway.vercel.sh/v1/evaluate', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(30000),
    })
    status = res.status
    retryAfter = res.headers.get('retry-after')
    shouldRetry = res.headers.get('x-should-retry')
    const json: any = await res.json().catch(() => null)
    providers = json?.providerMetadata?.gateway?.routing?.modelAttempts?.[0]?.providerAttempts?.map((p: any) => `${p.provider}:${p.statusCode ?? (p.success ? 200 : '?')}`)
    if (!res.ok) error = json?.error?.message?.slice(0, 120)
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }
  const rec = { t, burst, idx, status, ms: Date.now() - t, retryAfter, shouldRetry, providers, error }
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
