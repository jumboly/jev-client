/**
 * typesafe 経路（TypeSafe の直接 API）がドキュメントどおりの形かを実 API で確かめる。
 * 実装はドキュメントに合わせただけなので、形の違いを見つけるために生の応答をそのまま出す。
 *   npx tsx scripts/verify-typesafe.ts
 * 送信は 4 回（少額）。キーは .env の TYPESAFE_API_KEY。
 */
import { evaluate, JevGate, TYPESAFE_EVALUATE_URL, TYPESAFE_MODEL } from '../src/index.js'

try {
  process.loadEnvFile('.env')
} catch {
  /* 環境変数を使う */
}
const key = process.env.TYPESAFE_API_KEY
if (!key) throw new Error('TYPESAFE_API_KEY がありません（.env に書くこと）')

const state = { article: '大阪府', goal: '大坂城から半径 2km 以内' }
const questions = {
  next: { type: 'choice', instructions: 'ゴールに近づくリンクを選べ', criteria: { L1: '大阪市', L2: '近畿地方', L3: '1868年' } },
  dist: { type: 'score', instructions: 'ゴールまでの近さ', criteria: ['遠い', 'やや遠い', 'やや近い', '近い'] },
  near: { type: 'noul', instructions: 'この記事はゴールの範囲内の場所か' },
}

// 流量制御の判断に使うヘッダと、ブラウザから直接呼べるかに関わるヘッダ
const HEADERS = ['retry-after', 'x-should-retry', 'access-control-allow-origin', 'access-control-allow-headers', 'access-control-expose-headers', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']

function pickHeaders(res: Response) {
  const out: Record<string, string> = {}
  for (const h of HEADERS) {
    const v = res.headers.get(h)
    if (v != null) out[h] = v
  }
  return out
}

async function raw(label: string, body: unknown) {
  const res = await fetch(TYPESAFE_EVALUATE_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', origin: 'https://example.com' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let json: unknown = text
  try {
    json = JSON.parse(text)
  } catch {
    /* JSON 以外はそのまま出す */
  }
  console.log(`\n## ${label}: ${res.status}`)
  console.log('headers:', pickHeaders(res))
  console.log(JSON.stringify(json, null, 2))
}

// 1. ドキュメントどおりの形（choice / score / noul）
await raw('生の応答（choice / score / noul）', { model: TYPESAFE_MODEL, state, questions })

// 2. gateway と同じ呼び名 boolean を受け付けるか（受け付けるなら変換が不要になる）
await raw('type: boolean を送った場合', { model: TYPESAFE_MODEL, state, questions: { near: { ...questions.near, type: 'boolean' } } })

// 3. ブラウザからのプリフライトに応じるか（CORS）
const pre = await fetch(TYPESAFE_EVALUATE_URL, {
  method: 'OPTIONS',
  headers: { origin: 'https://example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
})
console.log(`\n## CORS プリフライト: ${pre.status}`)
console.log('headers:', pickHeaders(pre))

// 4. クライアント経由で、gateway と同じ形に揃うか
const r = await evaluate(
  { mode: 'typesafe', apiKey: key },
  state,
  {
    next: { type: 'choice', instructions: questions.next.instructions, criteria: questions.next.criteria },
    dist: { type: 'score', instructions: questions.dist.instructions, criteria: questions.dist.criteria },
    near: { type: 'boolean', instructions: questions.near.instructions },
  },
  { gate: new JevGate(1), maxAttempts: 3 },
)
console.log('\n## クライアント経由（evaluate）')
console.log(JSON.stringify(r, null, 2))
