// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { droppedFiles, droppedFolder } from './dropped'

type Entry = { isFile: boolean; isDirectory: boolean; name: string; file?: (ok: (f: File) => void) => void; createReader?: () => unknown }

const fileEntry = (name: string, body = 'x'): Entry => ({
  isFile: true, isDirectory: false, name, file: (ok) => ok(new File([body], name)),
})

/** A directory whose reader hands out entries in pages of 2 (browsers use pages of 100). */
const dirEntry = (name: string, children: Entry[]): Entry => ({
  isFile: false, isDirectory: true, name,
  createReader: () => {
    let at = 0
    return { readEntries: (ok: (e: Entry[]) => void) => { ok(children.slice(at, at + 2)); at += 2 } }
  },
})

const transfer = (entries: Entry[], files: File[] = []) => ({
  items: entries.map((e) => ({ kind: 'file', webkitGetAsEntry: () => e })),
  files,
}) as unknown as DataTransfer

describe('dropped folders', () => {
  it('reads a dropped folder with paths below its top folder, across reader pages', async () => {
    const dt = transfer([dirEntry('site', [fileEntry('a.txt'), dirEntry('sub', [fileEntry('b.txt'), fileEntry('c.txt'), fileEntry('d.txt')]), fileEntry('e.txt')])])
    const files = await droppedFolder(dt)
    expect(files?.map((f) => f.webkitRelativePath).sort()).toEqual(['site/a.txt', 'site/e.txt', 'site/sub/b.txt', 'site/sub/c.txt', 'site/sub/d.txt'])
  })

  it('gives null when no folder was dropped', async () => {
    expect(await droppedFolder(transfer([fileEntry('a.txt')]))).toBeNull()
  })

  it('droppedFiles keeps files and skips folders', () => {
    const a = new File(['a'], 'a.txt')
    const dt = transfer([fileEntry('a.txt'), dirEntry('site', [])], [a, new File([], 'site')])
    expect(droppedFiles(dt)).toEqual([a])
  })
})
