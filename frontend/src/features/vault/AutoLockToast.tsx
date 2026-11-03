import { Icon } from '../../icons'

export function AutoLockToast({ onStay }: { onStay: () => void }) {
  return (
    <div style={{ position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 60, width: 'min(460px, calc(100% - 32px))' }}>
      <div className="toast" role="status">
        <Icon name="i-lock" size={18} />My storage locks in 60 s because you've been away.
        <button type="button" onClick={onStay}>Stay unlocked</button>
      </div>
    </div>
  )
}
