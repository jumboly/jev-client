import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'
import { sleep } from '../src/sleep.js'

describe('sleep', () => {
  it('待ち終えたら abort のリスナーを外す（同じ signal を使い回してもたまらない）', async () => {
    const ac = new AbortController()
    for (let i = 0; i < 3; i++) await sleep(1, ac.signal)
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0)
  })

  it('中断されたら signal の理由で reject する', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(new Error('stop')), 5)
    await expect(sleep(10000, ac.signal)).rejects.toThrow('stop')
  })
})
