// Imperative shell: the JSON being edited in tylan\working on the share.
// Every accepted change is written back to that JSON (autosave) through the launcher.
import { ConflictError, type Folder } from './folder'
import { exportFilename, parseDocument } from './io'
import { createId, nowJst } from './platform'
import { readPublicData } from './publish'
import type { Doc } from './schema'
import { MAX_BYTES } from './schema'
import type { Workspace } from './store.svelte'

export type FileStatus = 'saved' | 'saving' | 'error' | 'conflict'
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const conflictText =
  'ファイルが別の場所で変更されています。自動保存を止めました。読み込み直すか、この画面の内容で上書きするかを選んでください。'

export function createFileSession(workspace: Workspace, folder: Folder, delay = 800) {
  let root = $state('')
  let connected = $state(false)
  let jsonFiles = $state<string[]>([])
  let path = $state<string | null>(null)
  let status = $state<FileStatus>('saved')
  let message = $state('')
  let savedAt = $state('')
  let lastModified = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let busy = false
  let auditBusy = $state(false)
  let again = false

  async function flush(force = false) {
    clearTimeout(timer)
    timer = undefined
    if (
      auditBusy ||
      !path ||
      (status === 'conflict' && !force) ||
      (workspace.saveState === 'clean' && !force)
    ) {
      return
    }
    if (busy) {
      again = true
      return
    }
    busy = true
    status = 'saving'
    try {
      const now = nowJst()
      const out = workspace.prepareSave(now, workspace.doc.project.updatedBy)
      // The launcher refuses the write if the file changed since we read or wrote it.
      lastModified = await folder.write(path, out.text, force ? 'any' : lastModified)
      workspace.acknowledgeSave(out)
      savedAt = now.slice(11, 19)
      status = 'saved'
      message = ''
    } catch (e) {
      workspace.markDirty()
      if (e instanceof ConflictError) {
        status = 'conflict'
        message = conflictText
      } else {
        status = 'error'
        message = `保存できませんでした（${errorText(e)}）。変更はこの画面に残っています。「今すぐ保存」で再試行してください。`
      }
    } finally {
      busy = false
      if (again) {
        again = false
        void flush()
      }
    }
  }
  workspace.onChange(() => {
    if (path && status !== 'conflict' && !auditBusy) {
      clearTimeout(timer)
      timer = setTimeout(() => void flush(), delay)
    }
  })

  async function run(action: () => Promise<boolean>) {
    message = ''
    try {
      return await action()
    } catch (e) {
      message = errorText(e)
      return false
    }
  }
  async function refresh() {
    jsonFiles = (await folder.list('working'))
      .map((e) => e.name)
      .filter((n) => n.toLowerCase().endsWith('.json'))
      .sort()
      .reverse()
  }
  async function readJson(name: string) {
    const file = await folder.read(`working/${name}`)
    if (!file) {
      throw new Error(`working\\${name} が見つかりません`)
    }
    const size = new TextEncoder().encode(file.text).byteLength
    if (size > MAX_BYTES) {
      throw new Error(`${name} は10MiBを超えています`)
    }
    return { ...file, size }
  }

  return {
    get auditBusy() {
      return auditBusy
    },
    get filePath() {
      return path
    },
    async beginImport() {
      if (auditBusy) {
        throw new Error('別の取り込みを処理しています')
      }
      await flush()
      for (let attempt = 0; busy && attempt < 600; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      if (!path || status !== 'saved' || workspace.saveState !== 'clean' || busy) {
        throw new Error('保存・競合を解消してから取り込んでください')
      }
      clearTimeout(timer)
      auditBusy = true
      workspace.setLocked(true)
      return { path, expect: lastModified }
    },
    completeImport(next: Doc, importId: string, stamp: string) {
      if (!auditBusy || !workspace.acceptImport(next, importId)) {
        throw new Error('取り込み結果を検証できません')
      }
      workspace.acknowledgeImport(next)
      lastModified = stamp
      status = 'saved'
      savedAt = nowJst().slice(11, 19)
      message = ''
    },
    importUnknown() {
      status = 'conflict'
      message =
        '取り込みの保存結果を確認できません。再取り込みの前に正本を照合・読み直してください。'
    },
    endImport() {
      auditBusy = false
      workspace.setLocked(false)
    },
    get root() {
      return root
    },
    get connected() {
      return connected
    },
    get jsonFiles() {
      return jsonFiles
    },
    get fileName() {
      return path?.slice('working/'.length) ?? ''
    },
    get isOpen() {
      return path !== null
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
    connect: () =>
      run(async () => {
        root = (await folder.info()).root
        await refresh()
        connected = true
        return true
      }),
    /** Keeps the launcher alive; it stops by itself a few minutes after the editor is gone. */
    async ping() {
      try {
        await folder.ping()
      } catch (e) {
        message = errorText(e)
      }
    },
    open: (name: string) =>
      run(async () => {
        const file = await readJson(name)
        if (!workspace.load(file.text, file.size)) {
          return false
        }
        path = `working/${name}`
        lastModified = file.lastModified
        status = 'saved'
        savedAt = ''
        return true
      }),
    /** Creates working\<name>; `from` copies an existing JSON (devices, links, past audits). */
    create: (name: string, from: string | null) =>
      run(async () => {
        const trimmed = name.trim()
        const fileName = trimmed.toLowerCase().endsWith('.json') ? trimmed : `${trimmed}.json`
        if (!/^[^\\/:*?"<>|.][^\\/:*?"<>|]*\.json$/.test(fileName)) {
          throw new Error('ファイル名に使えない文字が含まれています')
        }
        await refresh()
        if (jsonFiles.includes(fileName)) {
          throw new Error(
            `${fileName} はすでにあります。別の名前にするか、一覧から開いてください。`,
          )
        }
        const source = from ? await readJson(from) : null
        if (source) {
          parseDocument(source.text, source.size) // reject a broken source before creating anything
          workspace.load(source.text, source.size)
          if (workspace.doc.schemaVersion === 2) {
            workspace.commit((doc) => {
              doc.documentId = createId('doc')
            })
          }
        } else {
          workspace.reset()
        }
        const out = workspace.exportJson(nowJst(), workspace.doc.project.updatedBy)
        lastModified = await folder.write(`working/${fileName}`, out.text, 'new')
        path = `working/${fileName}`
        status = 'saved'
        savedAt = ''
        await refresh()
        return true
      }),
    reloadFromFile: () =>
      run(async () => {
        if (!path) {
          return false
        }
        const file = await readJson(path.slice('working/'.length))
        if (!workspace.load(file.text, file.size)) {
          return false
        }
        lastModified = file.lastModified
        status = 'saved'
        return true
      }),
    overwrite: () => flush(true),
    /** Writes published\viewer.html (fixed name for viewers) and keeps the previous one in archive\. */
    publishViewer: (html: string) =>
      run(async () => {
        const current = await folder.read('published/viewer.html')
        if (current) {
          let revision = 0
          try {
            revision = readPublicData(current.text).project.revision
          } catch {
            /* not a tylan viewer: still archived, as r0000 */
          }
          await folder.copy(
            'published/viewer.html',
            `archive/${exportFilename('viewer', revision, nowJst(), 'html')}`,
          )
        }
        await folder.write('published/viewer.html', html, 'any')
        return true
      }),
    saveCsv: (name: string, text: string) =>
      run(async () => {
        await folder.write(`working/csv/${name}`, text, 'any')
        return true
      }),
    /** Saves pending changes first; keeps the file open if that fails so nothing is lost. */
    async close() {
      if (auditBusy) {
        return false // an import holds the canonical file until it is confirmed or fails
      }
      if (workspace.saveState === 'dirty') {
        await flush()
      }
      if (workspace.saveState === 'dirty' || status !== 'saved') {
        return false
      }
      path = null
      savedAt = ''
      await run(async () => {
        await refresh()
        return true
      })
      return true
    },
  }
}
export type FileSession = ReturnType<typeof createFileSession>
