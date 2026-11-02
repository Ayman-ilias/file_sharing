// An in-memory copy of /api/vault for tests (backend/app/routers/vault.py), enough for the store and screens.
import { vi } from 'vitest'
import { ApiError } from '../../api/client'
import type { VaultItemOut, VaultStatus } from './api'

export function fakeVault() {

  let key: { salt: string; iterations: number; wrapped_key: string; key_gen: string } | null = null
  const items = new Map<string, VaultItemOut>()
  let seq = 0
  const calls: string[] = []
  const status = (): VaultStatus => ({
    initialized: !!key, salt: key?.salt ?? null, iterations: key?.iterations ?? null,
    wrapped_key: key?.wrapped_key ?? null, key_gen: key?.key_gen ?? null, kdf: 'pbkdf2-sha256',
    used_bytes: [...items.values()].reduce((n, i) => n + i.size_bytes, 0), quota_bytes: 209715200,
    item_count: items.size, held_bytes: 0,
  })
  const out = (id: string, meta_ct: string, version = 1, blob_id: string | null = null): VaultItemOut => ({
    id, meta_ct, blob_id, size_bytes: meta_ct.length, version,
    created_at: new Date(2026, 10, 2, 10, seq).toISOString(), updated_at: new Date().toISOString(),
  })
  const api = {
    status: vi.fn(async () => status()),
    setup: vi.fn(async (b: { salt: string; iterations: number; wrapped_key: string }) => {
      calls.push('setup')
      if (key) throw new ApiError(409, 'already_initialized')
      key = { ...b, key_gen: 'gen' + ++seq }
    }),
    rekey: vi.fn(async (b: { salt: string; iterations: number; wrapped_key: string; previous_wrapped_key: string }) => {
      if (!key) throw new ApiError(404, 'not_initialized')
      if (key.wrapped_key !== b.previous_wrapped_key) throw new ApiError(409, 'stale_key')
      key = { ...key, salt: b.salt, iterations: b.iterations, wrapped_key: b.wrapped_key }
    }),
    erase: vi.fn(async () => { key = null; items.clear() }),
    items: vi.fn(async () => [...items.values()].reverse()),
    create: vi.fn(async (meta_ct: string, key_gen: string, blob_id?: string) => {
      if (!key) throw new ApiError(404, 'not_initialized')
      if (key_gen !== key.key_gen) throw new ApiError(409, 'key_changed')
      const it = out('i' + ++seq, meta_ct, 1, blob_id ?? null)
      items.set(it.id, it)
      return it
    }),
    update: vi.fn(async (id: string, meta_ct: string, version: number, key_gen: string) => {
      if (key_gen !== key?.key_gen) throw new ApiError(409, 'key_changed')
      const it = items.get(id)
      if (!it) throw new ApiError(404, 'not_found')
      if (it.version !== version) throw new ApiError(409, 'stale_version', { current: it })
      const next = { ...it, meta_ct, version: version + 1 }
      items.set(id, next)
      return next
    }),
    remove: vi.fn(async (id: string) => { items.delete(id) }),
    releaseHeld: vi.fn(async () => ({ released_bytes: 0 })),
    blobUrl: (id: string) => `/blob/${id}`,
  }
  return { api, items, calls, peek: () => key }
}

