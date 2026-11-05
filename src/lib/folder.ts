// Imperative shell: the tylan folder on the share, reached through tools\tylan.ps1 on 127.0.0.1.
// Edge cannot write to SMB shares through the File System Access API, so that local helper does the I/O.
export type Entry = { name: string; lastModified: string }
export type Folder = {
  info(): Promise<{ root: string }>
  /** dir: working | working/csv | published | archive */
  list(dir: string): Promise<Entry[]>
  read(path: string): Promise<{ text: string; lastModified: string } | null>
  /** expect: the lastModified seen before, 'new' (must not exist) or 'any' (overwrite). Returns the new lastModified. */
  write(path: string, text: string, expect: string): Promise<string>
  copy(from: string, to: string): Promise<void>
  ping(): Promise<void>
}
export class ConflictError extends Error {}

const unreachable =
  'tylanの起動プログラムに接続できません。黒い窓（tylan.cmd）を閉じていないか確認し、閉じていれば tools\\tylan.cmd から起動し直してください。'

/** The launcher opens the editor at http://127.0.0.1:<port>/?t=<token>; anything else has no folder. */
export function launcherFolder(): Folder | null {
  const token = new URLSearchParams(window.location.search).get('t')
  if (window.location.protocol !== 'http:' || !token) {
    return null
  }
  async function call(
    method: string,
    route: string,
    params: Record<string, string>,
    body?: string,
  ) {
    let res: Response
    try {
      res = await fetch(`/api/${route}?${new URLSearchParams(params)}`, {
        method,
        headers: { 'X-Tylan-Token': token! },
        body,
        cache: 'no-store',
      })
    } catch {
      throw new Error(unreachable)
    }
    if (res.status === 409) {
      throw new ConflictError(await res.text())
    }
    if (!res.ok && res.status !== 404) {
      throw new Error(`共有フォルダの操作に失敗しました（${res.status}：${await res.text()}）`)
    }
    return res
  }
  return {
    async info() {
      return (await call('GET', 'info', {})).json()
    },
    async list(dir) {
      return (await call('GET', 'list', { dir })).json()
    },
    async read(path) {
      const res = await call('GET', 'file', { path })
      return res.status === 404
        ? null
        : { text: await res.text(), lastModified: res.headers.get('X-Last-Modified') ?? '' }
    },
    async write(path, text, expect) {
      const res = await call('PUT', 'file', { path, expect }, text)
      return ((await res.json()) as { lastModified: string }).lastModified
    },
    async copy(from, to) {
      await call('POST', 'copy', { from, to })
    },
    async ping() {
      await call('POST', 'ping', {})
    },
  }
}
