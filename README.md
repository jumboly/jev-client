# @jumboly/jev-client

TypeSafe AI の **Jev** を呼ぶための小さなクライアント。Vercel AI Gateway のネイティブ HTTP API（`POST https://ai-gateway.vercel.sh/v1/evaluate`）と TypeSafe AI の直接 API（`POST https://api.typesafe.ai/v1/systemone`）の両方に対応し、URL を差し替えて透過プロキシ経由でも呼べる。ブラウザ（Web Worker 含む）と Node の両方で動く。

JEV を使う別プロジェクトでも同じ失敗を繰り返さないために、wikipedia-geo-runner（JEV Geo Race）から切り出した。切り出し直後の残作業は `HANDOFF.md` を参照。

## インストール

npm には公開していない。GitHub から直接入れる（インストール時に `prepare` が `dist/` をビルドする）。

```sh
npm install github:jumboly/jev-client        # タグを固定するなら github:jumboly/jev-client#v0.1.0
npm install ../jev-client                    # 並行して開発するとき（file: 参照。symlink なので先にこちらで npm run build）
```

`exports` はビルド済みの `dist/`（ESM + `.d.ts`）を指す。計測ツールは `npx jev-probe`（利用側の `.env` の `AI_GATEWAY_API_KEY` を読む）。

## できること

| 機能 | 内容 |
|---|---|
| `evaluate()` | choice / score / boolean の質問を送り、回答と使用量（入力トークン・定価ベースの料金）を返す |
| 共有の流量制御 `JevGate` | 1 件でも 429/503 を受けたら全呼び出しが共有で待機する。失敗で同時実行数を半減し、成功が続けば回復する。1 分あたりの上限は既定で **auto**（上限なし。429 のときだけ学習し、止めば徐々に解除） |
| 時間切れ | 1 リクエスト 20 秒で打ち切って再試行する（応答が返らず固まる呼び出しがあったため） |
| 判断役 `Evaluator` | `jevEvaluator` / `mockEvaluator` / `replayEvaluator` を `withFallback` で連結し、`recording` で JEV の回答を録画できる。回答には `source`（jev / replay / mock）が付く |
| `probe` | ゲートを通さない生の応答を記録し、エラー傾向を再計測する（`npm run probe`） |

## 使い方

```ts
import { evaluate, defaultGate, jevEvaluator, withFallback, replayEvaluator, mockEvaluator, memoryStore } from '@jumboly/jev-client'

const auth = { mode: 'gateway', apiKey } as const // Vercel AI Gateway（ブラウザ: ユーザーが入力したキー）
// { mode: 'typesafe', apiKey }                        TypeSafe AI の直接 API
// { mode: 'gateway', url: '/dev-jev/v1/evaluate' }    透過プロキシ経由（キーはプロキシ側で付与するなら apiKey 不要）
// { mode: 'typesafe', url: 'https://my-proxy/...', apiKey }  プロキシがキーを素通しする場合
const { answers, usage } = await evaluate(auth, { goal: '大坂城周辺' }, {
  move: { type: 'choice', instructions: '次に進むリンクを選べ', criteria: { L1: '大阪市', L2: '1868年' } },
})

// 流量制御は経路ごとに別（defaultGates.gateway / defaultGates.typesafe。defaultGate は gateway 用）
defaultGate.subscribe((s) => console.log(s.cooldownUntil, s.concurrency, s.ratePerMin)) // UI に待機状況を出す
defaultGate.configure({ ratePerMin: 0 }) // 0 = auto（既定）、正の数 = 固定
// 別の gate を共有させたいとき（例: 同じ上流へ向かう複数の透過プロキシ）
const viaProxy = jevEvaluator({ mode: 'gateway', url: 'https://my-proxy/v1/evaluate' }, { gate: defaultGate })

// 開発・テスト: JEV → 録画 → ダミー の順に代替（本番で混ぜる場合は source で区別すること）
const ev = withFallback(jevEvaluator(auth), replayEvaluator(memoryStore()), mockEvaluator({ avoidKeys: ['BACK'] }))
```

Node では `import { fileStore } from '@jumboly/jev-client/node'` で録画をファイルに保存できる。

## 経路（`JevAuth`）

| `mode` | 既定の URL | モデル名 | 違い |
|---|---|---|---|
| `gateway` | `https://ai-gateway.vercel.sh/v1/evaluate` | `typesafe-ai/jev` | CORS 可。料金（`marketCost`）が返る |
| `typesafe` | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | boolean は `noul`、usage は snake_case。料金は返らない |
| `mock` | — | — | API を呼ばない（開発・テスト用） |

- `url` を指定すると、その経路の形式のまま別の URL（透過プロキシ）へ送る。`apiKey` を省略すると `Authorization` を付けない。
- 結果の `provider`（`evaluate()` の戻り値と `Evaluator` の結果）で、どちらの経路の回答かを区別できる。`source` は「JEV の判断か」を表し、経路は含めない。
- 流量制御は経路ごとに別（片方の 429 で空いている経路まで止めないため）。
- 質問の形（候補数・段階数）は送信前にチェックしない。仕様が変わり得るので、サーバーの 4xx（再試行しない `JevError`）に任せる。
- 回答は経路によらず gateway の形式（boolean は `probability`）に揃えるので、利用側と録画は経路に依存しない。
- `typesafe` の料金は AI Gateway の公表単価からの概算（直接 API の単価は未確認）。
- `mode` は必須で、既定の経路は持たない（経路で形式・料金・エラー傾向が違うため、呼び出し側で明示する）。
- `typesafe` の形式は公式ドキュメント（https://docs.typesafe.ai/api 、2026-09）に基づく。**実 API ではまだ確認していない**ため、使う前に `npm run probe -- --mode typesafe` で確かめること。

## API の要点（2026-09 時点）

- 認証は `Authorization: Bearer <キー>`（gateway は `AI_GATEWAY_API_KEY`、typesafe は `TYPESAFE_API_KEY`）。AI Gateway は CORS を許可しており、`retry-after` と `x-should-retry` も公開ヘッダ。
- choice は最大 255 候補、score は 2〜10 段階（`score` は段階間の連続値で、`probabilities` のキーは `"0"`, `"1"`, …）。state は 32k トークンまで。
- `confidence` は各回答と `providerMetadata.typesafe.confidence` の両方に入る。料金は `providerMetadata.gateway.marketCost`（定価ベース）。
- typesafe の直接 API は 401（キー不正）/ 422（検証エラー）/ 429 / 529（過負荷）を返すとされる。429 と 5xx は再試行する。CORS と `retry-after` は文書に記載が無い（ブラウザからは透過プロキシ経由を想定）。
- `providerOptions.gateway.zeroDataRetention` は Vercel **Pro 以上のみ**。Hobby では 403 になる。
- OpenAI 互換クライアントからは使えない（evaluate 系の API を使う）。

## エラー傾向の実測（2026-09-25・一時的な値）

JEV 公開直後の混雑による**一時的な傾向**と考えられるため、**固定値としてコードに持たない**こと。判断の前に `npm run probe` で再計測する。

- 429: 毎分約 30 回の上限超過として振る舞った。`retry-after` は次の分の区切りまでの秒数。
- 503/500: 上流プロバイダ（digitalocean）の障害。数秒単位で連続する（直前が 5xx なら次も 62%）。
- エラーは強く連続する（直前がエラーなら次も 98%）。そのため各呼び出しが独立に再試行するより、全体で待つほうがよい。
- 成功時の遅延は中央値 0.34 秒。まれに 30 秒応答が返らない。
