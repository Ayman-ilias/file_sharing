import { useState } from 'react'

/** The bigger preview shown while hovering a photo card (CSS shows it on hover/focus). */
export function PhotoPeek({ src, name, size }: { src: string; name: string; size: string }) {
  const [dims, setDims] = useState('')
  return (
    <div className="peek" aria-hidden="true">
      <img src={src} alt="" loading="lazy"
        onLoad={(e) => setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)} />
      <div><b>{name}</b><span>{dims ? `${size} · ${dims}` : size}</span></div>
    </div>
  )
}
