import { Icon } from '../../icons'

type Props = { show: boolean; onSetOwn: () => void }

export function Nudge({ show, onSetOwn }: Props) {
  if (!show) return null
  return (
    <div className="nudge">
      <Icon name="i-shield" size={18} />
      <span>You are still using the shared starting password, so anyone who knows your email can sign in as you.</span>
      <button onClick={onSetOwn}>Set your own</button>
    </div>
  )
}
