import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { GATEWAY_EVALUATE_URL, TYPESAFE_EVALUATE_URL, type JevProvider } from './client.js'

/**
 * 開発時の動作確認用の透過プロキシ。ブラウザアプリの dev サーバー（または localhost の単体サーバー）で
 * API キーを付与して JEV に中継する。キーをバンドルやブラウザに渡さずに済み、CORS 不可の typesafe 経路も
 * ブラウザから呼べるようになる。
 * 本番用ではない: キーを持つ中継を公開すると誰でもそのキーで呼べてしまうため、Vite プラグインは dev サーバーでだけ
 * 有効にし、単体サーバーは既定で loopback にだけ bind し、どちらも localhost 以外の Origin を拒否する。
 */

export interface JevProxyOptions {
  /** 中継先の経路。送る形式は変えない（クライアント側で同じ mode を指定すること） */
  mode: JevProvider
  /** 付与する API キー。省略時は環境変数、無ければ envFile から AI_GATEWAY_API_KEY / TYPESAFE_API_KEY を読む */
  apiKey?: string
  /** キーを読む .env のパス（既定: カレントディレクトリの .env） */
  envFile?: string
  /** 中継先の URL（既定: mode の公式エンドポイント） */
  upstream?: string
  /**
   * 許可する Origin。既定は localhost / 127.0.0.1 / [::1] / *.localhost のみ。
   * Origin ヘッダの無いリクエスト（curl や Node からの呼び出し）は常に許可する
   */
  allowedOrigins?: string[] | ((origin: string) => boolean)
}

type Handler = (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) => void

const KEY_NAMES: Record<JevProvider, string> = { gateway: 'AI_GATEWAY_API_KEY', typesafe: 'TYPESAFE_API_KEY' }
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])
// fetch が本文を展開済みなので長さ・圧縮のヘッダは実体と合わなくなる。CORS はプロキシ側で付け直す
const SKIP_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie'])

/**
 * Node の http / connect 形式（Vite の server.middlewares、Express など）のハンドラを作る。
 * パスは見ないので、マウントする側でパスを決める
 */
export function createJevProxyHandler(opts: JevProxyOptions): Handler {
  const keyName = KEY_NAMES[opts.mode]
  const apiKey = opts.apiKey ?? process.env[keyName] ?? readEnvFile(opts.envFile ?? '.env')[keyName]
  if (!apiKey) console.warn(`[jev-proxy] ${keyName} が見つからないため、ブラウザから送られた Authorization をそのまま中継する`)
  const upstream = opts.upstream ?? (opts.mode === 'gateway' ? GATEWAY_EVALUATE_URL : TYPESAFE_EVALUATE_URL)
  const isAllowed = originMatcher(opts.allowedOrigins)

  return (req, res) => {
    void handle(req, res).catch((e) => {
      if (!res.headersSent) sendError(res, 502, `jev-proxy: 中継に失敗した（${e instanceof Error ? e.message : String(e)}）`)
      else res.destroy()
    })
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin
    // 本文を読まれなくても、text/plain などの単純リクエストは送信だけで課金される。許可外の Origin は中継しない
    if (origin && !isAllowed(origin)) return sendError(res, 403, `jev-proxy: Origin ${origin} は許可されていない（allowedOrigins で追加できる）`)
    if (origin) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('vary', 'origin')
      // クライアントは retry-after / retry-after-ms / x-should-retry で待機時間を決めるので、JS から読めるようにする
      res.setHeader('access-control-expose-headers', '*')
    }
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.setHeader('access-control-allow-methods', 'POST, OPTIONS')
      res.setHeader('access-control-allow-headers', req.headers['access-control-request-headers'] ?? 'content-type, authorization')
      res.setHeader('access-control-max-age', '600')
      return res.end()
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST, OPTIONS')
      return sendError(res, 405, 'jev-proxy: POST のみ受け付ける')
    }

    const body = await readBody(req)
    // クライアントが時間切れで中断したら、上流への送信も止める
    const ac = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) ac.abort()
    })
    const authorization = apiKey ? `Bearer ${apiKey}` : req.headers.authorization
    // Cookie や Origin は上流に渡さない（中継先で CORS 判定や別の認証に使われないように）
    const up = await fetch(upstream, {
      method: 'POST',
      headers: { 'content-type': req.headers['content-type'] ?? 'application/json', ...(authorization && { authorization }) },
      // Buffer は SharedArrayBuffer の可能性があり BodyInit の型に合わないため、Uint8Array に写す
      body: new Uint8Array(body),
      signal: ac.signal,
    })
    res.statusCode = up.status
    up.headers.forEach((v, k) => {
      if (!SKIP_RESPONSE_HEADERS.has(k) && !k.startsWith('access-control-')) res.setHeader(k, v)
    })
    res.end(Buffer.from(await up.arrayBuffer()))
  }
}

/** 最小限の Vite の型。vite に依存しないよう、使う部分だけを構造的に書く */
interface ViteDevServerLike {
  config: { root: string; envDir?: string | false }
  middlewares: { use(path: string, fn: Handler): unknown }
}

/**
 * Vite プラグイン。dev サーバーでだけ path に透過プロキシを置く（build / preview には入らない）。
 * キーは Vite の envDir（無ければ root）の .env から読む。Vite は VITE_ の付かない変数を process.env に入れないため
 */
export function jevDevProxy(opts: JevProxyOptions & { path?: string }) {
  const path = opts.path ?? `/dev-jev/${opts.mode}`
  return {
    name: 'jev-dev-proxy',
    apply: 'serve' as const,
    configureServer(server: ViteDevServerLike) {
      const envDir = server.config.envDir || server.config.root
      server.middlewares.use(path, createJevProxyHandler({ envFile: resolve(envDir, '.env'), ...opts }))
    },
  }
}

export interface JevProxyServer {
  /** クライアントの url に指定する URL（パスは問わない） */
  url: string
  close(): Promise<void>
}

/** 単体の透過プロキシを起動する。Vite 以外の dev サーバーや、静的ファイルを直接開く場合に使う。どのパスでも中継する */
export async function startJevProxy(opts: JevProxyOptions & { port?: number; host?: string }): Promise<JevProxyServer> {
  const host = opts.host ?? '127.0.0.1'
  if (!LOOPBACK_HOSTS.has(host) && host !== '::1')
    console.warn(`[jev-proxy] ${host} で待ち受ける。キーを持つ中継なので、届く範囲の誰でもこのキーで JEV を呼べる点に注意`)
  const server = createServer(createJevProxyHandler(opts))
  await new Promise<void>((ok, ng) => server.once('error', ng).listen(opts.port ?? 8787, host, ok))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://${host.includes(':') ? `[${host}]` : host}:${port}`,
    close: () => new Promise((ok, ng) => server.close((e) => (e ? ng(e) : ok()))),
  }
}

function originMatcher(allowed: JevProxyOptions['allowedOrigins']): (origin: string) => boolean {
  if (typeof allowed === 'function') return allowed
  if (allowed) return (o) => allowed.includes(o)
  return (o) => {
    try {
      const { hostname } = new URL(o)
      return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost')
    } catch {
      return false
    }
  }
}

function readEnvFile(path: string): Record<string, string | undefined> {
  try {
    return parseEnv(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  // Express の express.json() などが先に本文を読んでいると、ストリームは空になっている
  const parsed = (req as { body?: unknown }).body
  if (parsed !== undefined) return Buffer.from(typeof parsed === 'string' || Buffer.isBuffer(parsed) ? parsed : JSON.stringify(parsed))
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

/** クライアントの extractMessage が読めるよう、gateway と同じ { error: { message } } の形で返す */
function sendError(res: ServerResponse, status: number, message: string) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify({ error: { message } }))
}
