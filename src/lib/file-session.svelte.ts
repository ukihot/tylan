// Imperative shell: the open JSON file. Every accepted change is written back to it (autosave).
import { parseDocument } from './io'
import { isCancel, nowJst, pickJsonToCreate, pickJsonToOpen, writeHandle } from './platform'
import { MAX_BYTES } from './schema'
import type { Workspace } from './store.svelte'

export type FileStatus = 'saved' | 'saving' | 'error' | 'conflict'
export function createFileSession(workspace: Workspace, delay = 800) {
  let handle = $state.raw<FileSystemFileHandle | null>(null)
  let status = $state<FileStatus>('saved')
  let message = $state('')
  let savedAt = $state('')
  let copySource = $state.raw<{ name: string; text: string; size: number } | null>(null)
  let lastModified = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let busy = false
  let again = false

  async function flush(force = false) {
    clearTimeout(timer)
    timer = undefined
    if (!handle || (status === 'conflict' && !force)) {
      return
    }
    if (busy) {
      again = true
      return
    }
    busy = true
    status = 'saving'
    try {
      // Someone else (another PC, a restored backup) changed the file since we read or wrote it.
      if (!force && (await handle.getFile()).lastModified !== lastModified) {
        status = 'conflict'
        message =
          'ファイルが別の場所で変更されています。自動保存を止めました。読み込み直すか、この画面の内容で上書きするかを選んでください。'
        workspace.markDirty()
        return
      }
      const now = nowJst()
      const out = workspace.exportJson(now, workspace.doc.project.updatedBy, true)
      await writeHandle(handle, out.text)
      lastModified = (await handle.getFile()).lastModified
      savedAt = now.slice(11, 19)
      status = 'saved'
      message = ''
    } catch (e) {
      workspace.markDirty()
      status = 'error'
      message = `保存できませんでした（${e instanceof Error ? e.message : String(e)}）。共有フォルダへの接続とアクセス権を確認してから「今すぐ保存」を押してください。`
    } finally {
      busy = false
      if (again) {
        again = false
        void flush()
      }
    }
  }
  workspace.onChange(() => {
    if (handle && status !== 'conflict') {
      clearTimeout(timer)
      timer = setTimeout(() => void flush(), delay)
    }
  })

  async function adopt(next: FileSystemFileHandle) {
    handle = next
    lastModified = (await next.getFile()).lastModified
    status = 'saved'
    message = ''
    savedAt = ''
  }
  /** Runs a picker flow; a cancelled picker is not an error. Returns true when a file is now open. */
  async function run(flow: () => Promise<boolean>) {
    try {
      return await flow()
    } catch (e) {
      if (!isCancel(e)) {
        message = e instanceof Error ? e.message : String(e)
      }
      return false
    }
  }
  async function readText(next: FileSystemFileHandle) {
    const file = await next.getFile()
    if (file.size > MAX_BYTES) {
      throw new Error('10MiBを超えています。小さい正本JSONを選択してください')
    }
    return { text: await file.text(), size: file.size }
  }

  return {
    get fileName() {
      return handle?.name ?? ''
    },
    get isOpen() {
      return handle !== null
    },
    get status() {
      return status
    },
    get message() {
      return message
    },
    get label() {
      if (status === 'conflict') {
        return '別の場所で変更されたため保存を停止中'
      }
      if (status === 'error') {
        return '保存できませんでした'
      }
      if (status === 'saving') {
        return '保存中…'
      }
      if (workspace.saveState === 'dirty') {
        return '未保存の変更（まもなく自動保存）'
      }
      return savedAt ? `保存済み ${savedAt}` : '保存済み'
    },
    flush,
    createBlank: () =>
      run(async () => {
        const next = await pickJsonToCreate(`network-${nowJst().slice(0, 4)}.json`)
        workspace.reset()
        await adopt(next)
        await flush()
        return true
      }),
    get copySource() {
      return copySource?.name ?? ''
    },
    // Two clicks on purpose: each file picker needs its own user gesture.
    pickCopySource: () =>
      run(async () => {
        const source = await pickJsonToOpen()
        const { text, size } = await readText(source)
        parseDocument(text, size) // reject a broken source before asking where to save
        copySource = { name: source.name, text, size }
        message = ''
        return false
      }),
    createFromCopy: () =>
      run(async () => {
        if (!copySource) {
          return false
        }
        const next = await pickJsonToCreate(`network-${nowJst().slice(0, 4)}.json`)
        if (!workspace.load(copySource.text, copySource.size)) {
          return false
        }
        copySource = null
        await adopt(next)
        await flush()
        return true
      }),
    cancelCopy() {
      copySource = null
    },
    open: () =>
      run(async () => {
        const next = await pickJsonToOpen()
        const { text, size } = await readText(next)
        if (!workspace.load(text, size)) {
          return false
        }
        await adopt(next)
        return true
      }),
    reloadFromFile: () =>
      run(async () => {
        if (!handle) {
          return false
        }
        const { text, size } = await readText(handle)
        if (!workspace.load(text, size)) {
          return false
        }
        await adopt(handle)
        return true
      }),
    overwrite: () => flush(true),
    /** Saves pending changes first; keeps the file open if that fails so nothing is lost. */
    async close() {
      if (workspace.saveState === 'dirty') {
        await flush()
      }
      if (workspace.saveState === 'dirty' || status !== 'saved') {
        return false
      }
      handle = null
      savedAt = ''
      return true
    },
  }
}
export type FileSession = ReturnType<typeof createFileSession>
