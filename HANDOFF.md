# 引き継ぎ: jev-client の切り出し（2026-09-25）

wikipedia-geo-runner（JEV Geo Race）の中で作った JEV クライアントを、他の実験でも使うために独立リポジトリへ切り出したところ。**このファイルを読んで、以下の「残作業」を仕上げること。** 完了したらこのファイルは削除するか、要点を README / CLAUDE.md に移す。

## 背景

- JEV = TypeSafe AI の意思決定モデル `typesafe-ai/jev`。テキストを生成せず、state と型付きの質問（choice / score / boolean）に確率付きで答える。Vercel AI Gateway のネイティブ HTTP API（`POST https://ai-gateway.vercel.sh/v1/evaluate`）か、TypeSafe の直接 API（`POST https://api.typesafe.ai/v1/systemone`）で呼ぶ。
- 2026-09 時点で 429/503 が頻発した。原因は JEV 公開直後の混雑とユーザーは見ている。そのため、全呼び出しで待機を共有する流量制御・時間切れ・ダミー／録画再生への切り替えを作り、実測もした（`docs/probe-results.md` を参照）。
- 使い方・API の要点は **README.md**（利用者向け）、実測値は **`docs/probe-results.md`** が正本。汎用的な JEV の知識はユーザースキル `j-jev`（`~/src/cc-jumboly/skills/j-jev/SKILL.md`、インストール先 `~/.claude/skills/j-jev/`）にもある。

## 現在の状態

- 元の場所: `~/src/jev-wiki-geo-runner/packages/jev-client/`（npm workspaces。**まだそちらが正本として使われている**）。そこからファイルをコピーした（git 履歴は引き継いでいない。元リポジトリでは未コミットの変更だったため）。
- `npm test`（28 件）・`npm run typecheck`・`npm run build` が通る。
- `exports` はビルド済みの `dist/`（ESM + `.d.ts`、`types` / `import` 条件付き）を指す。GitHub から直接入れた場合は `prepare` でビルドされる。probe は `bin` の `jev-probe`。
- CI（`.github/workflows/ci.yml`）: Node 20.19 / 22 / 24 で typecheck・test・`dist` の import 確認。
- **経路を 2 つ持つ**: `mode: 'gateway'`（Vercel AI Gateway）/ `'typesafe'`（TypeSafe の直接 API `api.typesafe.ai/v1/systemone`）。`url` で透過プロキシに向けられ、`apiKey` 省略時は `Authorization` を付けない。回答は gateway の形式に揃える。**typesafe は公式ドキュメント準拠で、実 API では未確認**（`TYPESAFE_API_KEY` が手元に無い）。
- 公開方法は決定済み: GitHub の Public リポジトリ `jumboly/jev-client`、npm には公開しない（`private: true` のまま）。**リポジトリはまだ作っていない**（Claude からの作成は権限の自動判定で止められた）。ここまでの変更も未コミットの可能性がある。

## 構成

| ファイル | 役割 |
|---|---|
| `src/client.ts` | `evaluate(auth, state, questions, opts)` で回答・使用量（入力トークン・料金）・`provider` を返す。`JevAuth` は gateway / typesafe / mock。経路ごとの形式の違いを吸収する。流量制御は経路ごとの `defaultGates`（`defaultGate` は gateway 用） |
| `src/gate.ts` | `JevGate`: 失敗したら全呼び出しで待機を共有、同時実行数を自動調整（失敗で半減・成功で回復）、回数上限（auto = 429 のときだけ学習し止めば解除 / manual = 固定） |
| `src/evaluator.ts` | `Evaluator` の抽象。`jevEvaluator(auth, { gate })` / `mockEvaluator` / `replayEvaluator` / `recording` / `withFallback`。結果に `source`（jev / replay / mock）と、jev のとき `provider` を付ける |
| `src/node.ts` | Node 専用: `fileStore`（録画を JSON ファイルに保存） |
| `src/probe.ts` | ゲートを通さずに生の応答を記録する計測ツール（`npm run probe -- --mode gateway|typesafe [--url]`） |

## 守ること（ユーザーの判断）

1. **429 の「毎分約 30 回」を固定値にしない。** 一時的な混雑とみなしている。回数上限の既定は auto のまま。傾向を前提にする判断の前に `npm run probe` で再計測する（少量なら 1 円未満）。
2. **JEV が失敗したとき、JEV 以外の判断（コード・他の AI・Claude）で黙って代打ちしない。** ダミー／録画は開発・テスト用。混ぜる場合は `source` で区別し、正式な結果として扱わない。
3. `zeroDataRetention` は指定しない（Vercel Hobby で 403 になる）。
4. API キーをコミットしない。ブラウザではユーザー自身のキーを使い、開発時は透過プロキシ（dev サーバー側でキーを付与）にする。
5. **経路（`mode`）は必ず明示し、既定の経路を持たない**（2026-09-25）。旧 `key` / `proxy` は廃止した。
6. **流量制御は経路ごとに分ける**（2026-09-25）。同じ上流へ向かう透過プロキシ同士で共有したいときは gate を明示して渡す。
7. **経路は `source` ではなく別項目 `provider` で表す**（2026-09-25）。`source` は「JEV の判断か」の区別に使い続ける。
8. **インスタンス API（`createJevClient`）は作らない**（2026-09-25）。`jevEvaluator(auth, { gate })` で足りる。
9. **質問の形（候補数 255・score 2〜10 段階）を送信前にチェックしない**（2026-09-25）。仕様が変わり得るので、サーバーの 4xx に任せる。

## 残作業

1. **GitHub リポジトリの作成と push**: `gh repo create jumboly/jev-client --public --source . --push`。ユーザーが実行するか、権限を許可してもらう。必要ならタグ `v0.1.0` を打つ。
2. **typesafe 経路の実測**: `.env` に `TYPESAFE_API_KEY` を入れて `npm run probe -- --mode typesafe --minutes 1 --burst 1`。boolean（`noul`）の回答の形、429 のときの `retry-after` の有無、CORS を確かめ、結果を `docs/probe-results.md` に、形式の違いがあれば README とコードに反映する。
3. **wikipedia-geo-runner を切り替える**: 依存を `github:jumboly/jev-client` にする（開発中は `file:../jev-client`、symlink なので先にこちらで `npm run build`）。`packages/jev-client/` と root `package.json` の `workspaces` を削除し、`probe` スクリプトを `jev-probe --mode gateway` にする。CI（GitHub Actions の `npm ci`）で解決できることを確認する。旧 `mode` を使っている 3 箇所（`src/storage/apiKey.ts:48,50`、`src/cli/race.ts:85`）を `mode: 'gateway'` に書き換える。向こうには未コミットの作業が混在しているので、コミットはユーザーに確認してから。ゲーム側が使っているもの: `evaluate` 系の型（`Answer`, `EvaluateOptions`, `JevAuth`, `JevError`）、`defaultGate` / `GateState`、`Evaluator` / `AnswerSource` / `jevEvaluator` / `mockEvaluator` / `replayEvaluator` / `recording` / `withFallback` / `memoryStore` / `isRecoverable`、`@jumboly/jev-client/node` の `fileStore`。
4. **スキル `j-jev` のパスを更新**: `~/src/cc-jumboly/skills/j-jev/SKILL.md` の SDK の場所（現在は `~/src/jev-wiki-geo-runner/packages/jev-client/` と、そのリポジトリの GitHub URL）を新しいリポジトリに向け、2 経路（gateway / typesafe）に対応したことも書く。`~/.claude/skills/j-jev/` へ再インストールする（cc-jumboly の INSTALL.md の手順）。

## 確認コマンド

```sh
npm install
npm test            # 28 件
npm run typecheck
npm run probe -- --mode gateway --minutes 1 --interval 2000 --burst 2   # 実 API（.env 必須・少額）
```
