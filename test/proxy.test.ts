import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evaluate, JevGate } from '../src/index.js'
import { createJevProxyHandler, jevDevProxy, startJevProxy, type JevProxyServer } from '../src/node.js'

/** 受け取ったリクエストを記録し、指定の応答を返す偽の上流 */
let upstream: Server
let upstreamUrl: string
let received: { headers: IncomingHttpHeaders; body: string }[]
let reply: { status: number; headers?: Record<string, string>; body: string }
let proxy: JevProxyServer | undefined

beforeEach(async () => {
  received = []
  reply = { status: 200, body: JSON.stringify({ answers: { b: { type: 'noul', noul: 0.3 } }, usage: { input_tokens: 5 } }) }
  upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    received.push({ headers: req.headers, body: Buffer.concat(chunks).toString() })
    res.writeHead(reply.status, { 'content-type': 'application/json', 'access-control-allow-origin': 'https://upstream.example', ...reply.headers })
    res.end(reply.body)
  })
  await new Promise<void>((ok) => upstream.listen(0, '127.0.0.1', ok))
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1/systemone`
})

afterEach(async () => {
  await proxy?.close()
  proxy = undefined
  await new Promise((ok) => upstream.close(ok))
})

const start = (opts: Partial<Parameters<typeof startJevProxy>[0]> = {}) =>
  startJevProxy({ mode: 'typesafe', apiKey: 'server-key', upstream: upstreamUrl, port: 0, ...opts }).then((p) => (proxy = p))

describe('開発用の透過プロキシ', () => {
  it('evaluate() から url だけ渡せば、プロキシがキーを付けて中継する', async () => {
    const p = await start()
    const r = await evaluate({ mode: 'typesafe', url: p.url }, 's', { b: { type: 'boolean', instructions: 'x' } }, { gate: new JevGate(3) })
    expect(r.answers.b).toStrictEqual({ type: 'boolean', probability: 0.3 })
    expect(received[0].headers.authorization).toBe('Bearer server-key')
    // 送る形式はクライアントが作ったまま（noul への変換はクライアント側）
    expect(JSON.parse(received[0].body)).toMatchObject({ model: 'jev-latest', questions: { b: { type: 'noul' } } })
  })

  it('キーを持つときはブラウザから来た Authorization を上書きし、Cookie・Origin は上流に渡さない', async () => {
    const p = await start()
    await fetch(p.url, { method: 'POST', headers: { authorization: 'Bearer browser', cookie: 'a=1', origin: 'http://localhost:5173' }, body: '{}' })
    expect(received[0].headers).toMatchObject({ authorization: 'Bearer server-key' })
    expect(received[0].headers.cookie).toBeUndefined()
    expect(received[0].headers.origin).toBeUndefined()
  })

  it('キーが無ければ Authorization をそのまま中継する', async () => {
    const p = await start({ apiKey: undefined, envFile: '/nonexistent/.env' })
    await fetch(p.url, { method: 'POST', headers: { authorization: 'Bearer browser' }, body: '{}' })
    expect(received[0].headers.authorization).toBe('Bearer browser')
  })

  it('ステータスと待機のヘッダをそのまま返し、CORS はプロキシのものに付け替える', async () => {
    reply = { status: 429, headers: { 'retry-after': '3', 'retry-after-ms': '2500' }, body: '{"detail":{"message":"slow down"}}' }
    const p = await start()
    const res = await fetch(p.url, { method: 'POST', headers: { origin: 'http://localhost:5173' }, body: '{}' })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after-ms')).toBe('2500')
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173')
    expect(res.headers.get('access-control-expose-headers')).toBe('*')
    expect(await res.text()).toBe('{"detail":{"message":"slow down"}}')
  })

  it('事前確認（OPTIONS）に 204 で答え、上流には送らない', async () => {
    const p = await start()
    const res = await fetch(p.url, {
      method: 'OPTIONS',
      headers: { origin: 'http://127.0.0.1:3000', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type')
    expect(received).toHaveLength(0)
  })

  it.each(['https://evil.example', 'http://localhost.evil.example'])('localhost 以外の Origin（%s）は 403 で拒否し、上流に送らない', async (origin) => {
    const p = await start()
    const res = await fetch(p.url, { method: 'POST', headers: { origin, 'content-type': 'text/plain' }, body: '{}' })
    expect(res.status).toBe(403)
    expect(received).toHaveLength(0)
  })

  it('allowedOrigins で許可する Origin を変えられる', async () => {
    const p = await start({ allowedOrigins: ['http://192.168.0.10:5173'] })
    const ok = await fetch(p.url, { method: 'POST', headers: { origin: 'http://192.168.0.10:5173' }, body: '{}' })
    const ng = await fetch(p.url, { method: 'POST', headers: { origin: 'http://localhost:5173' }, body: '{}' })
    expect([ok.status, ng.status]).toEqual([200, 403])
  })

  it('上流に接続できなければ、クライアントが再試行する 502 を返す', async () => {
    const p = await start({ upstream: 'http://127.0.0.1:1/unreachable' })
    const res = await fetch(p.url, { method: 'POST', body: '{}' })
    expect(res.status).toBe(502)
    expect((await res.json()).error.message).toMatch(/jev-proxy/)
  })

  it('Vite プラグインは dev サーバーでだけ有効になり、path にハンドラを置く', () => {
    const plugin = jevDevProxy({ mode: 'typesafe', apiKey: 'k' })
    expect(plugin.apply).toBe('serve')
    const mounted: string[] = []
    plugin.configureServer({ config: { root: '/app' }, middlewares: { use: (path) => mounted.push(path) } })
    expect(mounted).toEqual(['/dev-jev/typesafe'])
  })

  it('Express の express.json() などが先に読んだ本文も中継する', async () => {
    const handler = createJevProxyHandler({ mode: 'typesafe', apiKey: 'k', upstream: upstreamUrl })
    const server = createServer((req, res) => {
      // 本文ストリームを読み切ったうえで req.body に置く、body parser の振る舞いを模す
      req.resume()
      req.on('end', () => handler(Object.assign(req, { body: { state: 'parsed' } }), res))
    })
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
    await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, { method: 'POST', body: '{"state":"parsed"}' })
    await new Promise((ok) => server.close(ok))
    expect(JSON.parse(received[0].body)).toEqual({ state: 'parsed' })
  })
})
