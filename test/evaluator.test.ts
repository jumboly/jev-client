import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  evaluate,
  isRecoverable,
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
// 偽物は質問の型に依存しない固定の回答を返すので、Evaluator の型引数に合わせてキャストする
const fakeJev = (async () => ({
  answers: { move: { type: 'choice', choice: 'A', probabilities: { A: 0.9, B: 0.05, BACK: 0.05 } } },
  source: 'jev',
  usage: { inputTokens: 10, outputTokens: 0, costUsd: 1e-6 },
})) as unknown as Evaluator
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

  it('回答の型は質問の形から決まる', async () => {
    const r = await evaluate({ mode: 'mock' }, 's', {
      move: { type: 'choice', instructions: 'pick', criteria: { A: 'a', B: 'b' } },
      level: { type: 'score', instructions: 'lv', criteria: ['低', '高'] },
      ok: { type: 'boolean', instructions: 'ok?' },
    })
    expectTypeOf(r.answers.move.choice).toEqualTypeOf<'A' | 'B'>()
    expectTypeOf(r.answers.move.probabilities).toEqualTypeOf<Record<'A' | 'B', number>>()
    expectTypeOf(r.answers.level.score).toEqualTypeOf<number>()
    expectTypeOf(r.answers.ok.probability).toEqualTypeOf<number>()
    const e = await mockEvaluator()('s', q)
    expectTypeOf(e.answers.move.choice).toEqualTypeOf<'A' | 'B' | 'BACK'>()
  })

  it('mock も実際の応答と同じく全選択肢・全段階の確率を返す', async () => {
    const r = await evaluate({ mode: 'mock' }, 's', {
      move: q.move,
      level: { type: 'score', instructions: 'lv', criteria: ['低', '中', '高'] },
    })
    expect(Object.keys(r.answers.move.probabilities).sort()).toEqual(['A', 'B', 'BACK'])
    expect(Object.keys(r.answers.level.probabilities)).toEqual(['0', '1', '2'])
  })

  it('isRecoverable: 中断は false、再試行できない JevError は false、それ以外は true', () => {
    expect(isRecoverable(new DOMException('aborted', 'AbortError'))).toBe(false)
    expect(isRecoverable(new JevError('JEV 400', 400, false))).toBe(false)
    expect(isRecoverable(new JevError('JEV 503', 503, true))).toBe(true)
    expect(isRecoverable(new ReplayMissError())).toBe(true)
  })
})
