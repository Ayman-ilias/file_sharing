// Every URL is built from ids only, each one encoded.
const enc = encodeURIComponent

export const itemUrl = (id: string) => `/api/items/${enc(id)}`
export const inlineUrl = (id: string) => `/api/items/${enc(id)}/download?inline=1`
export const downloadUrl = (id: string) => `/api/items/${enc(id)}/download`
export const zipUrl = (id: string) => `/api/items/${enc(id)}/zip`
export const entriesUrl = (id: string) => `/api/items/${enc(id)}/entries`
export const entryUrl = (id: string, entryId: string) => `/api/items/${enc(id)}/entries/${enc(entryId)}/download`

/** Start a download without leaving the page (the server sends Content-Disposition: attachment). */
export function startDownload(url: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = ''
  document.body.appendChild(a)
  a.click()
  a.remove()
}
