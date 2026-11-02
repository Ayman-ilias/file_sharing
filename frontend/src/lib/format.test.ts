import { describe, expect, it } from 'vitest'
import { dayGroup, expiresSoon, formatBytes, relativeTime } from './format'

describe('formatBytes', () => {
  it('uses one trimmed decimal like the design', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(900)).toBe('900 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(18.4 * 1024 ** 2)).toBe('18.4 MB')
    expect(formatBytes(200 * 1024 ** 2)).toBe('200 MB')
    expect(formatBytes(1.8 * 1024 ** 3)).toBe('1.8 GB')
    expect(formatBytes(10 * 1024 ** 3)).toBe('10 GB')
  })

  it('uses fixed digits for upload progress', () => {
    expect(formatBytes(1.8 * 1024 ** 3, 2)).toBe('1.80 GB')
    expect(formatBytes(0.76 * 1024 ** 3, 2, 'GB')).toBe('0.76 GB')
  })
})

// local times, so the tests hold in any time zone
const now = new Date(2026, 10, 2, 16, 30)

describe('relativeTime', () => {
  it('says just now, minutes, clock time, yesterday, then the date', () => {
    expect(relativeTime(new Date(2026, 10, 2, 16, 29, 40), now)).toBe('just now')
    expect(relativeTime(new Date(2026, 10, 2, 16, 28), now)).toBe('2 min ago')
    expect(relativeTime(new Date(2026, 10, 2, 9, 5), now)).toBe('9:05 AM')
    expect(relativeTime(new Date(2026, 10, 2, 16, 10), now)).toBe('20 min ago')
    expect(relativeTime(new Date(2026, 10, 1, 22, 0), now)).toBe('yesterday')
    expect(relativeTime(new Date(2026, 9, 12, 8, 0), now)).toBe('Oct 12')
    expect(relativeTime(new Date(2025, 9, 12, 8, 0), now)).toBe('Oct 12, 2025')
  })

  it('treats a time slightly in the future (clock skew) as just now', () => {
    expect(relativeTime(new Date(2026, 10, 2, 16, 31), now)).toBe('just now')
  })

  it('accepts ISO strings from the API', () => {
    expect(relativeTime(new Date(2026, 10, 2, 16, 28).toISOString(), now)).toBe('2 min ago')
  })
})

describe('dayGroup', () => {
  it('groups by local day', () => {
    expect(dayGroup(new Date(2026, 10, 2, 0, 5), now)).toBe('Today')
    expect(dayGroup(new Date(2026, 10, 1, 23, 55), now)).toBe('Yesterday')
    expect(dayGroup(new Date(2026, 9, 30, 12), now)).toBe('Oct 30')
    expect(dayGroup(new Date(2025, 11, 30, 12), now)).toBe('Dec 30, 2025')
  })
})

describe('expiresSoon', () => {
  it('warns only in the last 3 days', () => {
    const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000)
    expect(expiresSoon(inDays(10), now)).toBeNull()
    expect(expiresSoon(inDays(3), now)).toBe('expires in 3 days')
    expect(expiresSoon(inDays(1.5), now)).toBe('expires in 2 days')
    expect(expiresSoon(inDays(1), now)).toBe('expires in 1 day')
    expect(expiresSoon(inDays(0.2), now)).toBe('expires today')
    expect(expiresSoon(inDays(-1), now)).toBe('expires today')
  })
})

describe('upload wording', () => {
  it('formatProgress puts both numbers in the total unit', async () => {
    const { formatProgress } = await import('./format')
    expect(formatProgress(1.04 * 1024 ** 3, 1.8 * 1024 ** 3)).toBe('1.04 GB of 1.80 GB')
    expect(formatProgress(40.2 * 1024 ** 2, 64.2 * 1024 ** 2)).toBe('40.2 MB of 64.2 MB')
    expect(formatProgress(0.5 * 1024 ** 2, 2 * 1024 ** 3)).toBe('0.00 GB of 2.00 GB')
  })

  it('formatSpeed and formatEta', async () => {
    const { formatSpeed, formatEta } = await import('./format')
    expect(formatSpeed(84.7 * 1024 ** 2)).toBe('84.7 MB/s')
    expect(formatEta(9)).toBe('9 s left')
    expect(formatEta(59)).toBe('59 s left')
    expect(formatEta(60)).toBe('1 min left')
    expect(formatEta(130)).toBe('3 min left')
    expect(formatEta(3900)).toBe('1 h 5 min left')
    expect(formatEta(7200)).toBe('2 h left')
  })
})
