import { inCidr } from './address'
import {
  type CollectionResult,
  CollectionSchema,
  type Observation,
  sha256,
} from './collection-schema'
import { type Doc, type EntityMap, type ImportBatch, newEntity } from './schema'
import { validate } from './validate'

export type Endpoint = EntityMap['links']['a']
export type ImportOptions = {
  documentId: string
  siteId: string
  segmentId: string
  roundId: string | null
  selected: string[]
  /** observation id → existing device id or 'new' */
  mappings: Record<string, string>
  /** switch candidate id → both endpoints chosen by the operator; never inferred */
  links?: Record<string, { a: Endpoint; b: Endpoint }>
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
  if (obs.type === 'adComputer') {
    const name = String(obs.value.name ?? '').toLowerCase()
    return doc.devices.filter((d) => d.siteId === siteId && d.name.toLowerCase() === name)
  }
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
const endKey = (end: Endpoint) =>
  'unknown' in end ? `unknown:${end.unknown}` : `${end.deviceId}:${end.portId ?? '-'}`
const linkKey = (kind: string, a: Endpoint, b: Endpoint) =>
  `${kind}:${[endKey(a), endKey(b)].sort().join('|')}`
const maskBits = (mask: string) =>
  mask.split('.').reduce((n, octet) => n + Number(octet).toString(2).replaceAll('0', '').length, 0)
function leaseOf(seconds: unknown): EntityMap['dhcpScopes']['lease'] {
  if (typeof seconds !== 'number' || seconds <= 0) {
    return null
  }
  if (seconds % 86400 === 0) {
    return { value: seconds / 86400, unit: 'days' }
  }
  if (seconds % 3600 === 0) {
    return { value: seconds / 3600, unit: 'hours' }
  }
  return { value: Math.ceil(seconds / 60), unit: 'minutes' }
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
  const links = Object.entries(options.links ?? {}).sort()
  const selectionHash = await sha256(
    JSON.stringify([
      selected,
      Object.entries(options.mappings).sort(),
      ...(links.length ? [links] : []),
    ]),
  )
  const seed = `${doc.documentId}:${result.runId}`
  const identity = async (prefix: string, key: string) =>
    `${prefix}_${(await sha256(`${seed}:${key}`)).slice(0, 16)}`
  // Re-adopting after Undo is a new operation: the reverted record stays, entity ids stay stable.
  const generation = (doc.importBatches ?? []).filter(
    (b) => b.runId === result.runId && b.selectionHash === selectionHash && b.state === 'reverted',
  ).length
  const importId = await identity(
    'imp',
    generation ? `${selectionHash}:${generation}` : selectionHash,
  )
  const existing = doc.importBatches?.find((b) => b.id === importId)
  if (
    existing &&
    (existing.runId !== result.runId ||
      existing.selectionHash !== selectionHash ||
      existing.packageHash !== options.packageHash)
  ) {
    throw new Error('同じ取り込みIDの内容が違います（run・選択・証跡を確認してください）')
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
  const prior = (bindingKey: string) =>
    doc.importBatches
      ?.filter((b) => b.state === 'applied')
      .flatMap((b) => b.bindings)
      .find((b) => b.key === bindingKey)
  const bind = async (
    key: string,
    collection: ImportBatch['bindings'][number]['collection'],
    entityId: string,
    value: unknown,
  ) =>
    batch.bindings.push({
      key,
      collection,
      entityId,
      valueHash: await sha256(JSON.stringify(value)),
    })
  for (const key of selected) {
    const obs = result.observations.find((o) => o.id === key)
    if (!obs) {
      continue
    }
    const v = obs.value
    if (obs.type === 'physicalCandidate') {
      const bindingKey = `${result.runId}:${obs.id}:link`
      const known = prior(bindingKey)
      if (known) {
        if (!doc.links.some((l) => l.id === known.entityId)) {
          throw new Error('採用先の接続が削除されています。再照合してください')
        }
        batch.bindings.push(known)
        continue
      }
      const mapping = options.links?.[obs.id]
      if (!mapping) {
        throw new Error('接続候補の両端の対応付けを選択してください（物理配線は推測で作りません）')
      }
      for (const end of [mapping.a, mapping.b]) {
        if (
          'deviceId' in end &&
          !doc.devices.some((d) => d.id === end.deviceId && d.siteId === options.siteId)
        ) {
          throw new Error('対応付けた機器がこの拠点にありません')
        }
      }
      // MAC tables can hide hubs: they never become a physical cable.
      const kind = v.linkKind === 'physical' ? 'physical' : 'logical'
      const same = doc.links.find(
        (l) => linkKey(l.kind, l.a, l.b) === linkKey(kind, mapping.a, mapping.b),
      )
      const linkId = same?.id ?? (await identity('lnk', `${obs.id}:link`))
      if (!same) {
        doc.links.push({
          ...newEntity('links', linkId),
          a: mapping.a,
          b: mapping.b,
          kind,
          certainty: 'estimated',
          notes:
            `${String(v.protocol).toUpperCase()} ${String(v.localDevice)} ${String(v.localPort)} ↔ ${String(v.remoteDevice)} ${String(v.remotePort ?? '-')}（${String(v.vendor)}のエクスポート）`.slice(
              0,
              2000,
            ),
        })
      }
      await bind(bindingKey, 'links', linkId, v)
      continue
    }
    if (obs.type === 'adComputer') {
      const bindingKey = `${result.runId}:${obs.id}:device`
      const known = prior(bindingKey)
      if (known) {
        batch.bindings.push(known)
        continue
      }
      const mapping = options.mappings[obs.id]
      if (!mapping) {
        throw new Error('AD機器は既存機器との照合（新規または既存）を選択してください')
      }
      const deviceId = mapping === 'new' ? await identity('dev', `${obs.id}:device`) : mapping
      if (
        mapping !== 'new' &&
        !doc.devices.some((d) => d.id === deviceId && d.siteId === options.siteId)
      ) {
        throw new Error('採用先の機器がありません')
      }
      if (!doc.devices.some((d) => d.id === deviceId)) {
        // AD registration proves neither operation nor address: observation stays unknown.
        doc.devices.push({
          ...newEntity('devices', deviceId),
          name: String(v.name).slice(0, 100),
          siteId: options.siteId,
          notes:
            `AD objectGUID ${String(v.objectGUID)} / ${String(v.dnsHostName ?? '-')} / ${String(v.operatingSystem ?? '-')}（AD登録は稼働・IPを保証しません）`.slice(
              0,
              2000,
            ),
        })
      }
      await bind(bindingKey, 'devices', deviceId, v)
      continue
    }
    if (obs.type === 'dhcpScope') {
      const bindingKey = `${result.runId}:${obs.id}:dhcpScope`
      const known = prior(bindingKey)
      if (known) {
        batch.bindings.push(known)
        continue
      }
      const cidr = `${String(v.scopeId)}/${maskBits(String(v.subnetMask))}`
      const target = doc.segments.find((s) => s.siteId === options.siteId && s.cidr === cidr)
      if (!target) {
        conflicts.push(`DHCPスコープ${cidr}に対応するセグメントがありません`)
        continue
      }
      if (doc.dhcpScopes.some((s) => s.segmentId === target.id)) {
        conflicts.push(`DHCPスコープ${cidr}は記録済みです。手入力値を上書きしません`)
        continue
      }
      const option = (n: number) =>
        ((v.options as { optionId: number; values: string[] }[]) ?? []).find(
          (o) => o.optionId === n,
        )?.values ?? []
      const scopeId = await identity('dhc', `${obs.id}:scope`)
      doc.dhcpScopes.push({
        ...newEntity('dhcpScopes', scopeId),
        segmentId: target.id,
        serverUnknown: `DHCP ${String(v.server)}（管理情報から取得）`.slice(0, 100),
        ranges: [{ start: String(v.start), end: String(v.end) }],
        exclusions: (v.exclusions as { start: string; end: string }[]) ?? [],
        reservations: ((v.reservations as { address: string; clientId: string }[]) ?? [])
          .filter((r) => /^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(r.clientId))
          .map((r) => ({ address: r.address, mac: r.clientId.replaceAll('-', ':').toLowerCase() })),
        lease: leaseOf(v.leaseSeconds),
        dns: option(6),
        gateway: option(3)[0] ?? null,
      })
      await bind(bindingKey, 'dhcpScopes', scopeId, v)
      continue
    }
    if (!['device', 'arp'].includes(obs.type)) {
      continue
    }
    if (!segment?.cidr || typeof v.ip !== 'string' || !inCidr(v.ip, segment.cidr)) {
      throw new Error('観測IPのセグメントを確認してください')
    }
    const bindingKey = `${result.runId}:${obs.id}:device`
    const known = prior(bindingKey)
    if (known) {
      if (!doc.devices.some((d) => d.id === known.entityId)) {
        throw new Error('採用先が削除されています。再照合してください')
      }
      batch.bindings.push(known)
      observationDevices.set(obs.id, known.entityId)
      continue
    }
    const possible = candidates(original, obs, options.siteId)
    const mapping = options.mappings[obs.id]
    if (!mapping && possible.length) {
      throw new Error('既存機器の照合を選択してください')
    }
    const observedKey = `${v.ip}:${String(v.mac ?? '')}`
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
        name: String(v.hostname || v.ip).slice(0, 100),
        siteId: options.siteId,
        observation: 'observed',
        lastCheckedDate: options.now.slice(0, 10),
      })
    }
    observationDevices.set(obs.id, deviceId)
    observationDevices.set(observedKey, deviceId)
    const ipKnown = doc.ipAssignments.some(
      (a) =>
        a.address === v.ip &&
        a.segmentId === segment.id &&
        doc.ports.some((p) => p.id === a.portId && p.deviceId === deviceId),
    )
    if (!ipKnown) {
      const portId = await identity('prt', `${obs.id}:interface`)
      doc.ports.push({
        ...newEntity('ports', portId),
        deviceId,
        name: '観測IF（名称未確認）',
        mac: typeof v.mac === 'string' ? v.mac : null,
        segmentIds: [segment.id],
        observedAt: options.now,
      })
      doc.ipAssignments.push({
        ...newEntity('ipAssignments', await identity('ip', `${obs.id}:address`)),
        portId,
        segmentId: segment.id,
        address: v.ip,
        mode:
          v.assignmentMode === 'static' || v.assignmentMode === 'dhcp'
            ? v.assignmentMode
            : 'unknown',
        observation: 'observed',
      })
    }
    await bind(bindingKey, 'devices', deviceId, v)
  }
  for (const finding of result.findings.filter((f) => selected.includes(f.id))) {
    if (
      !doc.auditRounds.some((r) => r.id === options.roundId && r.siteIds.includes(options.siteId))
    ) {
      throw new Error('監査回次を選んでください')
    }
    const bindingKey = `${result.runId}:${finding.id}:audit`
    const known = prior(bindingKey)
    if (known) {
      batch.bindings.push(known)
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
    await bind(bindingKey, 'auditResults', audit.id, finding)
  }
  doc.importBatches = [...(doc.importBatches ?? []).filter((b) => b.id !== importId), batch]
  const validation = validate(doc)
  if (validation.errors.length) {
    throw new Error(validation.errors.map((i) => `${i.path}: ${i.message}`).join('\n'))
  }
  return { doc, importId, selectionHash, conflicts }
}
