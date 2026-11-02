import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { fakeServer, memoryStorage } from './fakeServer'
import { Uploader } from './Uploader'
import { useUploads } from './useUploads'

describe('useUploads', () => {
  it('re-renders with the jobs when the engine changes', async () => {
    const srv = fakeServer({ delay: 50 })
    const up = new Uploader({ api: srv.api, env: new EventTarget(), storage: memoryStorage(), online: () => true })
    const { result } = renderHook(() => useUploads(up))
    expect(result.current.jobs).toEqual([])
    await act(() => up.addFiles([new File(['abcdefgh'], 'a.txt', { lastModified: 1 })], { recipientIds: [], isGlobal: true }))
    expect(result.current.jobs.map((j) => j.name)).toEqual(['a.txt'])
    expect(result.current.uploader).toBe(up)
  })
})
