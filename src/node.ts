import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Answer } from './client.js'
import type { RecordingStore } from './evaluator.js'

/** Node 用: JEV の回答の録画を 1 ファイルの JSON に保存する（ブラウザのバンドルに node:fs を入れないため別エントリ） */
export async function fileStore(path: string): Promise<RecordingStore & { size(): number }> {
  let data: Record<string, Record<string, Answer>> = {}
  try {
    data = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    /* 初回は空 */
  }
  let pending: Promise<void> = Promise.resolve()
  return {
    get: async (k) => data[k],
    set: async (k, v) => {
      data[k] = v
      // 並列呼び出しからの同時書き込みで壊れないよう直列化する
      pending = pending.then(async () => {
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, JSON.stringify(data))
      })
      await pending
    },
    size: () => Object.keys(data).length,
  }
}

export { createJevProxyHandler, jevDevProxy, startJevProxy, type JevProxyOptions, type JevProxyServer } from './proxy.js'
