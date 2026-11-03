// My storage state, outside React (like the upload engine). The data key lives only in this
// object's memory: never in React state, storage or logs. Tabs that are open share lock, unlock,
// activity and changes over BroadcastChannel("fs-vault"); a tab opened later starts locked.
import { ApiError } from '../../api/client'
import type { FileMeta, VaultItemOut, VaultMeta, VaultStatus, vaultApi } from './api'
import {
  ITERATIONS, WrongPassword, decryptBlob, decryptMeta, deriveKek, encryptBlob, encryptMeta, newDataKey, newSalt,
  unwrapDataKey, wrapDataKey,
} from './crypto'

export { WrongPassword }

export class Locked extends Error { name = 'Locked' }
export class StaleVersion extends Error { name = 'StaleVersion' }
export class Deleted extends Error { name = 'Deleted' }
export class KeyChanged extends Error { name = 'KeyChanged' }
export class StaleKey extends Error { name = 'StaleKey' }
export class OwnPasswordRequired extends Error { name = 'OwnPasswordRequired' }

export type VaultState = 'loading' | 'unavailable' | 'setup' | 'locked' | 'open'
export type LockReason = 'idle' | 'manual' | 'other-tab' | null
export type DecryptedItem = VaultItemOut & ({ meta: VaultMeta; broken?: false } | { meta: null; broken: true })

export type VaultSnapshot = {
  status: VaultState
  lockedBecause: LockReason
  items: DecryptedItem[]
  usedBytes: number
  quotaBytes: number
  itemCount: number
  heldBytes: number
  lockWarning: boolean
}

type ChannelLike = { onmessage: ((e: { data: unknown }) => void) | null; postMessage(d: unknown): void; close(): void }
type Msg =
  | { t: 'unlocked'; uid: number; keyGen: string; key: CryptoKey }
  | { t: 'locked'; uid: number }
  | { t: 'changed'; uid: number }
  | { t: 'erased'; uid: number }
  | { t: 'rekeyed'; uid: number }
  | { t: 'active'; uid: number; at: number }

type Deps = {
  api: typeof vaultApi
  env?: EventTarget
  channel?: ((name: string) => ChannelLike) | null
}

export const IDLE = 20 * 60_000
export const WARN = 60_000
const TICK = 15_000
const SHARE_ACTIVITY = 30_000

export class VaultStore {
  private readonly api: typeof vaultApi
  private readonly env: EventTarget
  private readonly channel: ChannelLike | null
  private key: CryptoKey | null = null
  private keyGen: string | null = null
  private uid: number | null = null
  private state: VaultSnapshot = {
    status: 'loading', lockedBecause: null, items: [], usedBytes: 0, quotaBytes: 0, itemCount: 0, heldBytes: 0, lockWarning: false,
  }
  private listeners = new Set<() => void>()
  private lastActive = Date.now()
  private lastShared = 0
  private tick: ReturnType<typeof setInterval> | null = null

  constructor(deps: Deps) {
    this.api = deps.api
    this.env = deps.env ?? (typeof window !== 'undefined' ? window : new EventTarget())
    const make = deps.channel !== undefined ? deps.channel
      : typeof BroadcastChannel === 'function' ? (n: string) => new BroadcastChannel(n) as unknown as ChannelLike : null
    this.channel = make?.('fs-vault') ?? null
    if (this.channel) this.channel.onmessage = (e) => void this.onMessage(e.data as Msg)
    if (typeof crypto === 'undefined' || !crypto.subtle) this.set({ status: 'unavailable' })
    const active = () => this.touch()
    for (const type of ['keydown', 'pointerdown', 'wheel']) this.env.addEventListener(type, active)
    this.env.addEventListener('visibilitychange', () => this.check(true))
    // only this tab drops its key (bfcache); the other open tabs keep theirs, and their forms
    this.env.addEventListener('pagehide', () => this.lock(null, false))
    this.env.addEventListener('fs:signed-out', () => this.lock(null, false))
    this.env.addEventListener('fs:signed-in', (e) => this.signedIn((e as CustomEvent<{ id?: number }>).detail?.id))
  }

  // ---------- reading ----------

  onChange = (cb: () => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  snapshot = (): VaultSnapshot => {
    this.check(false)
    return this.state
  }

  heldKeyForTest = () => this.key
  forceStatusForTest = (status: VaultState) => this.set({ status })
  forcePatchForTest = (patch: Partial<VaultSnapshot>) => this.set(patch)

  // ---------- life cycle ----------

  async load(): Promise<void> {
    if (this.state.status === 'unavailable') return
    const st = await this.api.status()
    this.applyStatus(st)
    if (!this.key) this.set({ status: st.initialized ? 'locked' : 'setup' })
  }

  async setup(password: string): Promise<void> {
    const salt = newSalt()
    const kek = await deriveKek(password, salt, ITERATIONS)
    const wrapped = await wrapDataKey(await newDataKey(), kek)
    try {
      await this.api.setup({ salt, iterations: ITERATIONS, wrapped_key: wrapped })
    } catch (e) {
      if (e instanceof ApiError && e.status === 403 && e.detail === 'own_password_required') throw new OwnPasswordRequired()
      if (e instanceof ApiError && e.detail === 'already_initialized') {
        await this.load() // made already (a lost answer, another tab): try this password on it
        return this.unlock(password)
      }
      throw e
    }
    const st = await this.api.status()
    this.applyStatus(st)
    // keep a non-extractable copy only (the generated key had to be extractable to be wrapped)
    await this.open(await unwrapDataKey(wrapped, kek), st.key_gen!)
  }

  async unlock(password: string): Promise<void> {
    const st = await this.api.status()
    this.applyStatus(st)
    if (!st.initialized) return this.set({ status: 'setup' })
    const kek = await deriveKek(password, st.salt!, st.iterations!)
    await this.open(await unwrapDataKey(st.wrapped_key!, kek), st.key_gen!)
  }

  lock(reason: LockReason = 'manual', share = true): void {
    if (!this.key && this.state.status !== 'open') return
    this.key = null
    this.stopTick()
    this.set({ status: 'locked', lockedBecause: reason, items: [], lockWarning: false })
    if (share) this.post({ t: 'locked' })
  }

  /** Activity: key presses, pointer, wheel, and running vault uploads. Shared with open tabs. */
  touch(): void {
    if (!this.key) return
    this.lastActive = Date.now()
    if (this.lastActive - this.lastShared >= SHARE_ACTIVITY) {
      this.lastShared = this.lastActive
      this.post({ t: 'active', at: this.lastActive })
    }
    this.check(true)
  }

  async erase(loginPassword: string): Promise<void> {
    await this.api.erase(loginPassword)
    this.wiped()
    this.post({ t: 'erased' })
  }

  /** Re-wrap the same data key with a new password. Works while locked; doesn't unlock. */
  async changePassword(current: string, next: string): Promise<void> {
    const st = await this.api.status()
    if (!st.initialized) throw new Locked()
    const oldKek = await deriveKek(current, st.salt!, st.iterations!)
    const dataKey = await unwrapDataKey(st.wrapped_key!, oldKek, { extractable: true }) // only here, briefly
    const salt = newSalt()
    const wrapped = await wrapDataKey(dataKey, await deriveKek(next, salt, ITERATIONS))
    try {
      await this.api.rekey({ salt, iterations: ITERATIONS, wrapped_key: wrapped, previous_wrapped_key: st.wrapped_key! })
    } catch (e) {
      if (e instanceof ApiError && e.detail === 'stale_key') throw new StaleKey()
      throw e
    }
    this.post({ t: 'rekeyed' })
  }

  // ---------- items ----------

  async refresh(): Promise<void> {
    const st = await this.api.status()
    this.applyStatus(st)
    if (!this.key) return
    const key = this.key
    const rows = await this.api.items()
    const items = await Promise.all(rows.map((r) => this.decrypt(r, key)))
    if (this.key === key) this.set({ items })
  }

  async encrypt(meta: VaultMeta): Promise<string> {
    if (!this.key) throw new Locked()
    return encryptMeta(meta, this.key)
  }

  /** [Cancel it]: free space held by this user's vault uploads that went quiet (a reloaded tab). */
  async releaseHeld(): Promise<void> {
    await this.api.releaseHeld()
    await this.refreshUsage()
  }

  /** The data key's generation, for vault uploads (not secret). */
  currentKeyGen(): string | null {
    return this.keyGen
  }

  async encryptFile(file: Blob): Promise<{ blob: Blob; prefix: string }> {
    if (!this.key) throw new Locked()
    return encryptBlob(file, this.key)
  }

  /** Fetch and decrypt an item's blob. `mime` is what the result is typed as (downloads: octet-stream). */
  async openBlob(item: DecryptedItem, mime: string): Promise<Blob> {
    const key = this.key
    if (!key || !item.meta || (item.meta.kind !== 'file' && item.meta.kind !== 'photo')) throw new Locked()
    const meta = item.meta as FileMeta
    const res = await fetch(this.api.blobUrl(item.id), { credentials: 'same-origin' })
    if (!res.ok) throw new ApiError(res.status, res.status === 404 ? 'not_found' : `http_${res.status}`)
    return decryptBlob(await res.blob(), key, mime, meta.prefix)
  }

  async add(meta: VaultMeta): Promise<DecryptedItem> {
    const metaCt = await this.encrypt(meta)
    return this.addEncrypted(metaCt)
  }

  /** Save an item whose meta is already encrypted (vault uploads: a lock mid-upload doesn't matter). */
  async addEncrypted(metaCt: string, blobId?: string, keyGen = this.keyGen): Promise<DecryptedItem> {
    if (!keyGen) throw new Locked()
    // the generation the meta was encrypted under: an erase + new setup in between is refused
    const row = await this.guard(() => this.api.create(metaCt, keyGen, blobId))
    const item = this.key ? await this.decrypt(row, this.key) : ({ ...row, meta: null, broken: true } as DecryptedItem)
    if (this.key) this.set({ items: [item, ...this.state.items] })
    this.post({ t: 'changed' })
    void this.refreshUsage()
    return item
  }

  /**
   * Save an edit. `baseVersion` is the version the form was opened with: if another tab saved in
   * between, the server says stale even though this tab has refreshed (no silent overwrite).
   */
  async update(id: string, meta: VaultMeta, baseVersion?: number): Promise<DecryptedItem> {
    const current = this.state.items.find((i) => i.id === id)
    if (!current) throw new Deleted()
    const version = baseVersion ?? current.version
    const metaCt = await this.encrypt(meta)
    try {
      const row = await this.guard(() => this.api.update(id, metaCt, version, this.keyGen!))
      const item = await this.decrypt(row, this.key!)
      this.replace(item)
      this.post({ t: 'changed' })
      return item
    } catch (e) {
      if (e instanceof ApiError && e.detail === 'stale_version' && this.key) {
        this.replace(await this.decrypt(e.extra.current as VaultItemOut, this.key))
        throw new StaleVersion()
      }
      if (e instanceof ApiError && e.status === 404) {
        this.set({ items: this.state.items.filter((i) => i.id !== id) })
        throw new Deleted()
      }
      throw e
    }
  }

  async remove(id: string): Promise<void> {
    try {
      await this.api.remove(id)
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e // already gone is fine
    }
    this.set({ items: this.state.items.filter((i) => i.id !== id) })
    this.post({ t: 'changed' })
    void this.refreshUsage()
  }

  // ---------- internals ----------

  private async open(key: CryptoKey, keyGen: string): Promise<void> {
    this.key = key
    this.keyGen = keyGen
    this.lastActive = Date.now()
    this.set({ status: 'open', lockedBecause: null, lockWarning: false })
    this.startTick()
    this.post({ t: 'unlocked', key, keyGen })
    await this.refresh()
  }

  private wiped(): void {
    this.key = null
    this.keyGen = null
    this.stopTick()
    this.set({ status: 'setup', lockedBecause: null, items: [], usedBytes: 0, itemCount: 0, heldBytes: 0, lockWarning: false })
  }

  private signedIn(id: number | undefined): void {
    if (id === undefined) return
    if (this.uid !== null && id !== this.uid) {
      // someone else in this tab: nothing of the previous user's may stay
      this.key = null
      this.keyGen = null
      this.stopTick()
      this.set({ status: 'loading', lockedBecause: null, items: [], usedBytes: 0, itemCount: 0, heldBytes: 0, lockWarning: false })
    }
    this.uid = id
  }

  private async guard<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call()
    } catch (e) {
      if (e instanceof ApiError && e.detail === 'not_initialized') {
        this.wiped() // erased on another device: this tab's key belongs to nothing now
        throw new KeyChanged()
      }
      if (e instanceof ApiError && e.detail === 'key_changed') {
        this.lock('manual') // written with a key this vault no longer has (erased and set up elsewhere)
        this.keyGen = null
        void this.load()
        throw new KeyChanged()
      }
      throw e
    }
  }

  private async decrypt(row: VaultItemOut, key: CryptoKey): Promise<DecryptedItem> {
    try {
      return { ...row, meta: await decryptMeta(row.meta_ct, key) }
    } catch {
      return { ...row, meta: null, broken: true }
    }
  }

  private replace(item: DecryptedItem): void {
    this.set({ items: this.state.items.map((i) => (i.id === item.id ? item : i)) })
  }

  private async refreshUsage(): Promise<void> {
    try {
      this.applyStatus(await this.api.status())
    } catch {
      // the numbers update next time
    }
  }

  private applyStatus(st: VaultStatus): void {
    if (!st.initialized && (this.key || this.state.status === 'open' || this.state.status === 'locked')) {
      this.wiped() // erased elsewhere (another device has no BroadcastChannel with us)
      this.set({ quotaBytes: st.quota_bytes })
      return
    }
    if (st.key_gen && this.keyGen && st.key_gen !== this.keyGen) {
      this.lock('manual', false) // erased and set up again elsewhere: this key is useless now
    }
    if (!this.keyGen && st.key_gen && !this.key) this.keyGen = st.key_gen
    this.set({ usedBytes: st.used_bytes, quotaBytes: st.quota_bytes, itemCount: st.item_count, heldBytes: st.held_bytes })
  }

  /** The idle deadline, checked on a tick, on visibility, on reads (timers sleep with the laptop). */
  private check(emit: boolean): void {
    if (!this.key) return
    const left = this.lastActive + IDLE - Date.now()
    if (left <= 0) {
      this.key = null
      this.stopTick()
      this.state = { ...this.state, status: 'locked', lockedBecause: 'idle', items: [], lockWarning: false }
      this.post({ t: 'locked' })
      if (emit) this.emit()
      return
    }
    const warn = left <= WARN
    if (warn !== this.state.lockWarning) {
      this.state = { ...this.state, lockWarning: warn }
      if (emit) this.emit()
    }
  }

  private startTick(): void {
    this.stopTick()
    this.tick = setInterval(() => this.check(true), TICK)
  }

  private stopTick(): void {
    if (this.tick) clearInterval(this.tick)
    this.tick = null
  }

  private async onMessage(msg: Msg): Promise<void> {
    if (!msg || msg.uid !== this.uid || this.uid === null) return
    if (msg.t === 'unlocked') {
      if (this.key) return
      this.keyGen = msg.keyGen
      await this.open(msg.key, msg.keyGen).catch(() => this.lock(null, false))
    } else if (msg.t === 'locked') {
      this.lock('other-tab', false)
    } else if (msg.t === 'changed') {
      if (this.key) await this.refresh().catch(() => {})
    } else if (msg.t === 'erased') {
      this.wiped()
    } else if (msg.t === 'active') {
      this.lastActive = Math.max(this.lastActive, msg.at)
      this.check(true)
    }
  }

  private post(msg: Omit<Msg, 'uid'> & Record<string, unknown>): void {
    if (this.uid === null) return
    try {
      this.channel?.postMessage({ ...msg, uid: this.uid })
    } catch {
      // a browser that can't clone the key: other tabs simply stay locked
    }
  }

  private set(patch: Partial<VaultSnapshot>): void {
    this.state = { ...this.state, ...patch }
    this.emit()
  }

  private emit(): void {
    this.listeners.forEach((l) => l())
  }
}
