import { describe, expect, it } from 'vitest'
import {
  JevError,
  memoryStore,
  mockEvaluator,
  recording,
  recordingKey,
  replayEvaluator,
  ReplayMissError,
  withFallback,
  type Evaluator,
} from '../src/index.js'

const q = { move: { type: 'choice' as const, instructions: 'pick', criteria: { A: 'a', B: 'b', BACK: 'back' } } }
const fakeJev: Evaluator = async () => ({ answers: { move: { type: 'choice', choice: 'A' } }, source: 'jev', usage: { inputTokens: 10, outputTokens: 0, costUsd: 1e-6 } })
const failing: Evaluator = async () => {
  throw new JevError('JEV 503', 503, true)
}

describe('evaluator', () => {
  it('録画キーはオブジェクトのキー順に依存しない', async () => {
    expect(await recordingKey({ a: 1, b: { c: 2, d: 3 } }, q)).toBe(await recordingKey({ b: { d: 3, c: 2 }, a: 1 }, q))
  })

  it('recording → replay で同じ回答を返し、source は replay・usage 無し', async () => {
    const store = memoryStore()
    await recording(fakeJev, store)('s', q)
    const r = await replayEvaluator(store)('s', q)
    expect(r.answers.move.choice).toBe('A')
    expect(r.source).toBe('replay')
    expect(r.usage).toBeUndefined()
  })

  it('録画に無い局面は ReplayMissError', async () => {
    await expect(replayEvaluator(memoryStore())('other', q)).rejects.toBeInstanceOf(ReplayMissError)
  })

  it('withFallback は失敗時に次へ回し、最初に成功した判断役の source を返す', async () => {
    const r = await withFallback(failing, replayEvaluator(memoryStore()), mockEvaluator({ avoidKeys: ['BACK'] }))('s', q)
    expect(r.source).toBe('mock')
  })

  it('mock の avoidKeys は選ばれにくい', async () => {
    const ev = mockEvaluator({ avoidKeys: ['BACK'] })
    const picks = await Promise.all(Array.from({ length: 40 }, () => ev('s', q)))
    const back = picks.filter((p) => p.answers.move.choice === 'BACK').length
    expect(back).toBeLessThan(10)
  })
})
