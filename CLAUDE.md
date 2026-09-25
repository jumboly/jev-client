# jev-client

TypeSafe AI Jev を呼ぶクライアント。Vercel AI Gateway 経由（`mode: 'gateway'`）と TypeSafe の直接 API（`mode: 'typesafe'`）の両方に対応し、`url` で透過プロキシにも向けられる。

- **作業を始める前に `HANDOFF.md` を読むこと**（切り出し直後の残作業と、守るべきユーザー判断が書いてある）。
- API の要点・実測結果の正本は `README.md`。JEV 全般の知識はスキル `j-jev` にある。
- 429/503 の実測値は一時的なものとして扱い、固定値にしない。JEV の失敗を JEV 以外の判断で黙って代打ちしない。
- 確認: `npm test` / `npm run typecheck`。実 API を使う計測は `npm run probe -- --mode gateway|typesafe`（`.env` の `AI_GATEWAY_API_KEY` / `TYPESAFE_API_KEY`）。
