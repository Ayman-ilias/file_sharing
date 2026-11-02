import { linkify } from '../../lib/linkify'

/** User text as text nodes; only http(s)/www addresses become links (new tab, no opener). */
export function TextBody({ text, clamp }: { text: string; clamp: boolean }) {
  return (
    <div className={`preview${clamp ? ' clamp' : ''}`}>
      {linkify(text).map((part, i) =>
        typeof part === 'string' ? part : (
          <a key={i} href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>
        ),
      )}
    </div>
  )
}
