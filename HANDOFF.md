# 引き継ぎ: jev-client の切り出し（2026-09-25）

wikipedia-geo-runner（JEV Geo Race）の中で作った JEV クライアントを、他の実験でも使うために独立リポジトリへ切り出したところ。**このファイルを読んで、以下の「残作業」を仕上げること。** 完了したらこのファイルは削除するか、要点を README / CLAUDE.md に移す。

## 背景

- JEV = TypeSafe AI の意思決定モデル `typesafe-ai/jev`。テキストを生成せず、state と型付きの質問（choice / score / boolean）に確率付きで答える。Vercel AI Gateway のネイティブ HTTP API `POST https://ai-gateway.vercel.sh/v1/evaluate` で呼ぶ。
- 2026-09 時点で 429/503 が頻発した。原因は JEV 公開直後の混雑とユーザーは見ている。そのため、全呼び出しで待機を共有する流量制御・時間切れ・ダミー／録画再生への切り替えを作り、実測もした（README の「エラー傾向の実測」を参照）。
- API の要点・ハマりどころ・実測値は **README.md が正本**。汎用的な JEV の知識はユーザースキル `j-jev`（`~/src/cc-jumboly/skills/j-jev/SKILL.md`、インストール先 `~/.claude/skills/j-jev/`）にもある。

## 現在の状態

- 元の場所: `~/src/jev-wiki-geo-runner/packages/jev-client/`（npm workspaces。**まだそちらが正本として使われている**）。そこからファイルをコピーした（git 履歴は引き継いでいない。元リポジトリでは未コミットの変更だったため）。
- このリポジトリ単体で `npm test`（13件）と `npm run typecheck` が通る。
- `exports` は **TypeScript ソースを直接指している**（`./src/index.ts`、`./node` → `./src/node.ts`）。Vite / tsx / vitest のような TS を解決できる環境向け。ビルド済みの成果物（`dist`）はまだ無い。
- GitHub のリポジトリは未作成。npm にも未公開（`private: true`）。

## 構成

| ファイル | 役割 |
|---|---|
| `src/client.ts` | `evaluate(auth, state, questions, opts)` で回答と使用量（入力トークン・定価ベースの料金）を返す。`JevAuth` は key / proxy / mock。`defaultGate` はプロセス / Worker 内で共有される |
| `src/gate.ts` | `JevGate`: 失敗したら全呼び出しで待機を共有、同時実行数を自動調整（失敗で半減・成功で回復）、回数上限（auto = 429 のときだけ学習し止めば解除 / manual = 固定） |
| `src/evaluator.ts` | `Evaluator` の抽象。`jevEvaluator` / `mockEvaluator` / `replayEvaluator` / `recording` / `withFallback`。回答に `source`（jev / replay / mock）を付ける |
| `src/node.ts` | Node 専用: `fileStore`（録画を JSON ファイルに保存） |
| `src/probe.ts` | ゲートを通さずに生の応答を記録する計測ツール（`npm run probe`、`.env` の `AI_GATEWAY_API_KEY` を使う） |

## 守ること（ユーザーの判断）

1. **429 の「毎分約 30 回」を固定値にしない。** 一時的な混雑とみなしている。回数上限の既定は auto のまま。傾向を前提にする判断の前に `npm run probe` で再計測する（少量なら 1 円未満）。
2. **JEV が失敗したとき、JEV 以外の判断（コード・他の AI・Claude）で黙って代打ちしない。** ダミー／録画は開発・テスト用。混ぜる場合は `source` で区別し、正式な結果として扱わない。
3. `zeroDataRetention` は指定しない（Vercel Hobby で 403 になる）。
4. API キーをコミットしない。ブラウザではユーザー自身のキーを使い、開発時は proxy モード（dev サーバー側でキーを付与）にする。

## 残作業

1. **公開方法を決める（ユーザーに確認）**: GitHub リポジトリ（例: `jumboly/jev-client`）を作るか、公開か非公開か、npm に公開するか。wikipedia-geo-runner は GitHub の Public リポジトリなので、依存に使うなら到達できる必要がある。
2. **ビルド**: TS を解決できない利用者向けに `tsc` で `dist/`（`.js` と `.d.ts`）を出す。`exports` を `types` / `import` 条件付きにする。GitHub から直接インストールする場合は `prepare` でビルドするか、`dist` をコミットするかを決める。
3. **CI**: GitHub Actions で test と typecheck。
4. **API の見直し（任意）**: モジュール単位の `defaultGate` に加えて、`createJevClient({ auth, gate })` のようなインスタンス API を用意するか。質問数・候補数（255）の事前検証を入れるか。
5. **テストの追加**: `evaluate()` の再試行・時間切れ・`maxWaitMs`・非再試行エラー（401/403）。※共有待機の結合テストは `test/gate.test.ts` にある。
6. **wikipedia-geo-runner を切り替える**: 依存を `@jumboly/jev-client`（GitHub 参照、または開発中は `file:../jev-client`）に変える。`packages/jev-client/` と root `package.json` の `workspaces` を削除し、`npm run probe` のスクリプトの参照先を直す。CI（GitHub Actions の `npm ci`）で解決できることを確認する。ゲーム側が使っているもの: `evaluate` 系の型（`Answer`, `EvaluateOptions`, `JevAuth`, `JevError`）、`defaultGate` / `GateState`、`Evaluator` / `AnswerSource` / `jevEvaluator` / `mockEvaluator` / `replayEvaluator` / `recording` / `withFallback` / `memoryStore` / `isRecoverable`、`@jumboly/jev-client/node` の `fileStore`。
7. **スキル `j-jev` のパスを更新**: `~/src/cc-jumboly/skills/j-jev/SKILL.md` の SDK の場所（現在は `~/src/jev-wiki-geo-runner/packages/jev-client/` と、そのリポジトリの GitHub URL）を新しいリポジトリに向け、`~/.claude/skills/j-jev/` へ再インストールする（cc-jumboly の INSTALL.md の手順）。

## 確認コマンド

```sh
npm install
npm test            # 13 件
npm run typecheck
npm run probe -- --minutes 1 --interval 2000 --burst 2   # 実 API（.env 必須・少額）
```
