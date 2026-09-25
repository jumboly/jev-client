#!/usr/bin/env node
/**
 * 開発用の透過プロキシを単体で起動する（キーは .env か環境変数から付与する）。
 *   npx jev-proxy --mode typesafe                 # http://127.0.0.1:8787 で待ち受ける
 *   npx jev-proxy --mode gateway --port 8788
 * ブラウザ側は evaluate({ mode: 'typesafe', url: 'http://127.0.0.1:8787' }, ...) のように url だけ渡す。
 */
import { parseArgs } from 'node:util'
import { startJevProxy } from './proxy.js'

const { values: a } = parseArgs({
  options: {
    // 経路で送る形式が違うので、クライアントと同じ mode を毎回明示させる
    mode: { type: 'string' },
    port: { type: 'string', default: '8787' },
    host: { type: 'string', default: '127.0.0.1' },
    'env-file': { type: 'string', default: '.env' },
    upstream: { type: 'string' },
  },
})
if (a.mode !== 'gateway' && a.mode !== 'typesafe') throw new Error(`--mode gateway か --mode typesafe を指定すること（指定: ${a.mode ?? 'なし'}）`)

const server = await startJevProxy({ mode: a.mode, port: Number(a.port), host: a.host, envFile: a['env-file'], upstream: a.upstream })
console.log(`jev-proxy (${a.mode}): ${server.url} で待ち受け中。クライアントには { mode: '${a.mode}', url: '${server.url}' } を渡す`)
