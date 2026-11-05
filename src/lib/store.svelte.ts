import { applyChange, type ChangeResult, removeEntity, startRound, upsert } from './commands'
import { parseDocument, prepareExport } from './io'
import { createId, nowJst } from './platform'
import { type Collection, type Doc, type EntityMap, emptyDoc } from './schema'
import { type Issue, validate } from './validate'

function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    Object.values(value).forEach(freeze)
  }
  return value
}
export function createWorkspace(initial = emptyDoc(nowJst(), createId('prj'))) {
  if (validate(initial).errors.length) {
    throw new Error('初期データが不正です')
  }
  let doc = $state.raw<Doc>(freeze(structuredClone(initial)))
  let saveState = $state<'clean' | 'dirty' | 'exportRequested'>('clean')
  let issues = $state<Issue[]>([])
  let undoStack = $state.raw<Doc[]>([])
  let exportedRevision = initial.project.revision
  const validation = $derived(validate(doc))
  function accept(result: ChangeResult) {
    issues = result.errors
    if (!result.ok) {
      return false
    }
    if (JSON.stringify(result.doc) === JSON.stringify(doc)) {
      return true
    }
    undoStack = [...undoStack.slice(-9), doc]
    doc = freeze(result.doc)
    saveState = 'dirty'
    return true
  }
  return {
    get doc() {
      return doc
    },
    get saveState() {
      return saveState
    },
    get issues() {
      return issues
    },
    get validation() {
      return validation
    },
    get undoCount() {
      return undoStack.length
    },
    commit(mutate: (draft: Doc) => void) {
      return accept(applyChange(doc, mutate))
    },
    upsert<K extends Collection>(collection: K, entity: EntityMap[K]) {
      return accept(upsert(doc, collection, entity))
    },
    remove(collection: Collection, id: string) {
      return accept(removeEntity(doc, collection, id))
    },
    startRound(round: EntityMap['auditRounds']) {
      return accept(
        startRound(
          doc,
          round,
          Array.from({ length: round.siteIds.length * 20 }, () => createId('aud')),
        ),
      )
    },
    undo() {
      const previous = undoStack.at(-1)
      if (!previous) {
        return
      }
      // Revision metadata is monotonic even when content is undone after export.
      doc = freeze({
        ...structuredClone(previous),
        project: {
          ...previous.project,
          revision: exportedRevision,
          baseRevision: doc.project.baseRevision,
        },
      })
      undoStack = undoStack.slice(0, -1)
      saveState = 'dirty'
      issues = []
    },
    load(text: string, size?: number) {
      try {
        const next = parseDocument(text, size)
        doc = freeze(next)
        exportedRevision = next.project.revision
        undoStack = []
        saveState = 'clean'
        issues = []
        return true
      } catch (err) {
        issues = [
          {
            code: 'load',
            message: String(err instanceof Error ? err.message : err),
            path: '',
            entityId: null,
          },
        ]
        return false
      }
    },
    reset() {
      doc = freeze(emptyDoc(nowJst(), createId('prj')))
      exportedRevision = 0
      undoStack = []
      issues = []
      saveState = 'clean'
    },
    exportJson(now: string, updatedBy: string | null) {
      const out = prepareExport(doc, now, updatedBy)
      doc = freeze(out.doc)
      exportedRevision = out.doc.project.revision
      saveState = 'exportRequested'
      return out
    },
    clearIssues() {
      issues = []
    },
  }
}
export type Workspace = ReturnType<typeof createWorkspace>
