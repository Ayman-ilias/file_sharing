// Plain text → text and link parts. Only http(s) and www addresses ever become links.

export type LinkPart = { href: string; text: string }

// a scheme or www must start the word: "xhttp://" and "javascript://www." don't count.
// Group 1 is the character before it (no lookbehind: Safari before 16.4 can't parse one).
const CANDIDATE = /(^|[^\w/:.@-])((?:https?:\/\/|www\.)[^\s<>"'`]+)/gi
const TRAILING = /[.,!?;:'")\]}]$/

function count(s: string, ch: string): number {
  return s.split(ch).length - 1
}

/** Drop trailing punctuation, but keep a closing bracket that has its opening one. */
function trim(url: string): string {
  while (TRAILING.test(url)) {
    const last = url[url.length - 1]
    const open = { ')': '(', ']': '[', '}': '{' }[last]
    if (open && count(url, open) >= count(url, last)) break
    url = url.slice(0, -1)
  }
  return url
}

function toHref(text: string): string | null {
  const href = /^www\./i.test(text) ? `https://${text}` : text
  try {
    const u = new URL(href)
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname.includes('.')) return null
    return u.href === `${href}/` ? href : u.href
  } catch {
    return null
  }
}

export function linkify(text: string): Array<string | LinkPart> {
  const out: Array<string | LinkPart> = []
  let at = 0
  for (const m of text.matchAll(CANDIDATE)) {
    const start = m.index + m[1].length
    const raw = trim(m[2])
    const href = toHref(raw)
    if (!href) continue
    if (start > at) out.push(text.slice(at, start))
    out.push({ href, text: raw })
    at = start + raw.length
  }
  if (at < text.length) out.push(text.slice(at))
  return out
}
