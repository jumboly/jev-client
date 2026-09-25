# @jumboly/jev-client

TypeSafe AI の意思決定モデル **Jev** を呼ぶための TypeScript クライアント。

- **2 つの経路に対応**: Vercel AI Gateway 経由と TypeSafe AI の直接 API。URL を差し替えて透過プロキシ経由でも呼べる
- **混雑に強い**: 429/503 を受けたら全呼び出しで待機を共有し、同時実行数と送信ペースを自動で落とす。時間切れ・再試行も込み
- **開発しやすい**: 録画再生・ダミーの判断役に差し替えられ、API を消費せずに動作確認できる
- ブラウザ（Web Worker 含む）と Node（20.12 以上）で動く。ESM のみ

## インストール

npm には公開していないので、GitHub から入れる（インストール時に `dist/` がビルドされる）。

```sh
npm install github:jumboly/jev-client          # 最新
npm install github:jumboly/jev-client#v0.1.0   # バージョンを固定
```

## クイックスタート

```ts
import { evaluate } from '@jumboly/jev-client'

const { answers, usage } = await evaluate(
  { mode: 'gateway', apiKey: process.env.AI_GATEWAY_API_KEY },
  { article: '大阪府', goal: '大坂城から半径 2km 以内' }, // state: 判断の材料（文字列・オブジェクト・配列）
  {
    next: { type: 'choice', instructions: 'ゴールに近づくリンクを選べ', criteria: { L1: '大阪市', L2: '近畿地方', L3: '1868年' } },
    near: { type: 'boolean', instructions: 'ゴールに近いか' },
  },
)

answers.next.choice // 'L1'
answers.next.probabilities // { L1: 0.82, L2: 0.15, L3: 0.03 }
answers.near.probability // 0.64
usage.costUsd // 0.0000168
```

## 経路を選ぶ（`JevAuth`）

`mode` は必須。経路ごとに形式・料金・混雑の傾向が違うため、既定の経路は持たない。

```ts
{ mode: 'gateway', apiKey }                                    // Vercel AI Gateway
{ mode: 'typesafe', apiKey }                                   // TypeSafe AI の直接 API
{ mode: 'gateway', url: '/dev-jev/v1/evaluate' }               // 透過プロキシ（キーはプロキシ側で付与）
{ mode: 'typesafe', url: 'https://my-proxy.example/jev', apiKey } // 透過プロキシ（キーを素通し）
{ mode: 'mock', avoidKeys: ['BACK'] }                          // API を呼ばず乱数で答える（開発用）
```

| `mode` | 既定の URL | キー | ブラウザから直接 | 備考 |
|---|---|---|---|---|
| `gateway` | `https://ai-gateway.vercel.sh/v1/evaluate` | `AI_GATEWAY_API_KEY` | 呼べる | 料金が返る |
| `typesafe` | `https://api.typesafe.ai/v1/systemone` | `TYPESAFE_API_KEY` | **呼べない**（CORS 不可） | 料金は返らないので概算になる |

- `url` を指定すると、その経路の形式のまま指定先へ送る。`apiKey` を省くと `Authorization` を付けない。
- 経路による形式の違い（モデル名、boolean の呼び名、usage のキー名）はクライアントが吸収する。回答はどちらの経路でも同じ形で返る。
- ブラウザから `typesafe` を使うときは、CORS の応答を返す透過プロキシを `url` に指定する。プロキシは事前確認（`OPTIONS`）に答え、応答ヘッダを公開する（`Access-Control-Expose-Headers`）必要がある。公開されていないと、`retry-after` などの待機時間の指示を読めない。
- CORS で拒否されると、ブラウザはネットワーク断と同じエラーを返すので、クライアントは 599 として再試行する。
- ブラウザでキーを扱うときは、利用者自身のキーをブラウザ内にだけ保存する。開発中は dev サーバーの透過プロキシでキーを付与すれば、バンドルにキーが入らない。

## 質問と回答

| 質問の `type` | `criteria` | 回答 |
|---|---|---|
| `choice` | `{ キー: 説明 }`（最大 255 個） | `choice`（選ばれたキー）、`probabilities`、`confidence` |
| `score` | `[段階の説明, …]`（2〜10 段階） | `score`（段階間の連続値）、`probabilities`（キーは `"0"`, `"1"`, …）、`confidence`、`legend`（typesafe 経路のみ。段階番号 → 説明） |
| `boolean` | `{ true?, false? }`（省略可） | `probability`（真である確率） |

- `instructions` に判断の指示を書く。state は 32k トークンまで。
- 上限を超えた質問はサーバーが 4xx で拒否する（送信前にはチェックしない）。

戻り値:

```ts
{
  answers: Record<string, Answer>
  usage: { inputTokens: number; outputTokens: number; costUsd: number } // 出力は課金なし
  provider?: 'gateway' | 'typesafe' // 実際に呼んだ経路（mock では無し）
}
```

`costUsd` は、gateway では AI Gateway が返す定価ベースの料金。typesafe では、AI Gateway の公表単価（$0.042 / 100 万入力トークン）から出した概算。

## オプションとエラー

```ts
await evaluate(auth, state, questions, {
  signal,         // AbortSignal。中断したら再試行せずに投げる
  timeoutMs,      // 1 リクエストの打ち切り（既定 20 秒）。打ち切ったら再試行する
  maxAttempts,    // 最大試行回数（既定 20）
  maxWaitMs,      // 共有の待機がこれより長ければ待たずに失敗させる（代替へ早く切り替えたいとき）
  onRetry,        // ({ attempt, waitMs, status }) => void。UI に「混雑中・再試行中」を出す
  gate,           // 流量制御を差し替える（後述）
})
```

失敗すると `JevError`（`status`、`retryable`）を投げる。

| 状況 | 挙動 |
|---|---|
| 429 / 5xx / 408 / ネットワーク断・時間切れ | `retry-after-ms` か `retry-after`（無ければ指数バックオフ）を待って再試行。回数を使い切ったら `retryable: true` で投げる。時間切れ・ネットワーク断の `status` は 599 |
| 400 / 401 / 403 / 422 などその他の 4xx | 再試行せずに `retryable: false` で投げる（typesafe 経路は質問の形が不正だと 400） |
| `x-should-retry` ヘッダがある | その指示に従う |
| 共有の待機が `maxWaitMs` を超える | 送信せずに `status: 429`・`retryable: true` で投げる |

`isRecoverable(e)` で、再試行や代替で回復し得る失敗かを判定できる。

## 流量制御（`JevGate`）

同じプロセス（ブラウザでは同じ Worker）の呼び出しは、経路ごとに流量制御を共有する。

- 1 件でも 429/503 を受けたら、同じ経路の全呼び出しが `retry-after` まで待つ（混雑中に叩き続けないため）。
- 失敗で同時実行数を半減し、成功が続けば 1 ずつ戻す（既定の上限 3）。
- 1 分あたりの送信上限は既定で auto。普段は上限なしで、429 を受けたときだけ直近の成功数から上限を学習し、429 が止めば徐々に解除する。

```ts
import { defaultGate, defaultGates, JevGate } from '@jumboly/jev-client'

// 待機状況を UI に出す（defaultGate は defaultGates.gateway と同じもの）
defaultGates.gateway.subscribe((s) => render(s.cooldownUntil, s.concurrency, s.ratePerMin, s.inFlight))

defaultGate.configure({ ratePerMin: 30 }) // 上限を固定（manual）
defaultGate.configure({ ratePerMin: 0 })  // auto に戻す

// 同じ上流へ向かう複数のプロキシで待機を共有したい、テストで分離したい、などのときは gate を渡す
const shared = new JevGate(3)
await evaluate(authA, state, questions, { gate: shared })
```

## 判断役（`Evaluator`）の差し替え

アプリは `evaluate()` を直接呼ぶ代わりに `Evaluator` を通すと、JEV・録画・ダミーを差し替えたりつないだりできる。

```ts
import { jevEvaluator, mockEvaluator, replayEvaluator, recording, withFallback, memoryStore } from '@jumboly/jev-client'
import { fileStore } from '@jumboly/jev-client/node' // Node のみ: 録画を JSON ファイルに保存

const store = await fileStore('.cache/recordings.json') // ブラウザやテストでは memoryStore()
const jev = recording(jevEvaluator(auth), store)         // JEV の回答を録画しながら使う

// JEV が失敗したら録画 → ダミーの順に代わりに答える（開発・テスト用）
const ev = withFallback(jev, replayEvaluator(store), mockEvaluator({ avoidKeys: ['BACK'] }))

const r = await ev(state, questions)
r.source   // 'jev' | 'replay' | 'mock'  … 誰が答えたか
r.provider // 'gateway' | 'typesafe'     … source が 'jev' のときの経路
r.usage    // source が 'jev' のときのみ
```

- 録画のキーは state と質問の内容から作るので、同じ局面なら経路によらず再生できる。録画に無い局面では `replayEvaluator` が `ReplayMissError` を投げる。
- **録画やダミーの回答は JEV の判断ではない。** 本番で `withFallback` を使う場合は `source` を見て区別し、JEV の結果として扱わないこと。
- `jevEvaluator(auth, { gate })` で、その Evaluator が使う流量制御を固定できる。

## 混雑の傾向を測る（`jev-probe`）

流量制御を通さずに一定間隔で送り、生の応答（ステータス、`retry-after`、所要時間）を JSONL に記録する。混雑の傾向は時期によって変わるので、上限などを判断する前に測り直すこと。少量なら料金は 1 円未満。

```sh
# キーは実行ディレクトリの .env（AI_GATEWAY_API_KEY / TYPESAFE_API_KEY）か環境変数から読む
npx jev-probe --mode gateway --minutes 1 --interval 2000 --burst 2
npx jev-probe --mode typesafe --minutes 1 --burst 1
npx jev-probe --mode gateway --url https://my-proxy.example/v1/evaluate   # プロキシがキーを付けるならキー不要
```

| オプション | 既定 | 内容 |
|---|---|---|
| `--mode` | （必須） | `gateway` / `typesafe` |
| `--url` | 経路の公式 URL | 送信先 |
| `--minutes` | 6 | 計測時間 |
| `--interval` | 1000 | 送信間隔（ミリ秒） |
| `--burst` | 4 | 1 回に同時に送る数 |
| `--out` | `.cache/probe.jsonl` | 出力先 |

これまでの計測結果: [docs/probe-results.md](docs/probe-results.md)

## 注意点

- OpenAI 互換の API からは呼べない（evaluate 系の専用 API を使う）。
- AI Gateway の `zeroDataRetention` は Vercel Pro 以上限定で、Hobby では 403 になる。このクライアントは指定しない。

## 開発

```sh
npm install
npm test            # vitest
npm run typecheck
npm run build       # dist/ を出力
npm run probe -- --mode gateway --minutes 1   # ソースから jev-probe を実行（.env が必要）
npx tsx scripts/verify-typesafe.ts             # typesafe 経路の生の応答・CORS・変換結果を確かめる（4 回送信）
```

並行して開発しながら別プロジェクトで使うときは、利用側で `npm install ../jev-client` を実行する。symlink になるので、こちらで先に `npm run build` しておくこと。
