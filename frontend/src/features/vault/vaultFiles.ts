// Photos and files into My storage: encrypted in the browser one at a time, then uploaded
// through the shared upload engine (as ciphertext named "blob") and attached as an item.
import { formatBytes } from '../../lib/format'
import type { Uploader } from '../uploads/Uploader'
import type { FileMeta } from './api'
import { cipherSize, toB64 } from './crypto'
import type { VaultStore } from './store'

export const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const META_ALLOWANCE = 64 * 1024 // reserved per upload by the server for the item's metadata
const THUMB_WIDTH = 400
// a thumbnail is base64'd into the JSON, encrypted and base64'd again (about ×1.8): 34 KiB keeps the
// whole photo meta inside the server's 64 KiB metadata allowance
export const THUMB_MAX = 34 * 1024
const UNFINISHED = 'fs.vault.unfinished'

type Session = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

/** A small JPEG for the photo grid (re-encoding also drops EXIF/GPS). Undefined where unsupported. */
export async function makeThumb(file: Blob): Promise<string | undefined> {
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return undefined
  try {
    const bitmap = await createImageBitmap(file, { resizeWidth: THUMB_WIDTH, resizeQuality: 'medium' })
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
    bitmap.close()
    for (const quality of [0.7, 0.5, 0.35]) {
      const jpeg = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/jpeg', quality))
      if (jpeg && jpeg.size <= THUMB_MAX) return toB64(new Uint8Array(await jpeg.arrayBuffer()))
    }
  } catch {
    // not decodable here: the tile stays plain; the full photo still opens
  }
  return undefined
}

function waitForJob(uploader: Uploader, id: string, store: VaultStore): Promise<void> {
  return new Promise((done) => {
    const check = () => {
      const job = uploader.jobs().find((j) => j.id === id)
      if (job?.state === 'sending') store.touch() // a running upload is activity (no auto-lock)
      if (!job || job.state === 'done' || job.state === 'failed') {
        off()
        done()
      }
    }
    const off = uploader.onChange(check)
    check()
  })
}

/**
 * Add photos or files. Checks the type and the free space for the whole selection first, then
 * encrypts each file just before its own upload (only one ciphertext in memory at a time).
 */
export async function addVaultFiles(
  files: File[], kind: 'photo' | 'file', store: VaultStore, uploader: Uploader,
): Promise<{ error?: string; held?: number }> {
  if (!files.length) return {}
  if (kind === 'photo' && files.some((f) => !PHOTO_TYPES.includes(f.type))) {
    return { error: 'Only PNG, JPEG, GIF or WebP photos. Add it as a File instead.' }
  }
  const { usedBytes, quotaBytes, heldBytes } = store.snapshot()
  const free = Math.max(0, quotaBytes - usedBytes)
  const need = files.reduce((n, f) => n + cipherSize(f.size) + META_ALLOWANCE, 0)
  if (need > free) {
    return { error: `Not enough space in My storage (needs ${formatBytes(need)}, ${formatBytes(free)} free).`, held: heldBytes }
  }
  const locked = { error: 'My storage locked — add the rest again after unlocking.' }
  for (const file of files) {
    const keyGen = store.currentKeyGen()
    if (store.snapshot().status !== 'open' || !keyGen) return locked
    let blob: Blob
    let metaCt: string
    try {
      const thumb = kind === 'photo' ? await makeThumb(file) : undefined
      const sealed = await store.encryptFile(file)
      blob = sealed.blob
      const meta: FileMeta = {
        kind, name: file.name, size: file.size, prefix: sealed.prefix,
        mime: kind === 'photo' ? file.type : file.type || 'application/octet-stream',
        ...(thumb ? { thumb } : {}),
      }
      metaCt = await store.encrypt(meta) // before the upload: a lock mid-upload doesn't matter
    } catch (e) {
      if ((e as Error)?.name === 'Locked') return locked // locked while this file was being encrypted
      return { error: `Couldn't read "${file.name}". Choose it again.` }
    }
    const id = uploader.addVaultFile(blob, file.name, keyGen, async (blobId) => { await store.addEncrypted(metaCt, blobId, keyGen) })
    await waitForJob(uploader, id, store)
  }
  return {}
}

/** Before the tab goes: remember how many My storage uploads didn't finish (a count only). */
export function markUnfinished(uploader: Uploader, session: Session): void {
  const n = uploader.jobs().filter((j) => j.vault && j.state !== 'done' && j.state !== 'failed').length
  try {
    if (n) session.setItem(UNFINISHED, String(n))
  } catch {
    // storage blocked: no notice next time
  }
}

/** The count from last time, once. */
export function takeUnfinished(session: Session): number {
  try {
    const n = Number(session.getItem(UNFINISHED) ?? 0)
    session.removeItem(UNFINISHED)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}
