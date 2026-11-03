import { useState, type KeyboardEvent } from 'react'
import type { Me, User } from '../../api/types'
import { Icon } from '../../icons'
import type { Target } from '../uploads/Uploader'

const MAX_SUGGESTIONS = 8
const GLOBAL = 'global'

type Props = { me: Me; users: User[]; value: Target; onChange: (t: Target) => void }

const initials = (name: string) => name.slice(0, 2).toUpperCase()

export function RecipientPicker({ me, users, value, onChange }: Props) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [hl, setHl] = useState(0)

  if (me.is_global) {
    return (
      <div className="field">
        <label>Send to</label>
        <div className="to"><span className="chip global"><Icon name="i-globe" size={13} />Global (everyone)</span></div>
        <div className="hintline">The shared global account can only share with everyone.</div>
      </div>
    )
  }

  const chosen = users.filter((u) => value.recipientIds.includes(u.id))
  const q = query.trim().toLowerCase()
  const matches = users
    .filter((u) => !value.recipientIds.includes(u.id))
    .filter((u) => !q || u.username.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
    .slice(0, MAX_SUGGESTIONS)
  const noMatch = q !== '' && matches.length === 0
  // Global is always first (unless it is already chosen)
  const options: (User | typeof GLOBAL)[] = noMatch ? [] : [...(value.isGlobal ? [] : [GLOBAL as typeof GLOBAL]), ...matches]

  function choose(o: User | typeof GLOBAL) {
    if (o === GLOBAL) onChange({ recipientIds: [], isGlobal: true }) // Global replaces the people
    else onChange({ recipientIds: [...value.recipientIds, o.id], isGlobal: false })
    setQuery('')
    setHl(0)
  }

  function removeLast() {
    if (value.isGlobal) onChange({ recipientIds: [], isGlobal: false })
    else onChange({ recipientIds: value.recipientIds.slice(0, -1), isGlobal: false })
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setHl((h) => Math.min(h + 1, options.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHl((h) => Math.max(h - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (open && options[hl]) choose(options[hl])
    } else if (e.key === 'Escape') {
      setOpen(false)
    } else if (e.key === 'Backspace' && query === '') {
      removeLast()
    }
  }

  return (
    <div className="field">
      <label htmlFor="send-to">Send to</label>
      <div className="to">
        {value.isGlobal && (
          <span className="chip global">
            <Icon name="i-globe" size={13} />Global (everyone)
            <button type="button" aria-label="Remove Global" onClick={() => onChange({ recipientIds: [], isGlobal: false })}>
              <Icon name="i-x" size={12} />
            </button>
          </span>
        )}
        {chosen.map((u) => (
          <span className="chip" key={u.id}>
            {u.username}
            <button type="button" aria-label={`Remove ${u.username}`}
              onClick={() => onChange({ recipientIds: value.recipientIds.filter((id) => id !== u.id), isGlobal: false })}>
              <Icon name="i-x" size={12} />
            </button>
          </span>
        ))}
        <input
          id="send-to"
          aria-label="Add recipient"
          placeholder="Type a name, or choose Global (everyone)"
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls="send-to-list"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setHl(0) }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKey}
        />
      </div>
      {open && (noMatch || options.length > 0) && (
        <div className="dd" id="send-to-list" role="listbox">
          {noMatch && (
            <div className="none">No colleague called "{query.trim()}". Only people who have registered appear here.</div>
          )}
          {options.map((o, i) => (
            <div
              key={o === GLOBAL ? GLOBAL : o.id}
              className={`o${i === hl ? ' hl' : ''}`}
              role="option"
              aria-selected={i === hl}
              onMouseDown={(e) => e.preventDefault()} // keep focus in the input
              onMouseEnter={() => setHl(i)}
              onClick={() => choose(o)}
            >
              {o === GLOBAL ? (
                <><span className="gl"><Icon name="i-globe" size={14} /></span><b>Global</b><small>everyone</small></>
              ) : (
                <><span className="ini">{initials(o.username)}</span>{o.username}<small>{o.email}</small></>
              )}
            </div>
          ))}
        </div>
      )}
      {value.isGlobal && <div className="hintline">Everyone at Southern IoT can see this, and it goes to the Global section.</div>}
    </div>
  )
}
