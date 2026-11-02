import { Icon } from '../../icons'

export type Toast = { id: number; text: string; icon: string }

/** Short notes at the bottom of the screen (plain text only). */
export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div aria-live="polite" style={{
      position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 60,
      display: 'grid', gap: 8, width: 'min(440px, calc(100% - 32px))',
    }}>
      {toasts.map((t) => <div className="toast" key={t.id}><Icon name={t.icon} size={18} />{t.text}</div>)}
    </div>
  )
}
