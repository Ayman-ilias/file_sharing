import { useMemo } from 'react'
import { linkify } from '../../lib/linkify'

/** User text as text nodes; only http(s)/www addresses become links (new tab, no opener). */
export function TextBody({ text, clamp }: { text: string; clamp: boolean }) {
  const parts = useMemo(() => linkify(text), [text]) // up to 1 MiB: once per text, not per render
  return (
    <div className={`preview${clamp ? ' clamp' : ''}`}>
      {parts.map((part, i) =>
        typeof part === 'string' ? part : (
          <a key={i} href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>
        ),
      )}
    </div>
  )
}
