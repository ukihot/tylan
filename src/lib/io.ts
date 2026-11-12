import { APP_VERSION, type Doc, MAX_BYTES } from './schema'
import { validate } from './validate'
export function parseDocument(
  text: string,
  byteLength = new TextEncoder().encode(text).byteLength,
): Doc {
  if (Math.max(byteLength, new TextEncoder().encode(text).byteLength) > MAX_BYTES) {
    throw new Error('10MiBを超えています。小さい正本JSONを選択してください')
  }
  let input: unknown
  try {
    input = JSON.parse(text)
  } catch {
    throw new Error('JSONを読み取れません。原本または直前版を確認してください')
  }
  if (!input || typeof input !== 'object' || !('format' in input) || input.format !== 'tylan') {
    throw new Error('tylanの正本JSONを選択してください')
  }
  if (!('schemaVersion' in input) || input.schemaVersion !== 3) {
    throw new Error(
      '未対応の形式です（v3のみ）。旧形式のJSONは読み込めないため、新しく作成してください',
    )
  }
  const result = validate(input)
  if (result.errors.length) {
    throw new Error(result.errors.map((i) => `${i.path}：${i.message}`).join('\n'))
  }
  const doc = input as Doc
  return { ...doc, project: { ...doc.project, baseRevision: doc.project.revision } }
}
export function exportFilename(kind: string, revision: number, now: string, ext: string) {
  const stamp = now.slice(0, 19).replace(/[-:T]/g, '')
  return `${kind}-r${String(revision).padStart(4, '0')}-${stamp.slice(0, 8)}-${stamp.slice(8)}.${ext}`
}
export function prepareExport(doc: Doc, now: string, updatedBy: string | null) {
  const next = structuredClone(doc)
  Object.assign(next.project, {
    revision: doc.project.revision + 1,
    updatedAt: now,
    updatedBy,
    appVersion: APP_VERSION,
  })
  const result = validate(next)
  if (result.errors.length) {
    throw new Error('検証エラーを修正してから書き出してください')
  }
  const text = JSON.stringify(next, null, 2)
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) {
    throw new Error('書き出しが10MiBを超えます。データを整理してください')
  }
  return {
    doc: next,
    text,
    filename: exportFilename('network', next.project.revision, now, 'json'),
  }
}
