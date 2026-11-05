import { type Collection, type Doc, type EntityMap, newEntity } from './schema'
import { findReferences, type Reference, type ValidationResult, validate } from './validate'

export type ChangeResult = ({ ok: true; doc: Doc } | { ok: false }) & ValidationResult
export function applyChange(doc: Doc, mutate: (draft: Doc) => void): ChangeResult {
  const next = structuredClone(doc)
  mutate(next)
  const result = validate(next)
  return result.errors.length ? { ok: false, ...result } : { ok: true, doc: next, ...result }
}
export function upsert<K extends Collection>(
  doc: Doc,
  collection: K,
  entity: EntityMap[K],
): ChangeResult {
  return applyChange(doc, (draft) => {
    const records = draft[collection] as EntityMap[K][]
    const index = records.findIndex((e) => e.id === entity.id)
    if (index < 0) {
      records.push(structuredClone(entity))
    } else {
      records[index] = structuredClone(entity)
    }
    if (collection === 'actionItems') {
      const action = entity as EntityMap['actionItems']
      for (const audit of draft.auditResults) {
        audit.actionItemIds = audit.actionItemIds.filter((id) => id !== action.id)
        if (action.auditResultIds.includes(audit.id)) {
          audit.actionItemIds.push(action.id)
        }
      }
    }
    if (collection === 'auditResults') {
      const audit = entity as EntityMap['auditResults']
      for (const action of draft.actionItems) {
        action.auditResultIds = action.auditResultIds.filter((id) => id !== audit.id)
        if (audit.actionItemIds.includes(action.id)) {
          action.auditResultIds.push(audit.id)
        }
      }
    }
  })
}
// Saved coordinates and "hidden from diagram" flags are display state, not relationships:
// they are removed together with the entity instead of blocking deletion.
const isPlacement = (r: Reference) => /^layouts\.\d+\.(positions|hidden)$/.test(r.path)
const placementKey = (entityId: string) => (key: string) =>
  key === entityId || key.startsWith(`unknown:${entityId}:`)
export function placementCount(doc: Doc, entityId: string) {
  return findReferences(doc, entityId).filter(isPlacement).length
}
export function removalReferences(doc: Doc, collection: Collection, entityId: string) {
  const owned =
    collection === 'devices'
      ? doc.ports.filter((p) => p.deviceId === entityId).map((p) => p.id)
      : []
  return [entityId, ...owned]
    .flatMap((id) => findReferences(doc, id))
    .filter((r) => !(r.id === entityId && r.entityId && owned.includes(r.entityId)))
    .filter((r) => !isPlacement(r))
}
export function removeEntity(doc: Doc, collection: Collection, entityId: string): ChangeResult {
  if (!doc[collection].some((entity) => entity.id === entityId)) {
    return {
      ok: false,
      errors: [
        { code: 'not-found', message: '削除対象が存在しません', path: collection, entityId },
      ],
      warnings: [],
    }
  }
  const refs = removalReferences(doc, collection, entityId)
  if (refs.length) {
    return {
      ok: false,
      errors: refs.map((r) => ({
        code: 'referenced',
        message: '参照があるため削除できません。参照元を確認してください',
        path: r.path,
        entityId: r.entityId,
      })),
      warnings: [],
    }
  }
  return applyChange(doc, (draft) => {
    const records = draft[collection] as { id: string }[]
    records.splice(
      records.findIndex((e) => e.id === entityId),
      1,
    )
    if (collection === 'devices') {
      draft.ports = draft.ports.filter((p) => p.deviceId !== entityId)
    }
    const placed = placementKey(entityId)
    for (const layout of draft.layouts) {
      layout.positions = Object.fromEntries(
        Object.entries(layout.positions).filter(([key]) => !placed(key)),
      )
      layout.hidden = layout.hidden.filter((key) => !placed(key))
    }
  })
}
export function startRound(
  doc: Doc,
  round: EntityMap['auditRounds'],
  resultIds: string[],
): ChangeResult {
  return applyChange(doc, (d) => {
    d.auditRounds.push(structuredClone(round))
    let index = 0
    for (const siteId of round.siteIds) {
      for (const item of d.auditTemplate.items) {
        d.auditResults.push({
          ...newEntity('auditResults', resultIds[index++] ?? ''),
          roundId: round.id,
          siteId,
          itemNo: item.no,
        })
      }
    }
  })
}
