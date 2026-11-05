// Imperative shell: the tylan folder on the share and the JSON being edited in working\.
// Every accepted change is written back to that JSON (autosave).
import { exportFilename, parseDocument } from './io'
import { isCancel, isNotFound, listFiles, nowJst, pickFolder, writeHandle } from './platform'
import { readPublicData } from './publish'
import { MAX_BYTES } from './schema'
import type { Workspace } from './store.svelte'

export type FileStatus = 'saved' | 'saving' | 'error' | 'conflict'
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function createFileSession(workspace: Workspace, delay = 800) {
  let root = $state.raw<FileSystemDirectoryHandle | null>(null)
  let working: FileSystemDirectoryHandle | null = null
  let jsonFiles = $state<string[]>([])
  let handle = $state.raw<FileSystemFileHandle | null>(null)
  let status = $state<FileStatus>('saved')
  let message = $state('')
  let savedAt = $state('')
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
      const out = workspace.exportJson(now, workspace.doc.project.updatedBy)
      await writeHandle(handle, out.text)
      lastModified = (await handle.getFile()).lastModified
      savedAt = now.slice(11, 19)
      status = 'saved'
      message = ''
    } catch (e) {
      workspace.markDirty()
      status = 'error'
      message = `保存できませんでした（${errorText(e)}）。共有フォルダへの接続とアクセス権を確認してから「今すぐ保存」を押してください。`
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

  /** Runs a user action; a cancelled picker is not an error. */
  async function run(action: () => Promise<boolean>) {
    message = ''
    try {
      return await action()
    } catch (e) {
      if (!isCancel(e)) {
        message = errorText(e)
      }
      return false
    }
  }
  async function refresh() {
    jsonFiles = working
      ? (await listFiles(working))
          .filter((n) => n.toLowerCase().endsWith('.json'))
          .sort()
          .reverse()
      : []
  }
  async function readJson(name: string) {
    const file = await (await working!.getFileHandle(name)).getFile()
    if (file.size > MAX_BYTES) {
      throw new Error(`${name} は10MiBを超えています`)
    }
    return { text: await file.text(), size: file.size }
  }
  async function adopt(next: FileSystemFileHandle) {
    handle = next
    lastModified = (await next.getFile()).lastModified
    status = 'saved'
    savedAt = ''
  }
  async function exists(dir: FileSystemDirectoryHandle, name: string) {
    try {
      await dir.getFileHandle(name)
      return true
    } catch (e) {
      if (isNotFound(e)) {
        return false
      }
      throw e
    }
  }

  return {
    get folderName() {
      return root?.name ?? ''
    },
    get hasFolder() {
      return root !== null
    },
    get jsonFiles() {
      return jsonFiles
    },
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
    chooseFolder: () =>
      run(async () => {
        const dir = await pickFolder()
        // Guards against picking Downloads, Documents, or tools itself by mistake.
        try {
          await dir.getDirectoryHandle('tools')
        } catch (e) {
          if (isNotFound(e)) {
            throw new Error(
              `「${dir.name}」は tylan フォルダではありません。tools フォルダ（editor.html の置き場所）が入っているフォルダを選んでください。`,
            )
          }
          throw e
        }
        working = await dir.getDirectoryHandle('working', { create: true })
        root = dir
        await refresh()
        return true
      }),
    open: (name: string) =>
      run(async () => {
        const next = await working!.getFileHandle(name)
        const { text, size } = await readJson(name)
        if (!workspace.load(text, size)) {
          return false
        }
        await adopt(next)
        return true
      }),
    /** Creates working\<name>; `from` copies an existing JSON (devices, links, past audits). */
    create: (name: string, from: string | null) =>
      run(async () => {
        const fileName = name.trim().toLowerCase().endsWith('.json')
          ? name.trim()
          : `${name.trim()}.json`
        if (!/^[^\\/:*?"<>|]+\.json$/.test(fileName) || fileName === '.json') {
          throw new Error('ファイル名に使えない文字が含まれています')
        }
        if (await exists(working!, fileName)) {
          throw new Error(
            `${fileName} はすでにあります。別の名前にするか、一覧から開いてください。`,
          )
        }
        const source = from ? await readJson(from) : null
        if (source) {
          parseDocument(source.text, source.size) // reject a broken source before creating anything
        }
        const next = await working!.getFileHandle(fileName, { create: true })
        if (source) {
          workspace.load(source.text, source.size)
        } else {
          workspace.reset()
        }
        await adopt(next)
        await flush()
        await refresh()
        return true
      }),
    reloadFromFile: () =>
      run(async () => {
        if (!handle) {
          return false
        }
        const { text, size } = await readJson(handle.name)
        if (!workspace.load(text, size)) {
          return false
        }
        await adopt(handle)
        message = ''
        return true
      }),
    overwrite: () => flush(true),
    /** Writes published\viewer.html (fixed name for viewers) and moves the previous one to archive\. */
    publishViewer: (html: string) =>
      run(async () => {
        const published = await root!.getDirectoryHandle('published', { create: true })
        if (await exists(published, 'viewer.html')) {
          const old = await (await published.getFileHandle('viewer.html')).getFile()
          const text = await old.text()
          let revision = 0
          try {
            revision = readPublicData(text).project.revision
          } catch {
            /* not a tylan viewer: still archived, as r0000 */
          }
          const archive = await root!.getDirectoryHandle('archive', { create: true })
          const name = exportFilename('viewer', revision, nowJst(), 'html')
          await writeHandle(await archive.getFileHandle(name, { create: true }), text)
        }
        await writeHandle(await published.getFileHandle('viewer.html', { create: true }), html)
        return true
      }),
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
      await refresh()
      return true
    },
  }
}
export type FileSession = ReturnType<typeof createFileSession>
