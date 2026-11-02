import { Icon } from '../../icons'

export type View = 'sharing' | 'storage'

type Props = { value: View; onChange: (v: View) => void; showStorage: boolean }

export function TopTabs({ value, onChange, showStorage }: Props) {
  const tab = (v: View, icon: string, label: string, extra = '') => (
    <button
      className={`tt${value === v ? ' on' : ''}${extra}`}
      role="tab"
      aria-selected={value === v}
      onClick={() => onChange(v)}
    >
      <Icon name={icon} size={17} />
      {label}
    </button>
  )
  return (
    <nav className="top-tabs" role="tablist" aria-label="Section">
      {tab('sharing', 'i-share', 'Sharing', showStorage ? '' : ' solo')}
      {showStorage && tab('storage', 'i-lock', 'My storage')}
    </nav>
  )
}
