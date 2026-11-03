import { useEffect, useState, type FormEvent } from 'react'
import { ApiError } from '../../api/client'
import { Icon } from '../../icons'
import { formatBytes } from '../../lib/format'
import type { VaultStore } from './store'

type Props = { store: VaultStore; usedBytes: number; itemCount: number; onClose: () => void }

/** Forgot the storage password: delete everything and start again (ERASE + login password). */
export function EraseDialog({ store, usedBytes, itemCount, onClose }: Props) {
  const [word, setWord] = useState('')
  const [login, setLogin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (word !== 'ERASE' || !login || busy) return
    setBusy(true)
    setError(null)
    try {
      await store.erase(login)
      onClose()
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? 'Login password is wrong.' : "Couldn't erase it. Try again.")
    } finally {
      setBusy(false)
    }
  }

  const items = `${itemCount.toLocaleString('en-US')} ${itemCount === 1 ? 'item' : 'items'}`
  return (
    <div className="overlay" style={{ justifyContent: 'center', alignItems: 'center', padding: 16 }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form className="card pad" role="dialog" aria-modal="true" aria-label="Erase My storage" onSubmit={submit}
        style={{ width: 'min(460px, 100%)', textAlign: 'left' }}>
        <div className="modal-h"><h3>Erase My storage</h3>
          <button type="button" className="mini" aria-label="Close" onClick={onClose}><Icon name="i-x" size={16} /></button></div>
        <div className="erase-box"><b>This permanently deletes everything in My storage</b> ({formatBytes(usedBytes)}, {items}). It can't be undone. Your shared files are not affected.</div>
        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="erase-login">Your login password</label>
          <input id="erase-login" className="input" type="password" autoComplete="current-password" autoFocus
            value={login} onChange={(e) => setLogin(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="erase-word">Type ERASE to confirm</label>
          <input id="erase-word" className="input" autoComplete="off" value={word} onChange={(e) => setWord(e.target.value)} />
        </div>
        {error && <div className="err-msg" role="alert"><Icon name="i-alert" size={14} />{error}</div>}
        <div className="actions-r">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn red" disabled={word !== 'ERASE' || !login || busy}
            style={word !== 'ERASE' || !login ? { opacity: 0.5 } : undefined}>Erase and start again</button>
        </div>
      </form>
    </div>
  )
}
