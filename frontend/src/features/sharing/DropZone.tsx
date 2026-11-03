import { useEffect, useRef, type DragEvent } from 'react'
import { Icon } from '../../icons'
import { droppedFiles, droppedFolder } from '../../lib/dropped'

type Props = { folder: boolean; onFiles: (files: File[]) => void }

export function DropZone({ folder, onFiles }: Props) {
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (folder) input.current?.setAttribute('webkitdirectory', '') // not a React prop
  }, [folder])

  async function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault()
    const files = folder ? await droppedFolder(e.dataTransfer) : droppedFiles(e.dataTransfer)
    if (files && (folder || files.length)) onFiles(files) // an empty folder still gets its message
  }

  return (
    <div
      className="drop"
      role="button"
      tabIndex={0}
      style={{ cursor: 'pointer' }}
      onClick={() => input.current?.click()}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click() } }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => void onDrop(e)}
    >
      <div className="ic"><Icon name={folder ? 'i-folder' : 'i-up'} size={20} /></div>
      <b>{folder ? 'Drop a folder here' : 'Drop files here'}</b> or click to choose
      <small>{folder ? 'The folder structure is kept.' : 'Any size up to 10 GB. If your connection drops, it continues where it stopped.'}</small>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label={folder ? 'Choose a folder' : 'Choose files'}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = '' // the same file can be chosen again
          if (files.length || folder) onFiles(files)
        }}
      />
    </div>
  )
}
