import { useState } from 'react'
import type { EntryOut } from '../../api/types'
import { entryUrl } from './urls'

const FIRST = 12

/** A folder's files: each one downloads on its own; the rest behind "+N more". */
export function FolderEntries({ itemId, entries }: { itemId: string; entries: EntryOut[] }) {
  const [all, setAll] = useState(false)
  const shown = all ? entries : entries.slice(0, FIRST)
  return (
    <div className="inside">
      {shown.map((e) => <a key={e.id} href={entryUrl(itemId, e.id)} download>{e.relative_path} ↓</a>)}
      {!all && entries.length > FIRST && (
        <span role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => setAll(true)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setAll(true) }}>
          +{entries.length - FIRST} more
        </span>
      )}
    </div>
  )
}
