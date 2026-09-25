export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t)
      reject(signal!.reason)
    }
    // 待ち終えたらリスナーを外す。同じ signal を長く使い回すと、待つたびにリスナーがたまっていくため
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
