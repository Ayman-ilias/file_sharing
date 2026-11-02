import { useEffect, useState, type CSSProperties } from 'react'
import { useMedia } from './media'

const BUBBLES = 15

/** Like v1: 15 bubbles with random size, place, drift and speed. */
function makeBubbles(): CSSProperties[] {
  return Array.from({ length: BUBBLES }, () => {
    const size = 30 + Math.random() * 90
    return {
      width: size,
      height: size,
      left: `${Math.random() * 100}%`,
      '--drift': `${Math.random() * 120 - 60}px`,
      animationDuration: `${26 + Math.random() * 24}s`,
      animationDelay: `${-Math.random() * 40}s`,
      opacity: Number((0.5 + Math.random() * 0.5).toFixed(2)),
    } as CSSProperties
  })
}

function useHidden(): boolean {
  const [hidden, setHidden] = useState(() => document.hidden)
  useEffect(() => {
    const on = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return hidden
}

/** The full-page animated gradient, plus floating bubbles on desktops only. */
export function Background() {
  const desktop = useMedia('(hover: hover) and (min-width: 641px)')
  const still = useMedia('(prefers-reduced-motion: reduce)')
  const hidden = useHidden()
  const [bubbles] = useState(makeBubbles) // random once per page
  const showBubbles = desktop && !still

  return (
    <>
      <div className="bg" aria-hidden="true"><i className="b1" /><i className="b2" /><i className="b3" /><i className="b4" /></div>
      <div className="bubbles" aria-hidden="true">
        {showBubbles && bubbles.map((style, i) => (
          <span key={i} style={{ ...style, animationPlayState: hidden ? 'paused' : 'running' }} />
        ))}
      </div>
    </>
  )
}
