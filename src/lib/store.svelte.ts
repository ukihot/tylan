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
  let saveState = $state<'clean' | 'dirty'>('clean')
  let issues = $state<Issue[]>([])
  let undoStack = $state.raw<{ doc: Doc; importId?: string }[]>([])
  let exportedRevision = initial.project.revision
  let locked = false
  let changed: () => void = () => {}
  const validation = $derived(validate(doc))
  function accept(result: ChangeResult, importId?: string) {
    if (locked && !importId) {
      return false
    }
    issues = result.errors
    if (!result.ok) {
      return false
    }
    if (JSON.stringify(result.doc) === JSON.stringify(doc)) {
      return true
    }
    undoStack = [...undoStack.slice(-9), { doc, importId }]
    doc = freeze(result.doc)
    saveState = 'dirty'
    changed()
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
    acceptImport(next: Doc, importId: string) {
      const result = validate(next)
      if (result.errors.length) {
        issues = result.errors
        return false
      }
      return accept({ ok: true, doc: structuredClone(next), ...result }, importId)
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
      if (locked) {
        return
      }
      const previous = undoStack.at(-1)
      if (!previous) {
        return
      }
      // Revision metadata is monotonic even when content is undone after export.
      const restored = structuredClone(previous.doc)
      restored.documentId = doc.documentId
      restored.importBatches = structuredClone(doc.importBatches).map((batch) =>
        batch.id === previous.importId ? { ...batch, state: 'reverted' as const } : batch,
      )
      const next = {
        ...restored,
        project: {
          ...previous.doc.project,
          revision: exportedRevision,
          baseRevision: doc.project.baseRevision,
        },
      }
      const result = validate(next)
      if (result.errors.length) {
        issues = result.errors
        return
      }
      doc = freeze(next)
      undoStack = undoStack.slice(0, -1)
      saveState = 'dirty'
      issues = []
      changed()
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
    /** Bumps the revision and marks clean; the caller writes `text` to the open file. */
    exportJson(now: string, updatedBy: string | null) {
      const out = prepareExport(doc, now, updatedBy)
      doc = freeze(out.doc)
      exportedRevision = out.doc.project.revision
      saveState = 'clean'
      return out
    },
    prepareSave(now: string, updatedBy: string | null) {
      return { ...prepareExport(doc, now, updatedBy), sourceDoc: doc }
    },
    acknowledgeSave(candidate: ReturnType<typeof prepareExport> & { sourceDoc: Doc }) {
      const unchanged = doc === candidate.sourceDoc
      exportedRevision = Math.max(exportedRevision, candidate.doc.project.revision)
      doc = freeze(
        unchanged
          ? candidate.doc
          : { ...doc, project: { ...doc.project, revision: exportedRevision } },
      )
      saveState = unchanged ? 'clean' : 'dirty'
    },
    acknowledgeImport(next: Doc) {
      exportedRevision = next.project.revision
      doc = freeze(structuredClone(next))
      saveState = 'clean'
    },
    markDirty() {
      saveState = 'dirty'
    },
    setLocked(value: boolean) {
      locked = value
    },
    onChange(listener: () => void) {
      changed = listener
    },
    clearIssues() {
      issues = []
    },
  }
}
export type Workspace = ReturnType<typeof createWorkspace>
