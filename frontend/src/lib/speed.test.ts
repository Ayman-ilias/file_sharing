import { describe, expect, it } from 'vitest'
import { SpeedMeter } from './speed'

const MB = 1_000_000

describe('SpeedMeter', () => {
  it('averages over the time since the start while under 3 s', () => {
    const m = new SpeedMeter(0)
    m.add(MB, 500)
    m.add(MB, 1000)
    expect(m.bytesPerSec(1000)).toBe(2 * MB)
    expect(m.eta(4 * MB, 1000)).toBe(2)
  })

  it('uses only the last 3 s once running longer', () => {
    const m = new SpeedMeter(0)
    m.add(10 * MB, 1000) // old burst, falls out of the window
    m.add(MB, 4000)
    m.add(MB, 5000)
    expect(m.bytesPerSec(5000)).toBeCloseTo((2 * MB) / 3)
  })

  it('reports 0 and no ETA before anything arrives', () => {
    const m = new SpeedMeter(0)
    expect(m.bytesPerSec(0)).toBe(0)
    expect(m.bytesPerSec(2000)).toBe(0)
    expect(m.eta(MB, 2000)).toBeNull()
  })

  it('starts over after reset (a pause does not drag the speed down)', () => {
    const m = new SpeedMeter(0)
    m.add(MB, 1000)
    m.reset(60_000)
    m.add(MB, 60_500)
    expect(m.bytesPerSec(60_500)).toBe(2 * MB)
  })

  it('rounds the ETA up to whole seconds', () => {
    const m = new SpeedMeter(0)
    m.add(MB, 1000)
    expect(m.eta(MB + 1, 1000)).toBe(2)
  })
})
