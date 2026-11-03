// Transfer speed over a 3 s moving window. Times are milliseconds (performance.now()).

const WINDOW = 3000

export class SpeedMeter {
  private start: number
  private samples: { t: number; bytes: number }[] = []

  constructor(now: number = performance.now()) {
    this.start = now
  }

  /** Start over, e.g. after a pause, so idle time doesn't drag the speed down. */
  reset(now: number = performance.now()): void {
    this.start = now
    this.samples = []
  }

  add(bytes: number, t: number = performance.now()): void {
    this.samples.push({ t, bytes })
    while (this.samples.length && this.samples[0].t <= t - WINDOW) this.samples.shift()
  }

  bytesPerSec(t: number = performance.now()): number {
    const span = Math.min(WINDOW, t - this.start)
    if (span <= 0) return 0
    let sum = 0
    for (const s of this.samples) if (s.t > t - WINDOW && s.t <= t) sum += s.bytes
    return (sum * 1000) / span
  }

  /** Whole seconds left, or null while the speed is unknown. */
  eta(remaining: number, t: number = performance.now()): number | null {
    const rate = this.bytesPerSec(t)
    return rate > 0 ? Math.ceil(remaining / rate) : null
  }
}
