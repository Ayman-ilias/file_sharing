import { Icon } from '../../icons'

export const MAX_TEXT_BYTES = 1024 ** 2

/** Over the 1 MiB server limit (UTF-8)? At most 3 bytes per UTF-16 unit, so short texts skip the encode. */
export const isTooLong = (s: string) => s.length * 3 > MAX_TEXT_BYTES && new TextEncoder().encode(s).length > MAX_TEXT_BYTES

/** Characters as people count them (an emoji is one), without copying a 1 MiB string. */
function charCount(s: string): number {
  let pairs = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff) pairs++
  }
  return s.length - pairs
}

type Props = { title: string; body: string; onTitle: (v: string) => void; onBody: (v: string) => void }

export function TextForm({ title, body, onTitle, onBody }: Props) {
  const tooLong = isTooLong(body)
  const chars = charCount(body)
  return (
    <div id="p-text">
      <div className="field">
        <label htmlFor="text-title">Title <span style={{ fontWeight: 400, color: 'var(--faint)' }}>(optional)</span></label>
        <input id="text-title" className="input" placeholder="Give your text a name" maxLength={200}
          value={title} onChange={(e) => onTitle(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="text-body">Text</label>
        <textarea id="text-body" placeholder="Type or paste text here" value={body} onChange={(e) => onBody(e.target.value)} />
        <div className="count">{chars.toLocaleString('en-US')} {chars === 1 ? 'character' : 'characters'}</div>
        {tooLong && <div className="err-msg" role="alert"><Icon name="i-alert" size={14} />Too long — send it as a file</div>}
      </div>
    </div>
  )
}
