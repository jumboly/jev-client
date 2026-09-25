# jev-probe の計測結果

混雑の傾向は時期によって変わる。ここにある値は**その時点の傾向**なので、固定値としてコードに持たないこと。上限などを判断する前に `jev-probe` で測り直し、結果をここに追記する。

## 2026-09-25 / `gateway` 経路

- 429: 毎分約 30 回を超えると返った。`retry-after` は次の分の区切りまでの秒数。
- 503/500: 上流プロバイダ（digitalocean）の障害。数秒単位で連続する（直前が 5xx なら、次も 62%）。
- エラーは強く連続する（直前がエラーなら、次も 98%）。各呼び出しが別々に再試行するより、全体で待つほうがよい（`JevGate` が共有の待機をするのはこのため）。
- 成功時の遅延は中央値 0.34 秒、p90 は 0.5 秒。まれに 30 秒応答が返らない（既定の `timeoutMs` を 20 秒にしているのはこのため）。

## 2026-09-25 / `typesafe` 経路

`scripts/verify-typesafe.ts` と `jev-probe --mode typesafe --minutes 1 --interval 1000 --burst 2` で確認した。

- 形式はドキュメント（https://docs.typesafe.ai/api ）どおり。boolean は `noul`（回答は `{ type: 'noul', noul: 0..1 }`）、usage は `input_tokens` / `output_tokens`。score には `legend` が付く。
- `type: 'boolean'` は受け付けない（400、`{ detail: { error_type: 'api_usage_error', message: 'Invalid request.' } }`）。クライアント側で `noul` に変換するのが必要。
- `model: 'jev-latest'` を送ると、応答の `model` は実際の版（`jev-1.13.0`）になる。
- `output_tokens` は 0 ではない（72 など）。課金されるかは未確認。
- CORS 不可: プリフライト（OPTIONS）は 400 で、`access-control-allow-origin` を返さない（`localhost`、`github.io` のどちらのオリジンでも同じ）。ブラウザからは透過プロキシ経由で呼ぶ。
- `access-control-expose-headers: Retry-After, retry-after-ms` を返すので、待機時間はミリ秒単位でも受け取れる見込み（クライアントは `retry-after-ms` を優先して使う）。
- 毎分 120 回（2 並列 × 毎秒）を 1 分間送って、429 もエラーも 0 件。成功時の遅延は中央値 219ms、p90 284ms、最大 878ms。
- 429 を実際に受けたことはまだ無いので、`retry-after` / `retry-after-ms` の値の意味は未確認。

## 2026-09-25 / gateway と typesafe の同時比較

同じ時間帯に、両経路へ同じ負荷（`--minutes 2 --interval 1000 --burst 2`、各 240 回）を同時にかけた。

| 経路 | 成功 | 429 | 5xx | 成功時の遅延 中央値 / p90 |
|---|---|---|---|---|
| gateway | 72（30%） | 101 | 67（503: 65、500: 2） | 342ms / 471ms |
| typesafe | 240（100%） | 0 | 0 | 226ms / 303ms |

- gateway の 5xx は、すべて Gateway が振り分けた上流の digitalocean で起きていた。振り分け先が `typesafe-ai` のときは全部成功した。digitalocean の失敗から `typesafe-ai` に切り替わって成功したのは 3 件だけ。
- gateway の成功は毎分約 36 回で頭打ちになり、残りは 429 だった。同じ時間に typesafe は毎分 120 回すべて成功したので、この上限は Gateway 側にあると考えられる（アカウントやプランの差の可能性もある）。
- 1 回・2 分間だけの計測なので、経路の選択など判断に使う前に測り直すこと。
