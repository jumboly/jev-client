import { afterEach, describe, expect, it, vi } from 'vitest'
import { evaluate, defaultGate } from '@jumboly/jev-client'
import { GateWaitTooLongError, JevGate } from '@jumboly/jev-client'

describe('JevGate（全 JEV 呼び出し共有の流量制御）', () => {
  it('1 件の失敗で全員が retry-after まで待つ', async () => {
    const g = new JevGate(3)
    g.onTransientFailure(429, 300)
    const t0 = Date.now()
    // 失敗で同時実行数は 1 に下がるため、取得した枠はすぐ解放する
    const take = () => g.acquire().then(() => g.release())
    await Promise.all([take(), take(), take()])
    expect(Date.now() - t0).toBeGreaterThanOrEqual(280)
  })

  it('失敗で同時実行数を半減し、成功が続くと 1 ずつ戻す', () => {
    const g = new JevGate(4)
    g.onTransientFailure(503, 1)
    expect(g.state.concurrency).toBe(2)
    g.onTransientFailure(503, 1)
    expect(g.state.concurrency).toBe(1)
    for (let i = 0; i < 5; i++) g.onSuccess()
    expect(g.state.concurrency).toBe(2)
    expect(g.state.consecutiveFailures).toBe(0)
  })

  it('同時実行数を超える取得は解放を待つ', async () => {
    const g = new JevGate(1)
    await g.acquire()
    let second = false
    const p = g.acquire().then(() => (second = true))
    await new Promise((r) => setTimeout(r, 20))
    expect(second).toBe(false)
    g.release()
    await p
    expect(second).toBe(true)
  })

  it('既定（auto）は上限なし', () => {
    const g = new JevGate(3)
    expect(g.state.rateMode).toBe('auto')
    expect(g.state.ratePerMin).toBe(0)
  })

  it('auto: 429 を受けたら直近 1 分の成功数を上限とし、429 が止めば徐々に緩めて上限なしに戻す', async () => {
    vi.useFakeTimers()
    try {
      const g = new JevGate(3)
      for (let i = 0; i < 12; i++) g.onSuccess()
      g.onTransientFailure(429, 1000)
      expect(g.state.ratePerMin).toBe(12)
      // 429 が無いまま時間が経つと 60 秒ごとに 25% ずつ緩み、最後は上限なし
      const seen: number[] = []
      for (let i = 0; i < 12; i++) {
        await vi.advanceTimersByTimeAsync(61000)
        await g.acquire()
        g.release()
        seen.push(g.state.ratePerMin)
      }
      expect(seen[0]).toBe(15)
      expect(seen.at(-1)).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('manual: 1 分あたりの上限に達したら、最古の送信から 60 秒経つまで次の送信を待つ', async () => {
    vi.useFakeTimers()
    try {
      const g = new JevGate(10)
      g.configure({ ratePerMin: 3 })
      for (let i = 0; i < 3; i++) {
        await g.acquire()
        g.release()
        await vi.advanceTimersByTimeAsync(1000)
      }
      let sent = false
      const p = g.acquire().then(() => (sent = true))
      await vi.advanceTimersByTimeAsync(1000)
      expect(sent).toBe(false)
      expect(g.state.rateWaitUntil).toBeGreaterThan(Date.now())
      // 最初の送信(t=0)から 60 秒後に送れる
      await vi.advanceTimersByTimeAsync(56500)
      await p
      expect(sent).toBe(true)
      expect(g.state.sentLastMinute).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('待機が maxWaitMs を超えるなら待たずに投げる（代替へ回すため）', async () => {
    const g = new JevGate(3)
    g.onTransientFailure(429, 60000)
    await expect(g.acquire(undefined, 1000)).rejects.toBeInstanceOf(GateWaitTooLongError)
  })
})

describe('evaluate: 並列呼び出しで混雑時に叩き続けない', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('1 件が 429 を受けたら、他の呼び出しも retry-after が明けるまで送信しない', async () => {
    const sentAt: number[] = []
    let first = true
    vi.stubGlobal('fetch', async () => {
      sentAt.push(Date.now())
      if (first) {
        first = false
        return new Response('{"error":{"message":"rate limited"}}', { status: 429, headers: { 'retry-after': '1' } })
      }
      return new Response(
        JSON.stringify({
          answers: { q: { type: 'choice', choice: 'A', probabilities: { A: 1 } } },
          usage: { inputTokens: 400, outputTokens: 0 },
          providerMetadata: { gateway: { marketCost: '0.0000168' } },
        }),
        { status: 200 },
      )
    })
    const q = { q: { type: 'choice' as const, instructions: 'x', criteria: { A: 'a' } } }
    const auth = { mode: 'key' as const, apiKey: 'k' }
    const t0 = Date.now()
    // 1 件目だけ先に送り 429 を受けさせる
    const firstCall = evaluate(auth, 's', q)
    await new Promise((r) => setTimeout(r, 30))
    const rest = await Promise.all([evaluate(auth, 's', q), evaluate(auth, 's', q)])
    const r1 = await firstCall
    // 429 以降の送信はすべて retry-after(1 秒) の後
    expect(sentAt.slice(1).every((t) => t - t0 >= 950)).toBe(true)
    expect(sentAt.length).toBe(4)
    expect(r1.usage).toEqual({ inputTokens: 400, outputTokens: 0, costUsd: 0.0000168 })
    expect(rest.every((r) => r.answers.q.choice === 'A')).toBe(true)
    expect(defaultGate.state.consecutiveFailures).toBe(0)
  })
})
