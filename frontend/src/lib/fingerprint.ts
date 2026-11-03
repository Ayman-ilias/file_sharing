// The upload's client_key: the same file to the same people resumes; anything else starts fresh.

const EDGE = 64 * 1024

type Picked = Blob & { name: string; lastModified: number; webkitRelativePath?: string }

async function sha256(data: BufferSource | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** SHA-256 hex (64 chars) of name, size, date, folder path, the first and last 64 KiB, and the targets. */
export async function clientKey(file: Picked, recipientIds: number[], isGlobal: boolean): Promise<string> {
  const head = await file.slice(0, Math.min(EDGE, file.size)).arrayBuffer()
  const tail = await file.slice(Math.max(0, file.size - EDGE), file.size).arrayBuffer()
  // without a modified date two different files can look the same: never let them resume each other
  const date = file.lastModified ? String(file.lastModified) : `none-${crypto.randomUUID()}`
  const ids = isGlobal ? [] : [...new Set(recipientIds)].sort((a, b) => a - b)
  return sha256([
    file.name, file.size, date, file.webkitRelativePath ?? '',
    await sha256(head), await sha256(tail), ids.join(','), isGlobal ? 'global' : 'people',
  ].join('|'))
}
