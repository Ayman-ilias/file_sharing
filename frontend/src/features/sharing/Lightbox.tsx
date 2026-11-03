import { useEffect } from 'react'
import { Icon } from '../../icons'
import { DeleteButton } from './DeleteButton'

type Props = { src: string; label: string; name: string; onClose: () => void; onDownload: () => void; onDelete: () => void }

/** Full-screen photo (the tap target on phones), with Download, Delete and Close. */
export function Lightbox({ src, label, name, onClose, onDownload, onDelete }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="overlay" style={{ justifyContent: 'center', alignItems: 'center', padding: 16 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="lightbox" role="dialog" aria-modal="true" aria-label={name} style={{ width: 'min(1100px, 100%)' }}>
        <img src={src} alt={name} style={{ height: 'auto', maxHeight: '78vh', objectFit: 'contain' }} />
        <div className="lb-bar">
          <span>{label}</span>
          <button type="button" onClick={onDownload}><Icon name="i-down" size={15} />Download</button>
          <DeleteButton onConfirm={onDelete} className="" confirmClassName="" size={15} />
          <button type="button" aria-label="Close" autoFocus onClick={onClose}><Icon name="i-x" size={15} /></button>
        </div>
      </div>
    </div>
  )
}
