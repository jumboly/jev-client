# @jumboly/jev-client

TypeSafe AI の意思決定モデル **Jev** を呼ぶための TypeScript クライアント。

- **2 つの経路に対応**: Vercel AI Gateway 経由と TypeSafe AI の直接 API。URL を差し替えて透過プロキシ経由でも呼べる
- **混雑に強い**: 429/5xx などの一時的な失敗を受けたら全呼び出しで待機を共有し、同時実行数と送信ペースを自動で落とす。時間切れ・再試行も込み
- **開発しやすい**: 録画再生・ダミーの判断役に差し替えられ、API を消費せずに動作確認できる。ブラウザアプリ用の開発用透過プロキシも同梱
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
{ mode: 'typesafe', url: '/dev-jev/typesafe' }                 // 開発用の透過プロキシ（キーはプロキシ側で付与。下の「開発用の透過プロキシ」）
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
- CORS で拒否されると、ブラウザはネットワーク断と同じエラーを返す。そのため、一度も応答を得ていない URL への接続失敗は、3 回で打ち切るようにしている（下の「オプションとエラー」）。
- ブラウザでキーを扱うときは、利用者自身のキーをブラウザ内にだけ保存する。開発中は同梱の[開発用の透過プロキシ](#開発用の透過プロキシ)でキーを付与すれば、バンドルにキーが入らず、typesafe 経路もブラウザから呼べる。

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
  usage: { inputTokens: number; outputTokens: number; costUsd: number }
  provider?: 'gateway' | 'typesafe' // 実際に呼んだ経路（mock では無し）
}
```

`costUsd` は経路で意味が違う。

- gateway: AI Gateway が返す定価ベースの料金。AI Gateway では出力は課金なし。
- typesafe: 料金が返らないので、AI Gateway の公表単価（$0.042 / 100 万入力トークン）から出した概算。直接 API の単価と、出力（`outputTokens` は 0 でない値が返る）が課金されるかは未確認。

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
| 一度も HTTP 応答を得ていない URL への接続失敗（CORS による拒否、URL の誤りなど） | 3 回で打ち切り、`status: 599`・`retryable: true` で投げる。メッセージに URL と確認すべき点が入る |
| `x-should-retry` ヘッダがある | その指示に従う |
| 共有の待機が `maxWaitMs` を超える | 送信せずに `status: 429`・`retryable: true` で投げる |

`isRecoverable(e)` で、再試行や代替で回復し得る失敗かを判定できる。

## 流量制御（`JevGate`）

同じプロセス（ブラウザでは同じ Worker）の呼び出しは、経路ごとに流量制御を共有する。

- 1 件でも再試行対象の失敗（429 / 5xx / 408 / ネットワーク断・時間切れ）を受けたら、同じ経路の全呼び出しが `retry-after`（無ければ指数バックオフ）まで待つ（混雑中に叩き続けないため）。
- 同じ失敗で同時実行数を半減し、成功が 5 回続くごとに 1 ずつ戻す。
- 1 分あたりの送信上限は既定で auto。普段は上限なしで、429 を受けたときだけ直近の成功数から上限を学習し、429 が止めば徐々に解除する。

`new JevGate(maxConcurrency)` の引数は同時実行数の上限（`defaultGates` はどちらも 3）。

```ts
import { defaultGate, defaultGates, JevGate } from '@jumboly/jev-client'

// 待機状況を UI に出す（defaultGate は defaultGates.gateway と同じもの）
defaultGates.gateway.subscribe((s) => render(s.cooldownUntil, s.concurrency, s.ratePerMin, s.inFlight))

defaultGate.configure({ ratePerMin: 30 }) // 上限を固定（manual）
defaultGate.configure({ ratePerMin: 0 })  // auto に戻す

// 同じ上流へ向かう複数のプロキシで待機を共有したい、テストで分離したい、などのときは gate を渡す
const shared = new JevGate(3) // 同時実行数の上限 3
await evaluate(authA, state, questions, { gate: shared })
```

`subscribe` に渡される状態（`GateState`）:

| 項目 | 内容 |
|---|---|
| `cooldownUntil` | この時刻（epoch ミリ秒）まで全呼び出しを止める。0 なら待機なし |
| `concurrency` | 今の同時実行数の上限（失敗で半減し、成功で戻る） |
| `maxConcurrency` | `concurrency` が戻る上限（コンストラクタの引数） |
| `inFlight` | 送信中の数 |
| `consecutiveFailures` | 連続した失敗の数（指数バックオフに使う） |
| `lastStatus` | 最後に失敗したときのステータス（接続失敗は 599） |
| `rateMode` | `'auto'`（429 のときだけ学習）/ `'manual'`（`configure` で固定） |
| `ratePerMin` | 1 分あたりの送信上限。0 なら上限なし |
| `sentLastMinute` | 直近 60 秒の送信数 |
| `rateWaitUntil` | 回数上限のため、この時刻（epoch ミリ秒）まで次の送信を待っている。0 なら待機なし |

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

## 開発用の透過プロキシ

ブラウザアプリの開発中に、Node 側で API キーを付けて JEV へ中継する。キーはブラウザにもバンドルにも入らない。CORS に答えるので、ブラウザから直接呼べない typesafe 経路も使える。

**開発時の動作確認専用。** キーを持つ中継なので、届く範囲の誰でもそのキーで JEV を呼べてしまう。そのため、次のようにしている。

- Vite プラグインは dev サーバー（`vite` / `vite dev`）でだけ有効になり、`vite build` / `vite preview` には入らない。
- 単体サーバーは既定で `127.0.0.1` だけで待ち受ける。
- どちらも、localhost（`localhost` / `127.0.0.1` / `[::1]` / `*.localhost`）以外の `Origin` からのリクエストは 403 で拒否する。他のサイトを開いたブラウザから、裏で送られるのを防ぐため。

キーは、`apiKey` → 環境変数 → `.env` の順に探す（`AI_GATEWAY_API_KEY` / `TYPESAFE_API_KEY`）。見つからなければ、ブラウザから来た `Authorization` をそのまま中継する。

### Vite

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { jevDevProxy } from '@jumboly/jev-client/node'

export default defineConfig({
  plugins: [jevDevProxy({ mode: 'typesafe' })], // /dev-jev/typesafe に置く。キーは envDir（無ければ root）の .env から
})
```

```ts
// アプリ側: 開発中はプロキシ、本番は利用者のキーで gateway を直接呼ぶ
const auth: JevAuth = import.meta.env.DEV
  ? { mode: 'typesafe', url: '/dev-jev/typesafe' }
  : { mode: 'gateway', apiKey: userKey }
```

### 単体サーバー（Vite 以外の dev サーバー、静的ファイルなど）

```sh
npx jev-proxy --mode typesafe   # http://127.0.0.1:8787 で待ち受ける（パスは問わない）
```

```ts
evaluate({ mode: 'typesafe', url: 'http://127.0.0.1:8787' }, state, questions)
```

| オプション | 既定 | 内容 |
|---|---|---|
| `--mode` | （必須） | `gateway` / `typesafe`。クライアントと同じ経路にする |
| `--port` | 8787 | 待ち受けるポート |
| `--host` | `127.0.0.1` | 待ち受けるアドレス。loopback 以外にすると警告を出す |
| `--env-file` | `.env` | キーを読むファイル |
| `--upstream` | 経路の公式 URL | 中継先 |

### Express などのミドルウェア

```ts
import { createJevProxyHandler } from '@jumboly/jev-client/node'

app.use('/dev-jev/typesafe', createJevProxyHandler({ mode: 'typesafe' }))
```

`startJevProxy(opts)` で、単体サーバーをコードから起動することもできる。共通のオプション:

| オプション | 既定 | 内容 |
|---|---|---|
| `mode` | （必須） | 中継先の経路 |
| `apiKey` | 環境変数 → `envFile` | 付与するキー |
| `envFile` | `.env` | キーを読むファイル（Vite プラグインでは envDir の `.env`） |
| `upstream` | 経路の公式 URL | 中継先 |
| `allowedOrigins` | localhost のみ | 許可する Origin（`string[]` か `(origin) => boolean`）。LAN の別の端末から確かめるときなどに足す |
| `path` | `/dev-jev/<mode>` | Vite プラグインのみ。プロキシを置くパス |

- 中継するのは本文と `Content-Type` だけ。`Cookie` や `Origin` は上流に渡さない。
- 上流のステータス・本文・`retry-after` などのヘッダはそのまま返すので、流量制御は直接呼んだときと同じように働く。
- 上流に接続できなければ 502 を返す（クライアントは再試行する）。

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
npm run proxy -- --mode typesafe               # ソースから jev-proxy を実行（.env が必要）
npx tsx scripts/verify-typesafe.ts             # typesafe 経路の生の応答・CORS・変換結果を確かめる（4 回送信）
```

並行して開発しながら別プロジェクトで使うときは、利用側で `npm install ../jev-client` を実行する。symlink になるので、こちらで先に `npm run build` しておくこと。
