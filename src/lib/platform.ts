// Imperative shell: entropy, time, file pickers, browser download, File API.
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
  showOpenFilePicker(options: {
    id?: string
    types?: PickerType[]
  }): Promise<FileSystemFileHandle[]>
  showSaveFilePicker(options: {
    id?: string
    suggestedName?: string
    types?: PickerType[]
  }): Promise<FileSystemFileHandle>
}
const pickers = () => window as unknown as Pickers
export const canWriteFiles = () =>
  typeof window !== 'undefined' && 'showSaveFilePicker' in window && 'showOpenFilePicker' in window
export const isCancel = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'
const jsonTypes = [{ description: 'tylan JSON', accept: { 'application/json': ['.json'] } }]
export async function pickJsonToOpen() {
  const [handle] = await pickers().showOpenFilePicker({ id: 'tylan-json', types: jsonTypes })
  return handle!
}
export function pickJsonToCreate(suggestedName: string) {
  return pickers().showSaveFilePicker({ id: 'tylan-json', suggestedName, types: jsonTypes })
}
export async function writeHandle(handle: FileSystemFileHandle, content: string | Blob) {
  const writable = await handle.createWritable()
  await writable.write(content)
  await writable.close()
}
/** Ask where to save; falls back to a browser download. Returns null when the user cancels. */
export async function saveAs(content: string | Blob, filename: string, type: string) {
  if (!canWriteFiles()) {
    download(content, filename, type)
    return 'downloaded' as const
  }
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
    return 'saved' as const
  } catch (e) {
    if (isCancel(e)) {
      return null
    }
    throw e
  }
}
export function download(
  content: string | Blob,
  filename: string,
  type = 'application/json;charset=utf-8',
) {
  const url = URL.createObjectURL(content instanceof Blob ? content : new Blob([content], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
