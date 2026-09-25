# jev-client

TypeSafe AI Jev を呼ぶクライアント。Vercel AI Gateway 経由（`mode: 'gateway'`）と TypeSafe の直接 API（`mode: 'typesafe'`）の両方に対応し、`url` で透過プロキシにも向けられる。

- 使い方・API の要点の正本は `README.md`（利用者向け。経緯は書かない）、実測結果の正本は `docs/probe-results.md`。
- 課題・残作業は GitHub issues（https://github.com/jumboly/jev-client/issues ）で管理する。
- 確認: `npm test` / `npm run typecheck`。実 API を使う計測は `npm run probe -- --mode gateway|typesafe`（`.env` の `AI_GATEWAY_API_KEY` / `TYPESAFE_API_KEY`）。typesafe 経路の応答の形を確かめ直すときは `npx tsx scripts/verify-typesafe.ts`（4 回送信）。
- 透過プロキシの動作確認には、同梱の開発用プロキシ（`src/proxy.ts`、`jev-proxy`）を使う。

## 守ること（ユーザーの判断）

1. **429 の実測値（2026-09 時点で毎分約 30 回）を固定値にしない。** JEV 公開直後の一時的な混雑とみなしている。回数上限の既定は auto のまま。傾向を前提にする判断の前に `npm run probe` で再計測する（少量なら 1 円未満）。
2. **JEV が失敗したとき、JEV 以外の判断（コード・他の AI・Claude）で黙って代打ちしない。** ダミー／録画は開発・テスト用。混ぜる場合は `source` で区別し、正式な結果として扱わない。
3. `zeroDataRetention` は指定しない（Vercel Hobby で 403 になる）。
4. API キーをコミットしない。ブラウザではユーザー自身のキーを使い、開発時は透過プロキシ（dev サーバー側でキーを付与）にする。
5. **経路（`mode`）は必ず明示し、既定の経路を持たない**（2026-09-25）。旧 `key` / `proxy` は廃止した。
6. **流量制御は経路ごとに分ける**（2026-09-25）。同じ上流へ向かう透過プロキシ同士で共有したいときは gate を明示して渡す。
7. **経路は `source` ではなく別項目 `provider` で表す**（2026-09-25）。`source` は「JEV の判断か」の区別に使い続ける。
8. **インスタンス API（`createJevClient`）は作らない**（2026-09-25）。`jevEvaluator(auth, { gate })` で足りる。
9. **質問の形（候補数 255・score 2〜10 段階）を送信前にチェックしない**（2026-09-25）。仕様が変わり得るので、サーバーの 4xx に任せる。
10. **ユーザーの他のプロジェクト（利用側のアプリ、スキル、社内の中継サーバーなど）に依存しない**（2026-09-25）。汎用のクライアントとして単体で完結させ、資料やコメントにもそれらの名前・場所・事情を書かない。
