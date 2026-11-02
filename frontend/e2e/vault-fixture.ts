// The mockup's sample My storage, encrypted for real with the app's own crypto (src/features/vault/crypto.ts).
import { readFileSync } from 'node:fs'
import type { VaultItemOut, VaultMeta, VaultStatus } from '../src/features/vault/api'
import { ITERATIONS, deriveKek, encryptBlob, encryptMeta, newDataKey, newSalt, toB64, unwrapDataKey, wrapDataKey } from '../src/features/vault/crypto'
import { ROOT } from './fixtures'

export const VAULT_PASSWORD = 'secretsecret' // the mockup's lock screen shows 12 dots

export type VaultFixture = { status: VaultStatus; items: VaultItemOut[]; blobs: Map<string, Uint8Array> }

export async function vaultFixture(now: Date): Promise<VaultFixture> {
  const salt = newSalt()
  const kek = await deriveKek(VAULT_PASSWORD, salt, ITERATIONS)
  const wrapped = await wrapDataKey(await newDataKey(), kek)
  const key = await unwrapDataKey(wrapped, kek)
  const photo = new Uint8Array(readFileSync(`${ROOT}/docs/design/assets/sample-photo.jpg`))
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString()
  const MIN = 60_000
  const DAY = 86_400_000
  const items: VaultItemOut[] = []
  const blobs = new Map<string, Uint8Array>()
  let n = 0
  async function add(meta: VaultMeta, at: string, file?: Uint8Array) {
    const id = (++n).toString(16).padStart(32, '0')
    let full = meta
    if (file) {
      const { blob, prefix } = await encryptBlob(new Blob([file]), key)
      blobs.set(id, new Uint8Array(await blob.arrayBuffer()))
      full = { ...(meta as Extract<VaultMeta, { kind: 'photo' | 'file' }>), prefix }
    }
    const meta_ct = await encryptMeta(full, key)
    items.push({ id, meta_ct, blob_id: file ? id : null, size_bytes: meta_ct.length + (file?.length ?? 0), version: 1, created_at: at, updated_at: at })
  }
  // newest first, in the mockup's order inside each group
  await add({ kind: 'password', title: 'Office router admin', username: 'admin', url: '192.168.1.1', password: 'Uttara#Gw2026!', note: '' }, ago(1 * MIN))
  await add({ kind: 'password', title: 'Grafana', username: 'ayman@southerniot.net', url: '', password: 'g-7Kp!x92Lm', note: '' }, ago(2 * MIN))
  await add({ kind: 'note', title: 'Meeting notes, 28 Oct', text: 'Uttara rollout moves to 12 Nov. Need 6 more gateways from stock. Ask Rahim for the updated BOQ before Friday.' }, ago(2 * DAY))
  await add({ kind: 'link', title: 'Uttara dashboard', url: 'https://grafana.southerniot.net/d/uttara', note: 'Live readings for the Uttara site gateways.' }, ago(3 * DAY))
  for (let i = 0; i < 4; i++) {
    await add({ kind: 'photo', name: `site-${i + 1}.jpg`, mime: 'image/jpeg', size: photo.length, prefix: '', thumb: toB64(photo) }, ago((4 + i) * DAY), photo)
  }
  await add({ kind: 'file', name: 'Ayman-CV-2026.pdf', mime: 'application/pdf', size: 1.2 * 1024 * 1024, prefix: '' }, ago(21 * DAY), new Uint8Array(64))
  const status: VaultStatus = {
    initialized: true, salt, iterations: ITERATIONS, wrapped_key: wrapped, key_gen: 'fixturegen000001', kdf: 'pbkdf2-sha256',
    used_bytes: Math.round(84.6 * 1024 * 1024), quota_bytes: 209715200, item_count: items.length, held_bytes: 0,
  }
  return { status, items, blobs }
}
