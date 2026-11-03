// Drag and drop: plain files for the Files tab, a whole folder (with its paths) for the Folder tab.

type FsEntry = {
  isFile: boolean
  isDirectory: boolean
  name: string
  file?: (ok: (f: File) => void, fail?: (e: unknown) => void) => void
  createReader?: () => { readEntries: (ok: (e: FsEntry[]) => void, fail?: (e: unknown) => void) => void }
}

const entries = (dt: DataTransfer): (FsEntry | null)[] =>
  Array.from(dt.items ?? [], (item) => (item.kind === 'file' ? (item.webkitGetAsEntry?.() as FsEntry | null) : null))

/** Dropped files, without folders (a folder shows up as a fake empty "file"). */
export function droppedFiles(dt: DataTransfer): File[] {
  const list = entries(dt)
  return Array.from(dt.files).filter((_, i) => !list[i]?.isDirectory)
}

async function readAll(dir: FsEntry): Promise<FsEntry[]> {
  const reader = dir.createReader!()
  const out: FsEntry[] = []
  // readEntries hands out pages (100 in Chrome) until it returns an empty one
  for (;;) {
    const page = await new Promise<FsEntry[]>((ok, fail) => reader.readEntries(ok, fail))
    if (!page.length) return out
    out.push(...page)
  }
}

async function walk(entry: FsEntry, path: string, out: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((ok, fail) => entry.file!(ok, fail))
    Object.defineProperty(file, 'webkitRelativePath', { value: path })
    out.push(file)
  } else if (entry.isDirectory) {
    for (const child of await readAll(entry)) await walk(child, `${path}/${child.name}`, out)
  }
}

/** The first dropped folder's files, each with webkitRelativePath "top/…", or null. */
export async function droppedFolder(dt: DataTransfer): Promise<File[] | null> {
  const dir = entries(dt).find((e) => e?.isDirectory)
  if (!dir) return null
  const out: File[] = []
  await walk(dir, dir.name, out)
  return out
}
