import type { Item } from '../api/types'

export const mkItem = (id: string, over: Partial<Item> = {}): Item => ({
  id, kind: 'file', name: `${id}.bin`, size: 10, mime: 'application/octet-stream',
  sender: { id: 2, username: 'rahim' }, recipients: [{ id: 1, username: 'ayman' }], is_global: false,
  text_body: null, text_truncated: false, line_count: null, file_count: null,
  created_at: '2026-11-02T10:00:00Z', expires_at: '2026-12-02T10:00:00Z', ...over,
})
