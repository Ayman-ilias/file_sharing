import { useEffect, useRef, useState } from 'react'
import { Icon } from '../../icons'

type Props = { onConfirm: () => void; className?: string; confirmClassName?: string; size?: number }

/** The bin turns into a red "Delete?" for 4 s; a second click deletes. */
export function DeleteButton({ onConfirm, className = 'del', confirmClassName = 'confirm-del', size = 17 }: Props) {
  const [asking, setAsking] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  if (asking) {
    return (
      <button type="button" className={confirmClassName} autoFocus onClick={() => {
        if (timer.current) clearTimeout(timer.current)
        setAsking(false)
        onConfirm()
      }}>Delete?</button>
    )
  }
  return (
    <button type="button" className={className} aria-label="Delete" onClick={() => {
      setAsking(true)
      timer.current = setTimeout(() => setAsking(false), 4000)
    }}>
      <Icon name="i-trash" size={size} />
    </button>
  )
}
