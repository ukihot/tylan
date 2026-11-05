import { ja } from 'zod/locales'
import { inCidr, inRange, ipNumber } from './address'
import { AUDIT_MASTER } from './audit-master'
import { type Collection, type Doc, DocSchema, prefixes } from './schema'

export type Issue = { code: string; message: string; path: string; entityId: string | null }
export type ValidationResult = { errors: Issue[]; warnings: Issue[] }
export type Reference = {
  id: string
  collection: Collection
  path: string
  entityId: string | null
}
const referenceFields: Record<string, Collection> = {
  siteId: 'sites',
  siteIds: 'sites',
  locationId: 'locations',
  deviceId: 'devices',
  deviceIds: 'devices',
  apDeviceIds: 'devices',
  serverDeviceId: 'devices',
  portId: 'ports',
  segmentId: 'segments',
  segmentIds: 'segments',
  roundId: 'auditRounds',
  evidenceIds: 'evidence',
  actionItemIds: 'actionItems',
  auditResultIds: 'auditResults',
  linkIds: 'links',
}
const targetCollections = {
  device: 'devices',
  link: 'links',
  wirelessNetwork: 'wirelessNetworks',
  segment: 'segments',
  port: 'ports',
} as const
export function references(doc: Doc): Reference[] {
  const refs: Reference[] = []
  function walk(value: unknown, path: string, owner: string | null) {
    if (!value || typeof value !== 'object') {
      return
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        walk(v, `${path}.${i}`, owner)
      })
      return
    }
    const record = value as Record<string, unknown>
    for (const [key, v] of Object.entries(record)) {
      const p = `${path}.${key}`
      const collection = referenceFields[key]
      if (collection && v !== null) {
        for (const ref of Array.isArray(v) ? v : [v]) {
          refs.push({ id: String(ref), collection, path: p, entityId: owner })
        }
      } else if (key === 'targetRef' && v) {
        const t = v as { type: keyof typeof targetCollections; id: string }
        refs.push({
          id: t.id,
          collection: targetCollections[t.type],
          path: `${p}.id`,
          entityId: owner,
        })
      } else if (key === 'positions' || key === 'hidden') {
        const keys = key === 'positions' ? Object.keys(v as object) : (v as string[])
        for (const k of keys) {
          if (k.startsWith('dev_')) {
            refs.push({ id: k, collection: 'devices', path: p, entityId: owner })
          } else if (k.startsWith('unknown:')) {
            refs.push({ id: k.split(':')[1]!, collection: 'links', path: p, entityId: owner })
          } else {
            refs.push({ id: k, collection: 'devices', path: p, entityId: owner })
          }
        }
      } else if (key !== 'id') {
        walk(v, p, owner)
      }
    }
  }
  for (const collection of Object.keys(prefixes) as Collection[]) {
    doc[collection].forEach((entity, index) => {
      walk(entity, `${collection}.${index}`, entity.id)
    })
  }
  walk(doc.publishSettings, 'publishSettings', null)
  return refs
}
export function findReferences(doc: Doc, entityId: string): Reference[] {
  return references(doc).filter((r) => r.id === entityId)
}

export function validate(input: unknown): ValidationResult {
  const result: ValidationResult = { errors: [], warnings: [] }
  const parsed = DocSchema.safeParse(input, { error: ja().localeError })
  if (!parsed.success) {
    result.errors = parsed.error.issues.map((i) => ({
      code: 'structure',
      message: `入力形式を確認してください：${i.message}`,
      path: i.path.join('.'),
      entityId: null,
    }))
    return result
  }
  const d = parsed.data
  const add = (
    level: 'errors' | 'warnings',
    code: string,
    message: string,
    path: string,
    entityId: string | null = null,
  ) => result[level].push({ code, message, path, entityId })
  const error = (code: string, message: string, path: string, entityId: string | null = null) =>
    add('errors', code, message, path, entityId)
  const warn = (code: string, message: string, path: string, entityId: string | null = null) =>
    add('warnings', code, message, path, entityId)
  const indexes = Object.fromEntries(
    (Object.keys(prefixes) as Collection[]).map((k) => [k, new Set(d[k].map((e) => e.id))]),
  ) as Record<Collection, Set<string>>
  const ids = new Set<string>([d.project.id])
  for (const collection of Object.keys(prefixes) as Collection[]) {
    for (const entity of d[collection]) {
      if (ids.has(entity.id)) {
        error('duplicate-id', 'IDが重複しています', collection, entity.id)
      }
      ids.add(entity.id)
    }
  }
  for (const r of references(d)) {
    if (!indexes[r.collection]?.has(r.id)) {
      error('reference', '参照先が存在しないか、IDの種類が違います', r.path, r.entityId)
    }
  }
  if (result.errors.length) {
    return result
  }
  const devices = new Map(d.devices.map((e) => [e.id, e]))
  const ports = new Map(d.ports.map((e) => [e.id, e]))
  const segments = new Map(d.segments.map((e) => [e.id, e]))
  const locations = new Map(d.locations.map((e) => [e.id, e]))
  for (const device of d.devices) {
    if (device.locationId && locations.get(device.locationId)!.siteId !== device.siteId) {
      error('site-mismatch', '機器と設置場所の拠点が一致しません', 'devices', device.id)
    }
  }
  const connectionKeys = new Set<string>()
  const usedPorts = new Set<string>()
  for (const link of d.links) {
    if ('unknown' in link.a && 'unknown' in link.b) {
      error('link-site', '接続には少なくとも片側に既知の機器が必要です', 'links', link.id)
    }
    const keys: string[] = []
    for (const side of ['a', 'b'] as const) {
      const ep = link[side]
      if ('unknown' in ep) {
        keys.push(`unknown:${ep.unknown}`)
        continue
      }
      keys.push(`${ep.deviceId}:${ep.portId ?? '-'}`)
      if (ep.portId && ports.get(ep.portId)!.deviceId !== ep.deviceId) {
        error('port-owner', '端点の機器とポートの所属機器が一致しません', `links.${side}`, link.id)
      }
      if (link.kind === 'physical' && ep.portId) {
        if (usedPorts.has(ep.portId)) {
          error('port-used', '物理ポートが二重に利用されています', `links.${side}`, link.id)
        }
        usedPorts.add(ep.portId)
      }
    }
    if (
      'deviceId' in link.a &&
      'deviceId' in link.b &&
      link.a.portId &&
      link.a.portId === link.b.portId
    ) {
      error('self-link', '同じポート自身には接続できません', 'links', link.id)
    }
    const key = `${link.kind}:${keys.sort().join('|')}`
    if (connectionKeys.has(key)) {
      error('duplicate-link', '同じ接続が重複しています', 'links', link.id)
    }
    connectionKeys.add(key)
    if (link.certainty !== 'confirmed' || 'unknown' in link.a || 'unknown' in link.b) {
      warn('unconfirmed-link', '推定または接続先未確認の接続です', 'links', link.id)
    }
  }
  const ipKeys = new Set<string>()
  for (const a of d.ipAssignments) {
    if (!a.address) {
      continue
    }
    const ip = ipNumber(a.address)!
    const seg = segments.get(a.segmentId)!
    const key = `${a.segmentId}:${ip.bits}:${ip.value}`
    if (ipKeys.has(key)) {
      warn('duplicate-ip', '同じセグメント内でIPアドレスが重複しています', 'ipAssignments', a.id)
    }
    ipKeys.add(key)
    if (a.prefixLength !== null && a.prefixLength > ip.bits) {
      error('prefix-length', 'IPの種類に対してプレフィックス長が不正です', 'ipAssignments', a.id)
    }
    if (seg.cidr && !inCidr(a.address, seg.cidr)) {
      warn('outside-segment', 'IPアドレスがセグメント外です', 'ipAssignments', a.id)
    }
    if (inCidr(a.address, '169.254.0.0/16') || inCidr(a.address, 'fe80::/10')) {
      warn('link-local', 'リンクローカルIPアドレスです', 'ipAssignments', a.id)
    }
    if (a.mode === 'static') {
      for (const scope of d.dhcpScopes.filter((s) => s.segmentId === a.segmentId)) {
        if (
          scope.ranges.some((r) => inRange(a.address!, r)) &&
          !scope.exclusions.some((r) => inRange(a.address!, r))
        ) {
          warn('dhcp-overlap', '固定IPがDHCP配布範囲と重なっています', 'ipAssignments', a.id)
        }
      }
    }
  }
  for (const scope of d.dhcpScopes) {
    if (!!scope.serverDeviceId === !!scope.serverUnknown) {
      error(
        'dhcp-server',
        '配布元機器または不明先の説明のいずれかを指定してください',
        'dhcpScopes',
        scope.id,
      )
    }
    const segment = segments.get(scope.segmentId)!
    for (const range of [...scope.ranges, ...scope.exclusions]) {
      const a = ipNumber(range.start)!
      const b = ipNumber(range.end)!
      if (a.bits !== b.bits || a.value > b.value) {
        error(
          'range-order',
          'DHCP範囲の開始と終了の種類・順序を確認してください',
          'dhcpScopes',
          scope.id,
        )
      }
      if (
        segment.cidr &&
        (!inCidr(range.start, segment.cidr) || !inCidr(range.end, segment.cidr))
      ) {
        warn('outside-segment', 'DHCP範囲がセグメント外です', 'dhcpScopes', scope.id)
      }
    }
    for (const r of scope.reservations) {
      if (segment.cidr && !inCidr(r.address, segment.cidr)) {
        warn('outside-segment', 'DHCP予約がセグメント外です', 'dhcpScopes', scope.id)
      }
    }
  }
  for (const wireless of d.wirelessNetworks) {
    for (const ap of wireless.apDeviceIds) {
      if (devices.get(ap)!.siteId !== wireless.siteId) {
        error('site-mismatch', 'SSIDとAPの拠点が一致しません', 'wirelessNetworks', wireless.id)
      }
    }
  }
  const itemNos = d.auditTemplate.items.map((i) => i.no)
  if (new Set(itemNos).size !== 20 || AUDIT_MASTER.some((i) => !itemNos.includes(i.no))) {
    error('audit-master', '監査項目はNo.1〜8・12〜23の20項目にしてください', 'auditTemplate')
  }
  const roundMap = new Map(d.auditRounds.map((r) => [r.id, r]))
  const summaryKeys = new Set<string>()
  for (const round of d.auditRounds) {
    if (new Set(round.siteIds).size !== round.siteIds.length) {
      error('duplicate-site', '回次内の拠点が重複しています', 'auditRounds', round.id)
    }
    if (round.startDate && round.endDate && round.startDate > round.endDate) {
      error('date-order', '調査期間の開始と終了が逆です', 'auditRounds', round.id)
    }
    for (const siteId of round.siteIds) {
      const summaries = d.auditResults.filter(
        (r) => r.roundId === round.id && r.siteId === siteId && r.scope === 'summary',
      )
      if (
        summaries.length !== 20 ||
        d.auditTemplate.items.some((i) => !summaries.some((s) => s.itemNo === i.no))
      ) {
        error('audit-summary', '回次の各拠点には20項目の総括が必要です', 'auditRounds', round.id)
      }
    }
  }
  for (const r of d.auditResults) {
    if (!roundMap.get(r.roundId)!.siteIds.includes(r.siteId) || !itemNos.includes(r.itemNo)) {
      error(
        'audit-target',
        '監査の拠点または項目が回次・マスターと一致しません',
        'auditResults',
        r.id,
      )
    }
    if (r.scope === 'summary') {
      const key = `${r.roundId}:${r.siteId}:${r.itemNo}`
      if (summaryKeys.has(key)) {
        error('audit-duplicate', '同じ項目の総括が重複しています', 'auditResults', r.id)
      }
      summaryKeys.add(key)
      const targets = d.auditResults.filter(
        (t) =>
          t.scope === 'target' &&
          t.roundId === r.roundId &&
          t.siteId === r.siteId &&
          t.itemNo === r.itemNo,
      )
      if (
        ((r.judgment === 'ok' || r.judgment === 'na') &&
          targets.some((t) => t.judgment === 'ng')) ||
        (r.judgment === 'ok' && targets.some((t) => t.judgment === 'unchecked'))
      ) {
        error(
          'audit-conflict',
          '総括と対象別の判定が矛盾しています。総括も確認してください',
          'auditResults',
          r.id,
        )
      }
    }
    if (r.targetRef) {
      const t = r.targetRef
      let sites: string[] = []
      if (t.type === 'device') {
        sites = [devices.get(t.id)!.siteId]
      }
      if (t.type === 'port') {
        sites = [devices.get(ports.get(t.id)!.deviceId)!.siteId]
      }
      if (t.type === 'segment') {
        sites = [segments.get(t.id)!.siteId]
      }
      if (t.type === 'wirelessNetwork') {
        sites = [d.wirelessNetworks.find((w) => w.id === t.id)!.siteId]
      }
      if (t.type === 'link') {
        const l = d.links.find((l) => l.id === t.id)!
        sites = [l.a, l.b].flatMap((e) =>
          'deviceId' in e ? [devices.get(e.deviceId)!.siteId] : [],
        )
      }
      if (!sites.includes(r.siteId)) {
        error('site-mismatch', '監査対象がこの拠点に属していません', 'auditResults', r.id)
      }
    }
  }
  for (const layout of d.layouts) {
    const deviceIds = [
      ...layout.deviceIds,
      ...Object.keys(layout.positions).filter((k) => k.startsWith('dev_')),
      ...layout.hidden.filter((k) => k.startsWith('dev_')),
    ]
    if (deviceIds.some((id) => devices.get(id)?.siteId !== layout.siteId)) {
      error('site-mismatch', '図の配置に別拠点の機器が含まれています', 'layouts', layout.id)
    }
    for (const key of [...Object.keys(layout.positions), ...layout.hidden].filter((k) =>
      k.startsWith('unknown:'),
    )) {
      const [, linkId, side] = key.split(':')
      const link = d.links.find((l) => l.id === linkId)
      if (!link || (side !== 'a' && side !== 'b') || !('unknown' in link[side])) {
        error('unknown-endpoint', '図の不明端点が存在しません', 'layouts', layout.id)
      }
    }
  }
  return result
}
