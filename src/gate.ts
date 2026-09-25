import { sleep } from './sleep'

/**
 * 全 JEV 呼び出しで共有する流量制御。
 * JEV の 429/503 は「しばらく続く」傾向があり、複数 Runner がそれぞれ独立に再試行すると
 * 混雑中に叩き続けて待ち時間が延びる。そこで
 *  - 1 つでも失敗したら、retry-after（無ければ連続失敗数に応じた指数バックオフ）の時刻まで全員待つ
 *  - 失敗のたびに同時実行数を半減し、成功が続いたら 1 ずつ戻す（AIMD）
 *  - 429 を受けたら直近 1 分の成功数から上限を推定して送信ペースを落とし、429 が止んだら徐々に緩めて
 *    最終的に上限なしへ戻す（auto）。手動で上限を固定することもできる（manual）
 * を Worker / CLI プロセス内で一元管理する。
 *
 * 2026-09 時点の実測では 429 は毎分約 30 回の上限超過だったが、JEV 公開直後の混雑による一時的なものと
 * 考えられるため固定値としては持たず、発生時にだけ学習する（ユーザー判断 2026-09-25）。
 */

export interface GateState {
  /** この時刻（epoch ms）まで全呼び出しを止める。0 なら待機なし */
  cooldownUntil: number
  concurrency: number
  maxConcurrency: number
  inFlight: number
  consecutiveFailures: number
  lastStatus?: number
  /** auto: 429 発生時に学習し自動で緩める / manual: ratePerMin を固定 */
  rateMode: 'auto' | 'manual'
  /** 1 分あたりの送信上限（0 なら無制限） */
  ratePerMin: number
  /** 直近 60 秒の送信数 */
  sentLastMinute: number
  /** 回数上限のためこの時刻まで次の送信を待っている（UI 表示用、0 なら待機なし） */
  rateWaitUntil: number
}

export class GateWaitTooLongError extends Error {
  constructor(readonly waitMs: number) {
    super(`JEV 混雑のため待機中（残り ${Math.ceil(waitMs / 1000)} 秒）`)
  }
}

// 成功がこの回数続いたら同時実行数を 1 戻す
const RECOVER_AFTER = 5
const MAX_BACKOFF_MS = 60000
// auto: 学習した上限の下限（推定が極端に小さくなりゲームが止まるのを防ぐ）
const MIN_LEARNED_RATE = 5
// auto: 429 がこの間隔起きなければ上限を 25% 緩め、RELAX_CEIL を超えたら上限なしに戻す
const RELAX_INTERVAL_MS = 60000
const RELAX_FACTOR = 1.25
const RELAX_CEIL = 120

export class JevGate {
  private s: GateState
  private waiters: (() => void)[] = []
  private listeners = new Set<(s: GateState) => void>()
  private successStreak = 0

  private sent: number[] = []
  private successes: number[] = []
  private lastLimitedAt = 0

  constructor(maxConcurrency: number) {
    this.s = {
      cooldownUntil: 0,
      concurrency: maxConcurrency,
      maxConcurrency,
      inFlight: 0,
      consecutiveFailures: 0,
      rateMode: 'auto',
      ratePerMin: 0,
      sentLastMinute: 0,
      rateWaitUntil: 0,
    }
  }

  /** ratePerMin を 0 以下または未指定にすると auto（上限なしから開始し、429 時のみ学習） */
  configure(opts: { ratePerMin?: number }) {
    if (opts.ratePerMin && opts.ratePerMin > 0) {
      this.s.rateMode = 'manual'
      this.s.ratePerMin = opts.ratePerMin
    } else {
      this.s.rateMode = 'auto'
      this.s.ratePerMin = 0
    }
    this.notify()
    this.wake()
  }

  private relax(now: number) {
    if (this.s.rateMode !== 'auto' || !this.s.ratePerMin) return
    if (now - this.lastLimitedAt < RELAX_INTERVAL_MS) return
    const next = Math.ceil(this.s.ratePerMin * RELAX_FACTOR)
    this.s.ratePerMin = next > RELAX_CEIL ? 0 : next
    this.lastLimitedAt = now
    this.notify()
  }

  /** 直近 60 秒の送信時刻を保ち、上限に達しているなら次に送れる時刻を返す */
  private rateDelay(now: number): number {
    this.relax(now)
    this.sent = this.sent.filter((t) => now - t < 60000)
    this.s.sentLastMinute = this.sent.length
    if (!this.s.ratePerMin || this.sent.length < this.s.ratePerMin) return 0
    return this.sent[this.sent.length - this.s.ratePerMin] + 60000 - now
  }

  get state(): GateState {
    return { ...this.s }
  }

  subscribe(fn: (s: GateState) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private notify() {
    const st = this.state
    for (const l of this.listeners) l(st)
  }

  private wake() {
    const w = this.waiters
    this.waiters = []
    for (const r of w) r()
  }

  /**
   * 実行枠を得る。待機中なら待つ。maxWaitMs を超える待機が必要なら待たずに投げる
   * （代替の判断役があるときに早めに切り替えるため）。
   */
  async acquire(signal?: AbortSignal, maxWaitMs?: number): Promise<void> {
    for (;;) {
      signal?.throwIfAborted()
      const wait = this.s.cooldownUntil - Date.now()
      if (wait > 0) {
        if (maxWaitMs != null && wait > maxWaitMs) throw new GateWaitTooLongError(wait)
        await sleep(wait, signal)
        continue
      }
      const rw = this.rateDelay(Date.now())
      if (rw > 0) {
        // 上限待ちは代替への切り替え判定（maxWaitMs）の対象外: 数十秒待てば必ず送れるため
        this.s.rateWaitUntil = Date.now() + rw
        this.notify()
        await sleep(rw, signal)
        continue
      }
      if (this.s.inFlight < this.s.concurrency) {
        this.s.inFlight++
        this.sent.push(Date.now())
        this.s.sentLastMinute = this.sent.length
        this.s.rateWaitUntil = 0
        this.notify()
        return
      }
      await new Promise<void>((r) => this.waiters.push(r))
    }
  }

  release() {
    this.s.inFlight = Math.max(0, this.s.inFlight - 1)
    this.notify()
    this.wake()
  }

  onSuccess() {
    this.successes.push(Date.now())
    const wasCooling = this.s.consecutiveFailures > 0
    this.s.consecutiveFailures = 0
    if (++this.successStreak >= RECOVER_AFTER && this.s.concurrency < this.s.maxConcurrency) {
      this.s.concurrency++
      this.successStreak = 0
      this.wake()
      this.notify()
    } else if (wasCooling) this.notify()
  }

  /** 429 = 回数上限に達した。直近 1 分の成功数を上限とみなしてペースを落とす */
  private learnRate() {
    const now = Date.now()
    this.successes = this.successes.filter((t) => now - t < 60000)
    const learned = Math.max(MIN_LEARNED_RATE, this.successes.length)
    this.s.ratePerMin = this.s.ratePerMin ? Math.min(this.s.ratePerMin, learned) : learned
    this.lastLimitedAt = now
  }

  /** 一時的な失敗（429/503 等）。全員の待機時刻と同時実行数を更新し、待つべき時間を返す */
  onTransientFailure(status: number, retryAfterMs: number | null): number {
    this.successStreak = 0
    this.s.consecutiveFailures++
    this.s.lastStatus = status
    this.s.concurrency = Math.max(1, Math.floor(this.s.concurrency / 2))
    const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (this.s.consecutiveFailures - 1)) * (0.75 + Math.random() * 0.5)
    const wait = retryAfterMs && retryAfterMs > 0 ? retryAfterMs : backoff
    this.s.cooldownUntil = Math.max(this.s.cooldownUntil, Date.now() + wait)
    if (status === 429 && this.s.rateMode === 'auto') this.learnRate()
    this.notify()
    return this.s.cooldownUntil - Date.now()
  }
}
