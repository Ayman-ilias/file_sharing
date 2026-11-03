// My storage API (backend/app/routers/vault.py). Only ciphertext crosses the wire.
import { api } from '../../api/client'

export type PasswordMeta = { kind: 'password'; title: string; username: string; url: string; password: string; note: string }
export type NoteMeta = { kind: 'note'; title: string; text: string }
export type LinkMeta = { kind: 'link'; title: string; url: string; note: string }
export type FileMeta = {
  kind: 'photo' | 'file'
  name: string
  mime: string
  size: number
  prefix: string // the blob's nonce prefix: a blob from another item won't decrypt
  thumb?: string // photos: a small JPEG, base64 (encrypted with the rest of the meta)
  note?: string
}
export type VaultMeta = PasswordMeta | NoteMeta | LinkMeta | FileMeta

export type VaultStatus = {
  initialized: boolean
  salt: string | null
  iterations: number | null
  wrapped_key: string | null
  key_gen: string | null
  kdf: string
  used_bytes: number
  quota_bytes: number
  item_count: number
  held_bytes: number
}

export type VaultItemOut = {
  id: string
  meta_ct: string
  blob_id: string | null
  size_bytes: number
  version: number
  created_at: string
  updated_at: string
}

type KeyBody = { salt: string; iterations: number; wrapped_key: string }

export const vaultApi = {
  status: () => api.get<VaultStatus>('/api/vault'),
  setup: (body: KeyBody) => api.send<void>('POST', '/api/vault/setup', body),
  rekey: (body: KeyBody & { previous_wrapped_key: string }) => api.send<void>('PUT', '/api/vault/key', body),
  erase: (loginPassword: string) => api.send<void>('POST', '/api/vault/erase', { confirm: 'ERASE', login_password: loginPassword }),
  items: () => api.get<VaultItemOut[]>('/api/vault/items'),
  create: (meta_ct: string, key_gen: string, blob_id?: string) =>
    api.send<VaultItemOut>('POST', '/api/vault/items', { meta_ct, key_gen, ...(blob_id ? { blob_id } : {}) }),
  update: (id: string, meta_ct: string, version: number, key_gen: string) =>
    api.send<VaultItemOut>('PUT', `/api/vault/items/${encodeURIComponent(id)}`, { meta_ct, version, key_gen }),
  remove: (id: string) => api.send<void>('DELETE', `/api/vault/items/${encodeURIComponent(id)}`),
  releaseHeld: () => api.send<{ released_bytes: number }>('POST', '/api/vault/release-held'),
  blobUrl: (id: string) => `/api/vault/items/${encodeURIComponent(id)}/blob`,
}
