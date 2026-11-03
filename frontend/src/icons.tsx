// Icons come from the sprite in index.html (copied from docs/design by scripts/extract-design.mjs).
type IconProps = { name: string; size?: number; className?: string }

export function Icon({ name, size = 16, className }: IconProps) {
  return (
    <svg width={size} height={size} className={className} aria-hidden="true">
      <use href={`#${name}`} />
    </svg>
  )
}
