import { Icon } from '../../icons'

export const MAX_TEXT_BYTES = 1024 ** 2

export const textBytes = (s: string) => new TextEncoder().encode(s).length

type Props = { title: string; body: string; onTitle: (v: string) => void; onBody: (v: string) => void }

export function TextForm({ title, body, onTitle, onBody }: Props) {
  const tooLong = textBytes(body) > MAX_TEXT_BYTES
  const chars = [...body].length
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
