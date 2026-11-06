import { inCidr } from './address'
import {
  type CollectionResult,
  CollectionSchema,
  type Observation,
  sha256,
} from './collection-schema'
import { type Doc, type ImportBatch, newEntity } from './schema'
import { validate } from './validate'

export type ImportOptions = {
  documentId: string
  siteId: string
  segmentId: string
  roundId: string | null
  selected: string[]
  mappings: Record<string, string>
  checkedBy: string
  now: string
  packageHash: string
  storageLocation: string
}
export function migrateV2(doc: Doc, documentId: string): Doc {
  if (doc.schemaVersion === 2) {
    return structuredClone(doc)
  }
  const next: Doc = { ...structuredClone(doc), schemaVersion: 2, documentId, importBatches: [] }
  const result = validate(next)
  if (result.errors.length) {
    throw new Error(result.errors.map((i) => i.message).join('\n'))
  }
  return next
}
export function candidates(doc: Doc, obs: Observation, siteId: string) {
  const ip = obs.value.ip
  const mac = obs.value.mac
  return doc.devices.filter(
    (device) =>
      device.siteId === siteId &&
      doc.ports.some(
        (port) =>
          port.deviceId === device.id &&
          ((typeof mac === 'string' && port.mac?.toLowerCase() === mac.toLowerCase()) ||
            doc.ipAssignments.some((a) => a.portId === port.id && a.address === ip)),
      ),
  )
}
export async function planImport(original: Doc, input: unknown, options: ImportOptions) {
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 10 * 1024 * 1024) {
    throw new Error('収集結果は10MiB以下にしてください')
  }
  const result: CollectionResult = CollectionSchema.parse(input)
  if (
    !/^[a-f0-9]{64}$/.test(options.packageHash) ||
    !options.storageLocation ||
    !options.checkedBy.trim()
  ) {
    throw new Error('検証済み証跡と確認者が必要です')
  }
  const doc = migrateV2(original, options.documentId)
  if (doc.documentId !== options.documentId) {
    throw new Error('正本IDが変わりました')
  }
  const segment = doc.segments.find(
    (s) => s.id === options.segmentId && s.siteId === options.siteId,
  )
  if (!doc.sites.some((s) => s.id === options.siteId)) {
    throw new Error('対象拠点を選んでください')
  }
  const selected = [...new Set(options.selected)].sort()
  const selectionHash = await sha256(
    JSON.stringify([selected, Object.entries(options.mappings).sort()]),
  )
  const seed = `${doc.documentId}:${result.runId}`
  const identity = async (prefix: string, key: string) =>
    `${prefix}_${(await sha256(`${seed}:${key}`)).slice(0, 16)}`
  const importId = await identity('imp', selectionHash)
  const existing = doc.importBatches?.find((b) => b.id === importId)
  if (existing?.packageHash !== undefined && existing.packageHash !== options.packageHash) {
    throw new Error('同じ取り込みIDの内容が違います')
  }
  if (existing?.state === 'applied') {
    return { doc, importId, selectionHash, conflicts: [] as string[] }
  }
  const batch: ImportBatch = {
    id: importId,
    runId: result.runId,
    packageHash: options.packageHash,
    selectionHash,
    state: 'applied',
    bindings: [],
    evidenceIds: [],
    intentReference: null,
    checkedBy: options.checkedBy,
    appliedAt: options.now,
  }
  const evidenceId = await identity('evd', options.packageHash)
  if (!doc.evidence.some((e) => e.id === evidenceId)) {
    doc.evidence.push({
      ...newEntity('evidence', evidenceId),
      description: `自動収集 ${result.runId}`.slice(0, 100),
      referenceNumber: options.packageHash,
      storageLocation: options.storageLocation,
      acquiredDate: result.endedAt.slice(0, 10),
      acquiredBy: options.checkedBy,
    })
  }
  batch.evidenceIds = [evidenceId]
  const conflicts: string[] = []
  const observationDevices = new Map<string, string>()
  for (const key of selected) {
    const obs = result.observations.find((o) => o.id === key)
    if (!obs || !['device', 'arp'].includes(obs.type)) {
      continue
    }
    if (!segment?.cidr || typeof obs.value.ip !== 'string' || !inCidr(obs.value.ip, segment.cidr)) {
      throw new Error('観測IPのセグメントを確認してください')
    }
    const bindingKey = `${result.runId}:${obs.id}:device`
    const prior = doc.importBatches
      ?.filter((b) => b.state === 'applied')
      .flatMap((b) => b.bindings)
      .find((b) => b.key === bindingKey)
    if (prior) {
      if (!doc.devices.some((d) => d.id === prior.entityId)) {
        throw new Error('採用先が削除されています。再照合してください')
      }
      batch.bindings.push(prior)
      observationDevices.set(obs.id, prior.entityId)
      continue
    }
    const possible = candidates(original, obs, options.siteId)
    const mapping = options.mappings[obs.id]
    if (!mapping && possible.length) {
      throw new Error('既存機器の照合を選択してください')
    }
    const observedKey = `${obs.value.ip}:${String(obs.value.mac ?? '')}`
    const deviceId =
      mapping && mapping !== 'new'
        ? mapping
        : (observationDevices.get(observedKey) ?? (await identity('dev', `${obs.id}:device`)))
    if (
      mapping &&
      mapping !== 'new' &&
      !doc.devices.some((d) => d.id === deviceId && d.siteId === options.siteId)
    ) {
      throw new Error('採用先の機器がありません')
    }
    if (!doc.devices.some((d) => d.id === deviceId)) {
      doc.devices.push({
        ...newEntity('devices', deviceId),
        name: String(obs.value.hostname || obs.value.ip).slice(0, 100),
        siteId: options.siteId,
        observation: 'observed',
        lastCheckedDate: options.now.slice(0, 10),
      })
    }
    observationDevices.set(obs.id, deviceId)
    observationDevices.set(observedKey, deviceId)
    const ipKnown = doc.ipAssignments.some(
      (a) =>
        a.address === obs.value.ip &&
        a.segmentId === segment.id &&
        doc.ports.some((p) => p.id === a.portId && p.deviceId === deviceId),
    )
    if (!ipKnown) {
      const portId = await identity('prt', `${obs.id}:interface`)
      doc.ports.push({
        ...newEntity('ports', portId),
        deviceId,
        name: '観測IF（名称未確認）',
        mac: typeof obs.value.mac === 'string' ? obs.value.mac : null,
        segmentIds: [segment.id],
        observedAt: options.now,
      })
      doc.ipAssignments.push({
        ...newEntity('ipAssignments', await identity('ip', `${obs.id}:address`)),
        portId,
        segmentId: segment.id,
        address: obs.value.ip,
        observation: 'observed',
      })
    }
    batch.bindings.push({
      key: bindingKey,
      collection: 'devices',
      entityId: deviceId,
      valueHash: await sha256(JSON.stringify(obs.value)),
    })
  }
  for (const finding of result.findings.filter((f) => selected.includes(f.id))) {
    if (
      !doc.auditRounds.some((r) => r.id === options.roundId && r.siteIds.includes(options.siteId))
    ) {
      throw new Error('監査回次を選んでください')
    }
    const bindingKey = `${result.runId}:${finding.id}:audit`
    const prior = doc.importBatches
      ?.filter((b) => b.state === 'applied')
      .flatMap((b) => b.bindings)
      .find((b) => b.key === bindingKey)
    if (prior) {
      batch.bindings.push(prior)
      continue
    }
    const audit = doc.auditResults.find(
      (a) =>
        a.roundId === options.roundId &&
        a.siteId === options.siteId &&
        a.itemNo === finding.itemNo &&
        a.scope === 'summary',
    )
    if (audit?.judgment !== 'unchecked') {
      conflicts.push(`No.${finding.itemNo}は確定済みまたは総括なし。再確認候補を参照してください`)
      continue
    }
    audit.finding = finding.reason
    audit.attempted = true
    audit.reason =
      finding.status === 'inconclusive'
        ? finding.reason
        : '自動収集の下書き。確認者による最終判定が必要です'
    audit.nextCheck = finding.nextCheck || '管理設定と現地確認で確定してください'
    audit.method = `自動収集 ${result.runId}`
    audit.evidenceIds = [...new Set([...audit.evidenceIds, evidenceId])]
    if (finding.status === 'finding') {
      const actionId = await identity('act', `${finding.id}:followup`)
      if (!doc.actionItems.some((a) => a.id === actionId)) {
        doc.actionItems.push({
          ...newEntity('actionItems', actionId),
          content: finding.reason,
          auditResultIds: [audit.id],
        })
      }
      audit.actionItemIds = [...new Set([...audit.actionItemIds, actionId])]
    }
    batch.bindings.push({
      key: bindingKey,
      collection: 'auditResults',
      entityId: audit.id,
      valueHash: await sha256(JSON.stringify(finding)),
    })
  }
  doc.importBatches = [...(doc.importBatches ?? []).filter((b) => b.id !== importId), batch]
  const validation = validate(doc)
  if (validation.errors.length) {
    throw new Error(validation.errors.map((i) => `${i.path}: ${i.message}`).join('\n'))
  }
  return { doc, importId, selectionHash, conflicts }
}
