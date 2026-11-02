// Sizes and times, worded like the design (en-US, the viewer's local time zone).

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const
type Unit = (typeof UNITS)[number]
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAY = 86_400_000

/** "18.4 MB", "200 MB"; with `digits` fixed ("1.80 GB"), optionally in a given unit ("0.76 GB"). */
export function formatBytes(n: number, digits?: number, unit?: Unit): string {
  let i = unit ? UNITS.indexOf(unit) : 0
  if (!unit) while (n >= 1024 ** (i + 1) && i < UNITS.length - 1) i++
  const v = n / 1024 ** i
  if (i === 0) return `${Math.round(v)} B`
  const text = digits === undefined ? String(Number(v.toFixed(1))) : v.toFixed(digits)
  return `${text} ${UNITS[i]}`
}

const toDate = (d: Date | string) => (typeof d === 'string' ? new Date(d) : d)

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Whole calendar days from `d` to `now` (0 = same day). */
function daysAgo(d: Date, now: Date): number {
  return Math.round((startOfDay(now) - startOfDay(d)) / DAY)
}

function clock(d: Date): string {
  const h = d.getHours() % 12 || 12
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'AM' : 'PM'}`
}

function shortDate(d: Date, now: Date): string {
  const base = `${MONTHS[d.getMonth()]} ${d.getDate()}`
  return d.getFullYear() === now.getFullYear() ? base : `${base}, ${d.getFullYear()}`
}

/** "just now", "2 min ago", "4:10 PM", "yesterday", "Oct 12". */
export function relativeTime(date: Date | string, now: Date = new Date()): string {
  const d = toDate(date)
  const mins = Math.floor((now.getTime() - d.getTime()) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const days = daysAgo(d, now)
  if (days === 0) return clock(d)
  if (days === 1) return 'yesterday'
  return shortDate(d, now)
}

/** The list's date headers: "Today", "Yesterday", "Oct 30". */
export function dayGroup(date: Date | string, now: Date = new Date()): string {
  const d = toDate(date)
  const days = daysAgo(d, now)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return shortDate(d, now)
}

/** A warning in the last 3 days before auto-delete, else null. */
export function expiresSoon(expires: Date | string, now: Date = new Date()): string | null {
  const days = (toDate(expires).getTime() - now.getTime()) / DAY
  if (days > 3) return null
  if (days < 1) return 'expires today'
  const n = Math.ceil(days)
  return `expires in ${n} ${n === 1 ? 'day' : 'days'}`
}
