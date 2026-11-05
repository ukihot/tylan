// Imperative shell: entropy, time, folder/file access.
export function createId(prefix: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
  // Rejection sampling avoids modulo bias.
  let suffix = ''
  for (const byte of bytes) {
    if (byte < 248) {
      suffix += alphabet[byte % 62]
    }
  }
  while (suffix.length < 16) {
    const byte = crypto.getRandomValues(new Uint8Array(1))[0]!
    if (byte < 248) {
      suffix += alphabet[byte % 62]
    }
  }
  return `${prefix}_${suffix}`
}
export function nowJst() {
  return `${new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 19)}+09:00`
}
// File System Access API (Edge/Chrome, also on file://). Typed locally: not in every TS DOM lib.
type PickerType = { description: string; accept: Record<string, string[]> }
type Pickers = {
  showDirectoryPicker(options: {
    id?: string
    mode?: 'readwrite'
  }): Promise<FileSystemDirectoryHandle>
  showSaveFilePicker(options: {
    id?: string
    suggestedName?: string
    types?: PickerType[]
  }): Promise<FileSystemFileHandle>
}
const pickers = () => window as unknown as Pickers
export const canWriteFiles = () =>
  typeof window !== 'undefined' && 'showDirectoryPicker' in window && 'showSaveFilePicker' in window
export const isCancel = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'
export const isNotFound = (e: unknown) => e instanceof DOMException && e.name === 'NotFoundError'
export function pickFolder() {
  return pickers().showDirectoryPicker({ id: 'tylan-root', mode: 'readwrite' })
}
export async function listFiles(dir: FileSystemDirectoryHandle) {
  const names: string[] = []
  const entries = dir as unknown as { values(): AsyncIterable<FileSystemHandle> }
  for await (const entry of entries.values()) {
    if (entry.kind === 'file') {
      names.push(entry.name)
    }
  }
  return names
}
export async function writeHandle(handle: FileSystemFileHandle, content: string | Blob) {
  const writable = await handle.createWritable()
  await writable.write(content)
  await writable.close()
}
/** Ask where to save. Returns false when the user cancels. */
export async function saveAs(content: string | Blob, filename: string, type: string) {
  const ext = filename.slice(filename.lastIndexOf('.'))
  try {
    const handle = await pickers().showSaveFilePicker({
      id: `tylan-${ext.slice(1)}`,
      suggestedName: filename,
      types: [
        { description: ext.slice(1).toUpperCase(), accept: { [type.split(';')[0]!]: [ext] } },
      ],
    })
    await writeHandle(handle, content)
    return true
  } catch (e) {
    if (isCancel(e)) {
      return false
    }
    throw e
  }
}
