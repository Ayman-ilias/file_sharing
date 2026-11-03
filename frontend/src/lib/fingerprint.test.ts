// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { clientKey } from './fingerprint'

const file = (name: string, body: string, lastModified = 1_700_000_000_000, path = '') => {
  const f = new File([body], name, { lastModified })
  if (path) Object.defineProperty(f, 'webkitRelativePath', { value: path })
  return f
}

describe('clientKey', () => {
  it('is stable for the same file and targets', async () => {
    const f = file('a.txt', 'hello')
    expect(await clientKey(f, [3, 1], false)).toBe(await clientKey(f, [1, 3], false))
  })

  it('fits the server pattern', async () => {
    expect(await clientKey(file('a.txt', 'x'), [1], false)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('differs when only the recipients differ', async () => {
    const f = file('a.txt', 'hello')
    expect(await clientKey(f, [1], false)).not.toBe(await clientKey(f, [2], false))
    expect(await clientKey(f, [], true)).not.toBe(await clientKey(f, [], false))
  })

  it('sorts recipient ids numerically, not as text', async () => {
    const f = file('a.txt', 'hello')
    expect(await clientKey(f, [10, 9], false)).toBe(await clientKey(f, [9, 10], false))
  })

  it('differs for same name, size and date but different content', async () => {
    expect(await clientKey(file('a.txt', 'aaaa'), [1], false)).not.toBe(await clientKey(file('a.txt', 'bbbb'), [1], false))
  })

  it('never matches two files without a modified date', async () => {
    const a = file('a.txt', 'same', 0)
    const b = file('a.txt', 'same', 0)
    expect(await clientKey(a, [1], false)).not.toBe(await clientKey(b, [1], false))
  })

  it('includes the folder path', async () => {
    const a = file('x.txt', 'same', 1, 'top/a/x.txt')
    const b = file('x.txt', 'same', 1, 'top/b/x.txt')
    expect(await clientKey(a, [1], false)).not.toBe(await clientKey(b, [1], false))
  })

  it('reads only the first and last 64 KiB of a big file', async () => {
    const big = new File([new Uint8Array(1024 * 1024)], 'big.bin', { lastModified: 1 })
    const reads: number[] = []
    const realSlice = big.slice.bind(big)
    big.slice = (start?: number, end?: number, type?: string) => {
      reads.push((end ?? big.size) - (start ?? 0))
      return realSlice(start, end, type)
    }
    await clientKey(big, [1], false)
    expect(reads).toEqual([65536, 65536])
  })
})
