import { Icon } from '../../icons'
import type { Section } from './useItems'

type Props = { value: Section; onChange: (s: Section) => void; counts: Record<Section, string> }

export function SectionSwitch({ value, onChange, counts }: Props) {
  const btn = (s: Section, icon: string, label: string) => (
    <button type="button" className={`seg-btn${value === s ? ' on' : ''}`} role="tab" aria-selected={value === s} onClick={() => onChange(s)}>
      <Icon name={icon} size={16} />{label}<span className="cnt">{counts[s]}</span>
    </button>
  )
  return (
    <div className="switch-wrap">
      <div className="seg" role="tablist" aria-label="Which files">
        {btn('private', 'i-lock', 'Private')}
        {btn('global', 'i-globe', 'Global')}
      </div>
    </div>
  )
}
