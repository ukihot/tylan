// Fictional acceptance dataset. This module is only imported by development scripts and tests.

import { startRound } from './commands'
import { autoLayout } from './layout'
import { emptyDoc, newEntity } from './schema'

export function sampleDoc() {
  const id = (prefix: string, n: number) => `${prefix}_${String(n).padStart(16, '0')}`
  const doc = emptyDoc('2026-11-05T14:30:00+09:00', id('prj', 1))
  doc.project.name = '架空の本社LAN · 操作確認用'
  doc.sites.push({ ...newEntity('sites', id('sit', 1)), name: '本社（サンプル）' })
  doc.locations.push({
    ...newEntity('locations', id('loc', 1)),
    siteId: id('sit', 1),
    name: '1F サーバーラック',
  })
  const kinds = ['serviceAdapter', 'switch', 'switch', 'ap', 'ap', 'pc', 'printer', 'nas'] as const
  kinds.forEach((kind, i) => {
    doc.devices.push({
      ...newEntity('devices', id('dev', i + 1)),
      name: [
        'IIJサービスアダプタ',
        'コアスイッチ',
        'フロアスイッチ',
        '業務AP',
        'ゲストAP',
        '業務PC',
        '共用プリンタ',
        'NAS',
      ][i]!,
      kind,
      siteId: id('sit', 1),
      locationId: i < 3 ? id('loc', 1) : null,
      observation: i === 4 ? 'unknown' : 'observed',
      approval: i === 4 ? 'unknown' : 'approved',
      usage: 'active',
    })
  })
  doc.segments.push({
    ...newEntity('segments', id('seg', 1)),
    siteId: id('sit', 1),
    name: '業務LAN',
    cidr: '192.168.10.0/24',
    vlanId: 10,
    gateway: '192.168.10.1',
    dns: ['192.168.10.2'],
  })
  let portNumber = 0
  let linkNumber = 0
  function attach(a: number, b: number | null, kind: 'physical' | 'wireless' = 'physical') {
    const port = (device: number) => {
      const p = {
        ...newEntity('ports', id('prt', ++portNumber)),
        deviceId: id('dev', device),
        name: `LAN${portNumber}`,
        medium: kind === 'physical' ? ('copper' as const) : ('wireless' as const),
        status: 'used' as const,
        segmentIds: [id('seg', 1)],
      }
      doc.ports.push(p)
      return p.id
    }
    const pa = port(a)
    const pb = b ? port(b) : null
    doc.links.push({
      ...newEntity('links', id('lnk', ++linkNumber)),
      a: { deviceId: id('dev', a), portId: pa },
      b: b ? { deviceId: id('dev', b), portId: pb } : { unknown: '天井裏の接続先未確認' },
      kind,
      certainty: b ? 'confirmed' : 'estimated',
      speedMbps: 1000,
    })
  }
  attach(1, 2)
  attach(1, 3)
  attach(2, 3)
  attach(2, 4)
  attach(3, 5)
  attach(4, 6, 'wireless')
  attach(3, 7)
  attach(2, 8)
  attach(3, null)
  doc.ports.push({
    ...newEntity('ports', id('prt', ++portNumber)),
    deviceId: id('dev', 2),
    name: '用途不明ポート',
  })
  for (const device of doc.devices) {
    doc.ipAssignments.push({
      ...newEntity('ipAssignments', id('ip', doc.ipAssignments.length + 1)),
      portId: doc.ports.find((p) => p.deviceId === device.id)!.id,
      segmentId: id('seg', 1),
      address: `192.168.10.${device.kind === 'serviceAdapter' ? 1 : doc.ipAssignments.length + 100}`,
      mode: 'static',
      prefixLength: 24,
      observation: 'observed',
    })
  }
  doc.dhcpScopes.push({
    ...newEntity('dhcpScopes', id('dhc', 1)),
    segmentId: id('seg', 1),
    serverDeviceId: id('dev', 1),
    serverUnknown: null,
    ranges: [{ start: '192.168.10.100', end: '192.168.10.200' }],
    lease: { value: 24, unit: 'hours' },
    approval: 'approved',
  })
  doc.wirelessNetworks.push({
    ...newEntity('wirelessNetworks', id('wln', 1)),
    siteId: id('sit', 1),
    ssid: 'SAMPLE-BUSINESS',
    apDeviceIds: [id('dev', 4)],
    segmentIds: [id('seg', 1)],
    authentication: 'wpa3',
    passwordManagement: 'managed',
    guestIsolation: 'enabled',
  })
  doc.evidence.push({
    ...newEntity('evidence', id('evd', 1)),
    description: '配線調査票（架空）',
    referenceNumber: 'SAMPLE-001',
    storageLocation: '社内管理場所を文字列で記録',
  })
  const created = startRound(
    doc,
    {
      ...newEntity('auditRounds', id('rnd', 1)),
      name: '2026年度 初回調査',
      siteIds: [id('sit', 1)],
      startDate: '2026-11-05',
    },
    Array.from({ length: 20 }, (_, i) => id('aud', i + 1)),
  )
  if (!created.ok) {
    throw new Error(JSON.stringify(created.errors))
  }
  const next = created.doc
  next.actionItems.push({
    ...newEntity('actionItems', id('act', 1)),
    content: 'ゲストAPの承認状態を確認する',
    auditResultIds: [id('aud', 99)],
    targetRef: { type: 'device', id: id('dev', 5) },
    priority: 'high',
  })
  next.auditResults.push({
    ...newEntity('auditResults', id('aud', 99)),
    roundId: id('rnd', 1),
    siteId: id('sit', 1),
    itemNo: 4,
    scope: 'target',
    targetRef: { type: 'device', id: id('dev', 5) },
    judgment: 'ng',
    finding: '管理担当への確認が必要',
    problem: '承認記録が見つからない',
    checkedBy: 'サンプル調査者',
    checkedDate: '2026-11-05',
    actionItemIds: [id('act', 1)],
    evidenceIds: [id('evd', 1)],
  })
  const layout = {
    ...newEntity('layouts', id('lay', 1)),
    name: '本社ネットワーク構成図',
    siteId: id('sit', 1),
  }
  layout.positions = autoLayout(next, id('sit', 1), layout)
  next.layouts.push(layout)
  next.publishSettings.siteIds = [id('sit', 1)]
  return next
}
