import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultGates, evaluate, jevEvaluator, JevError, JevGate } from '../src/index.js'

const q = { q: { type: 'choice' as const, instructions: 'x', criteria: { A: 'a' } } }
const auth = { mode: 'gateway' as const, apiKey: 'k' }

const ok = () =>
  new Response(JSON.stringify({ answers: { q: { type: 'choice', choice: 'A', probabilities: { A: 1 } } }, usage: { inputTokens: 10 } }), {
    status: 200,
  })
// retry-after は秒単位。小数にしてテストを実時間で速く回す
const fail = (status: number, headers: Record<string, string> = { 'retry-after': '0.02' }) =>
  new Response(`{"error":{"message":"err ${status}"}}`, { status, headers })

/** 応答を順に返す fetch。呼ばれた回数を数える */
function stubFetch(...responses: ((init: RequestInit) => Response | Promise<Response>)[]) {
  const calls = { n: 0 }
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const r = responses[Math.min(calls.n++, responses.length - 1)]
    return r(init)
  })
  return calls
}

describe('evaluate: 再試行・時間切れ・非再試行エラー', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('503 は retry-after を待って再試行し、成功すれば回答を返す', async () => {
    const calls = stubFetch(() => fail(503), () => fail(503), ok)
    const retries: number[] = []
    const gate = new JevGate(3)
    const r = await evaluate(auth, 's', q, { gate, onRetry: (i) => retries.push(i.status) })
    expect(r.answers.q.choice).toBe('A')
    expect(calls.n).toBe(3)
    expect(retries).toEqual([503, 503])
    expect(gate.state.inFlight).toBe(0)
  })

  it.each([401, 403])('%i は再試行せず retryable=false の JevError を投げる', async (status) => {
    const calls = stubFetch(() => fail(status))
    const gate = new JevGate(3)
    const err = await evaluate(auth, 's', q, { gate }).catch((e) => e)
    expect(err).toBeInstanceOf(JevError)
    expect(err).toMatchObject({ status, retryable: false, message: `JEV ${status}: err ${status}` })
    expect(calls.n).toBe(1)
    // 認証エラーで他の呼び出しまで待たせない
    expect(gate.state.cooldownUntil).toBe(0)
    expect(gate.state.inFlight).toBe(0)
  })

  it('x-should-retry: false なら 503 でも再試行しない', async () => {
    const calls = stubFetch(() => fail(503, { 'x-should-retry': 'false' }))
    const err = await evaluate(auth, 's', q, { gate: new JevGate(3) }).catch((e) => e)
    expect(err).toMatchObject({ status: 503, retryable: false })
    expect(calls.n).toBe(1)
  })

  it('maxAttempts に達したら retryable=true の JevError を投げる', async () => {
    const calls = stubFetch(() => fail(429))
    const err = await evaluate(auth, 's', q, { gate: new JevGate(3), maxAttempts: 3 }).catch((e) => e)
    expect(err).toMatchObject({ status: 429, retryable: true })
    expect(calls.n).toBe(3)
  })

  it('共有の待機が maxWaitMs より長ければ送信せずに 429 の JevError を投げる', async () => {
    const calls = stubFetch(ok)
    const gate = new JevGate(3)
    gate.onTransientFailure(429, 60000)
    const err = await evaluate(auth, 's', q, { gate, maxWaitMs: 1000 }).catch((e) => e)
    expect(err).toMatchObject({ status: 429, retryable: true })
    expect(calls.n).toBe(0)
  })

  it('応答が返らなければ timeoutMs で打ち切って再試行する', async () => {
    const hang = (init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))
    const calls = stubFetch(hang, ok)
    const retries: number[] = []
    const gate = new JevGate(3)
    const r = await evaluate(auth, 's', q, { gate, timeoutMs: 50, onRetry: (i) => retries.push(i.status) })
    expect(r.answers.q.choice).toBe('A')
    expect(calls.n).toBe(2)
    expect(retries).toEqual([599])
    expect(gate.state.inFlight).toBe(0)
  })

  it('呼び出し側の signal で中断したら再試行せずにそのまま投げる', async () => {
    const hang = (init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))
    const calls = stubFetch(hang)
    const gate = new JevGate(3)
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 20)
    await expect(evaluate(auth, 's', q, { gate, signal: ac.signal })).rejects.not.toBeInstanceOf(JevError)
    expect(calls.n).toBe(1)
    expect(gate.state.inFlight).toBe(0)
  })
})

describe('evaluate: 経路（gateway / typesafe / 透過プロキシ）', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** 送信内容を記録し、指定の JSON を返す fetch */
  function capture(json: unknown) {
    const sent: { url: string; headers: Record<string, string>; body: any }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) })
      return new Response(JSON.stringify(json), { status: 200 })
    })
    return sent
  }
  const questions = {
    c: { type: 'choice' as const, instructions: 'x', criteria: { A: 'a' } },
    b: { type: 'boolean' as const, instructions: 'y' },
  }

  it('gateway: 公式 URL・typesafe-ai/jev・Bearer キーで送り、marketCost を料金にする', async () => {
    const sent = capture({
      answers: { c: { type: 'choice', choice: 'A' }, b: { type: 'boolean', probability: 0.7 } },
      usage: { inputTokens: 100, outputTokens: 0 },
      providerMetadata: { gateway: { marketCost: '0.00001' } },
    })
    const r = await evaluate({ mode: 'gateway', apiKey: 'k' }, 's', questions, { gate: new JevGate(3) })
    expect(sent[0].url).toBe('https://ai-gateway.vercel.sh/v1/evaluate')
    expect(sent[0].headers.authorization).toBe('Bearer k')
    expect(sent[0].body).toMatchObject({ model: 'typesafe-ai/jev', questions: { b: { type: 'boolean' } } })
    expect(r.answers.b).toMatchObject({ type: 'boolean', probability: 0.7 })
    expect(r.usage.costUsd).toBe(0.00001)
  })

  it('typesafe: 直接 API の形（jev-latest・noul・snake_case の usage）を gateway 形式に揃える', async () => {
    const sent = capture({
      model: 'jev-latest',
      answers: { c: { type: 'choice', choice: 'A', confidence: 0.9 }, b: { type: 'noul', noul: 0.3 } },
      usage: { input_tokens: 1000, output_tokens: 0 },
    })
    const r = await evaluate({ mode: 'typesafe', apiKey: 't' }, 's', questions, { gate: new JevGate(3) })
    expect(sent[0].url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(sent[0].headers.authorization).toBe('Bearer t')
    expect(sent[0].body).toMatchObject({ model: 'jev-latest', questions: { b: { type: 'noul' }, c: { type: 'choice' } } })
    expect(r.answers.b).toEqual({ type: 'boolean', probability: 0.3, confidence: undefined })
    expect(r.answers.c.confidence).toBe(0.9)
    expect(r.usage).toEqual({ inputTokens: 1000, outputTokens: 0, costUsd: 1000 * (0.042 / 1_000_000) })
  })

  it.each(['gateway', 'typesafe'] as const)('%s: url を指定すると透過プロキシへ送り、apiKey が無ければ Authorization を付けない', async (mode) => {
    const sent = capture({ answers: {}, usage: {} })
    await evaluate({ mode, url: 'https://proxy.example/jev' }, 's', questions, { gate: new JevGate(3) })
    expect(sent[0].url).toBe('https://proxy.example/jev')
    expect(sent[0].headers.authorization).toBeUndefined()
  })
})

describe('経路ごとの流量制御と provider', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** gateway の URL だけ 429 を返し、他は成功する fetch */
  function gatewayLimited() {
    const sent: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      sent.push(url)
      return url.includes('ai-gateway') ? fail(429, { 'retry-after': '60' }) : ok()
    })
    return sent
  }

  it('既定の gate は経路ごとに別なので、gateway の 429 で typesafe は止まらない', async () => {
    gatewayLimited()
    await expect(evaluate({ mode: 'gateway', apiKey: 'k' }, 's', q, { maxAttempts: 1 })).rejects.toMatchObject({ status: 429 })
    expect(defaultGates.gateway.state.cooldownUntil).toBeGreaterThan(Date.now())
    expect(defaultGates.typesafe.state.cooldownUntil).toBe(0)
    const r = await evaluate({ mode: 'typesafe', apiKey: 't' }, 's', q, { maxWaitMs: 0 })
    expect(r.provider).toBe('typesafe')
  })

  it('jevEvaluator は source とは別に provider を返し、mock では付けない', async () => {
    stubFetch(ok)
    const gate = new JevGate(3)
    expect(await jevEvaluator({ mode: 'gateway', apiKey: 'k' }, { gate })('s', q)).toMatchObject({ source: 'jev', provider: 'gateway' })
    expect(await jevEvaluator({ mode: 'typesafe', apiKey: 't' }, { gate })('s', q)).toMatchObject({ source: 'jev', provider: 'typesafe' })
    const m = await jevEvaluator({ mode: 'mock' })('s', q)
    expect(m.source).toBe('mock')
    expect(m.provider).toBeUndefined()
  })

  it('jevEvaluator に渡した gate を使い、呼び出し時の opts.gate があればそちらを優先する', async () => {
    stubFetch(() => fail(429, { 'retry-after': '60' }))
    const bound = new JevGate(3)
    const call = new JevGate(3)
    const ev = jevEvaluator({ mode: 'typesafe', apiKey: 't' }, { gate: bound })
    await ev('s', q, { maxAttempts: 1 }).catch(() => {})
    expect(bound.state.consecutiveFailures).toBe(1)
    await ev('s', q, { maxAttempts: 1, gate: call }).catch(() => {})
    expect(call.state.consecutiveFailures).toBe(1)
    expect(bound.state.consecutiveFailures).toBe(1)
  })
})
