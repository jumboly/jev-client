# @jumboly/jev-client

TypeSafe AI の **Jev**（`typesafe-ai/jev`）を Vercel AI Gateway のネイティブ HTTP API（`POST https://ai-gateway.vercel.sh/v1/evaluate`）で呼ぶための小さなクライアント。ブラウザ（Web Worker 含む）と Node の両方で動く。

JEV を使う別プロジェクトでも同じ失敗を繰り返さないために、wikipedia-geo-runner（JEV Geo Race）から切り出した。切り出し直後の残作業は `HANDOFF.md` を参照。

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

const auth = { mode: 'key', apiKey } as const // ブラウザ: ユーザーが入力したキー
// 開発時: { mode: 'proxy', url: '/dev-jev/v1/evaluate' }（dev サーバー側でキーを付与）
const { answers, usage } = await evaluate(auth, { goal: '大坂城周辺' }, {
  move: { type: 'choice', instructions: '次に進むリンクを選べ', criteria: { L1: '大阪市', L2: '1868年' } },
})

defaultGate.subscribe((s) => console.log(s.cooldownUntil, s.concurrency, s.ratePerMin)) // UI に待機状況を出す
defaultGate.configure({ ratePerMin: 0 }) // 0 = auto（既定）、正の数 = 固定

// 開発・テスト: JEV → 録画 → ダミー の順に代替（本番で混ぜる場合は source で区別すること）
const ev = withFallback(jevEvaluator(auth), replayEvaluator(memoryStore()), mockEvaluator({ avoidKeys: ['BACK'] }))
```

Node では `import { fileStore } from '@jumboly/jev-client/node'` で録画をファイルに保存できる。

## API の要点（2026-09 時点）

- 認証は `Authorization: Bearer <AI_GATEWAY_API_KEY>`。AI Gateway は CORS を許可しており、`retry-after` と `x-should-retry` も公開ヘッダ。
- choice は最大 255 候補、score は 2〜10 段階（`score` は段階間の連続値で、`probabilities` のキーは `"0"`, `"1"`, …）。state は 32k トークンまで。
- `confidence` は各回答と `providerMetadata.typesafe.confidence` の両方に入る。料金は `providerMetadata.gateway.marketCost`（定価ベース）。
- `providerOptions.gateway.zeroDataRetention` は Vercel **Pro 以上のみ**。Hobby では 403 になる。
- OpenAI 互換クライアントからは使えない（evaluate 系の API を使う）。

## エラー傾向の実測（2026-09-25・一時的な値）

JEV 公開直後の混雑による**一時的な傾向**と考えられるため、**固定値としてコードに持たない**こと。判断の前に `npm run probe` で再計測する。

- 429: 毎分約 30 回の上限超過として振る舞った。`retry-after` は次の分の区切りまでの秒数。
- 503/500: 上流プロバイダ（digitalocean）の障害。数秒単位で連続する（直前が 5xx なら次も 62%）。
- エラーは強く連続する（直前がエラーなら次も 98%）。そのため各呼び出しが独立に再試行するより、全体で待つほうがよい。
- 成功時の遅延は中央値 0.34 秒。まれに 30 秒応答が返らない。
