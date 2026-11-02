import { useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../icons'
import { DeleteButton } from '../sharing/DeleteButton'
import { Lightbox } from '../sharing/Lightbox'
import { startDownload } from '../sharing/urls'
import { formatBytes } from '../../lib/format'
import type { FileMeta } from './api'
import { Corrupt, fromB64 } from './crypto'
import type { DecryptedItem, VaultStore } from './store'
import { PHOTO_TYPES } from './vaultFiles'

type Props = { items: DecryptedItem[]; store: VaultStore; onToast: (t: string) => void }

const metaOf = (i: DecryptedItem) => i.meta as FileMeta
/** Only real image types are shown as images; anything else is opened as plain bytes. */
const safeMime = (m: FileMeta) => (PHOTO_TYPES.includes(m.mime) ? m.mime : 'application/octet-stream')

/** Saves a decrypted vault file under its name. The bytes are always typed as plain data. */
export async function downloadVaultFile(store: VaultStore, item: DecryptedItem): Promise<void> {
  const blob = await store.openBlob(item, 'application/octet-stream')
  const url = URL.createObjectURL(blob)
  startDownload(url, metaOf(item).name)
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function PhotoGrid({ items, store, onToast }: Props) {
  const [open, setOpen] = useState<{ item: DecryptedItem; url: string } | null>(null)
  const openUrl = useRef<string | null>(null)

  // tiles: the small thumbnail from the (already decrypted) metadata. Keyed on ids and versions:
  // the parent builds a new array on every render (upload progress), the photos don't change.
  const signature = items.map((i) => `${i.id}:${i.version}`).join(',')
  const thumbs = useMemo(() => {
    const made = new Map<string, string>()
    for (const i of items) {
      const t = metaOf(i).thumb
      if (t) made.set(i.id, URL.createObjectURL(new Blob([fromB64(t)], { type: 'image/jpeg' })))
    }
    return made
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature])
  useEffect(() => () => thumbs.forEach((u) => URL.revokeObjectURL(u)), [thumbs])

  useEffect(() => () => { if (openUrl.current) URL.revokeObjectURL(openUrl.current) }, [])

  function close() {
    if (openUrl.current) URL.revokeObjectURL(openUrl.current)
    openUrl.current = null
    setOpen(null)
  }

  function failed(e: unknown) {
    onToast(e instanceof Corrupt ? "This file can't be decrypted" : "Couldn't open it. Try again.")
  }

  async function view(item: DecryptedItem) {
    try {
      const url = URL.createObjectURL(await store.openBlob(item, safeMime(metaOf(item))))
      if (openUrl.current) URL.revokeObjectURL(openUrl.current)
      openUrl.current = url
      setOpen({ item, url })
    } catch (e) {
      failed(e)
    }
  }

  async function remove(item: DecryptedItem) {
    close()
    try {
      await store.remove(item.id)
    } catch {
      onToast("Couldn't delete it. Try again.")
    }
  }

  return (
    <div className="photos">
      {items.map((i) => {
        const m = metaOf(i)
        const thumb = thumbs.get(i.id)
        return (
          <div className="phw" key={i.id}>
            <div className="ph" role="button" tabIndex={0} aria-label={`Open ${m.name}`}
              style={thumb ? { backgroundImage: `url(${thumb})` } : undefined}
              onClick={() => void view(i)}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void view(i) } }} />
            <div className="ph-act">
              <button type="button" aria-label="Download" onClick={() => void downloadVaultFile(store, i).catch(failed)}>
                <Icon name="i-down" size={16} />
              </button>
              <DeleteButton className="d" size={16} onConfirm={() => void remove(i)} />
            </div>
          </div>
        )
      })}
      {open && (
        <Lightbox src={open.url} name={metaOf(open.item).name}
          label={`${metaOf(open.item).name} · ${formatBytes(metaOf(open.item).size)}`}
          onClose={close} onDownload={() => void downloadVaultFile(store, open.item).catch(failed)}
          onDelete={() => void remove(open.item)} />
      )}
    </div>
  )
}
