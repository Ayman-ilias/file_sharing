// Shapes returned by the backend (backend/app/schemas.py and the routers).

export type UserRef = { id: number; username: string }

export type User = UserRef & { email: string }

export type Me = User & { is_global: boolean; uses_shared_password: boolean }

export type ItemKind = 'text' | 'file' | 'folder'

export type Item = {
  id: string
  kind: ItemKind
  name: string
  size: number
  mime: string
  sender: UserRef
  recipients: UserRef[]
  is_global: boolean
  text_body: string | null
  text_truncated: boolean
  line_count: number | null
  file_count: number | null
  created_at: string
  expires_at: string
}

export type ItemPage = { items: Item[]; next: string | null }

export type EntryOut = { id: string; relative_path: string; size: number }

export type UploadStarted = { upload_id: string; chunk_size: number; received: number[] }

export type UploadStatus = {
  received: number[]
  size: number
  chunk_size: number
  completed: boolean
  item_id: string | null
}

export type BatchFilesOut = {
  uploads: { relative_path: string; upload_id: string; chunk_size: number; received: number[] }[]
}
