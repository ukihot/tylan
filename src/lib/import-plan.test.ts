import { expect, test } from 'vitest'
import { groupDevices, migrateV2, planImport } from './import-plan'
import { parseDocument } from './io'
import { toPublic } from './publish'
import { fixture, id, NOW } from './test-fixture'
import { validate } from './validate'

const observation = {
  id: 'observedPrinter',
  type: 'device',
  source: 'nmap',
  segment: id('sit', 1),
  observedAt: NOW,
  value: { ip: '192.168.1.42', mac: '00:11:22:33:44:55', hostname: 'printer', ports: [] },
}
const result = {
  format: 'tylan-collection',
  schemaVersion: 1,
  runId: 'run1',
  profile: {},
  tools: {},
  startedAt: NOW,
  endedAt: NOW,
  scope: {},
  collectors: [],
  observations: [observation],
  findings: [],
}
const options = {
  documentId: id('doc', 1),
  siteId: id('sit', 1),
  segmentId: id('seg', 1),
  roundId: null,
  selected: ['observedPrinter'],
  mappings: {},
  checkedBy: '調査者',
  now: NOW,
  packageHash: 'a'.repeat(64),
  storageLocation: '\\\\server\\evidence\\sealed',
}

test('migration preserves original and round-trip rejects unknown future versions', () => {
  const original = fixture()
  const migrated = migrateV2(original, options.documentId)
  expect(original.schemaVersion).toBe(1)
  expect(migrated.schemaVersion).toBe(2)
  expect(parseDocument(JSON.stringify(migrated)).documentId).toBe(options.documentId)
  expect(() => parseDocument(JSON.stringify({ ...migrated, schemaVersion: 3 }))).toThrow()
})

test('repeated and overlapping imports use stable identities without duplicating assets', async () => {
  const first = await planImport(fixture(), result, options)
  expect(first.doc.devices).toHaveLength(3)
  expect(validate(first.doc).errors).toEqual([])
  for (let i = 0; i < 12; i++) {
    const again = await planImport(first.doc, result, options)
    expect(again.doc).toEqual(first.doc)
  }
  expect(first.doc.links).toEqual(fixture().links)
  expect(first.doc.devices.at(-1)?.approval).toBe('unknown')
})

test('IP-only candidate requires an explicit mapping; confirmed manual fields survive', async () => {
  const sameIp = {
    ...result,
    observations: [{ ...observation, value: { ...observation.value, ip: '192.168.1.100' } }],
  }
  await expect(planImport(fixture(), sameIp, options)).rejects.toThrow(/照合/)
  const plan = await planImport(fixture(), sameIp, {
    ...options,
    mappings: { observedPrinter: id('dev', 1) },
  })
  expect(plan.doc.devices).toHaveLength(2)
  expect(plan.doc.devices[0]?.name).toBe('機器1')
})

test('invalid evidence hash, cross-segment assignment and unsafe result are refused', async () => {
  await expect(planImport(fixture(), result, { ...options, packageHash: '' })).rejects.toThrow()
  const outside = {
    ...result,
    observations: [{ ...observation, value: { ...observation.value, ip: '10.0.0.1' } }],
  }
  await expect(planImport(fixture(), outside, options)).rejects.toThrow()
  await expect(planImport(fixture(), { ...result, injected: true }, options)).rejects.toThrow()
})

const managed = (id: string, type: string, value: Record<string, unknown>) => ({
  id,
  type,
  source: 'switch-export',
  segment: 'site',
  observedAt: NOW,
  value,
})
const lldp = managed('lldp1', 'physicalCandidate', {
  protocol: 'lldp',
  localDevice: 'SW-1',
  localPort: 'Gi1',
  remoteDevice: 'AP-1',
  remotePort: 'eth0',
  vendor: 'generic',
  certainty: 'estimated',
  linkKind: 'physical',
  observationTimeKnown: false,
})
const macTable = managed('mac1', 'physicalCandidate', {
  protocol: 'mac-table',
  localDevice: 'SW-1',
  localPort: 'Gi2',
  remoteDevice: '00:11:22:33:44:55',
  remotePort: null,
  vendor: 'generic',
  certainty: 'estimated',
  linkKind: 'logical',
  observationTimeKnown: false,
})
const switchRun = { ...result, runId: 'run2', observations: [lldp, macTable] }
const endpoints = (a: string, b: string) => ({
  a: { deviceId: id('dev', 2), portId: a ? id('prt', 2) : null },
  b: b ? { deviceId: id('dev', 1), portId: null } : { unknown: '00:11:22:33:44:55' },
})

test('switch candidates become links only through an explicit endpoint mapping', async () => {
  const noLinks = { ...options, selected: ['lldp1'] }
  await expect(planImport(fixture(), switchRun, noLinks)).rejects.toThrow(/対応付け/)
  const plan = await planImport(fixture(), switchRun, {
    ...options,
    selected: ['lldp1', 'mac1'],
    links: { lldp1: endpoints('', 'dev'), mac1: endpoints('', '') },
  })
  const added = plan.doc.links.slice(fixture().links.length)
  expect(added.map((l) => [l.kind, l.certainty])).toEqual([
    ['physical', 'estimated'],
    ['logical', 'estimated'],
  ])
  expect(added[0]?.notes).toMatch(/LLDP/)
  expect(added[1]?.b).toEqual({ unknown: '00:11:22:33:44:55' })
  expect(validate(plan.doc).errors).toEqual([])
  const again = await planImport(plan.doc, switchRun, {
    ...options,
    selected: ['lldp1', 'mac1'],
    links: { lldp1: endpoints('', 'dev'), mac1: endpoints('', '') },
  })
  expect(again.doc).toEqual(plan.doc)
})

test('a link mapping to a port of another device or to no known device is refused', async () => {
  const wrongPort = {
    a: { deviceId: id('dev', 1), portId: id('prt', 2) },
    b: { deviceId: id('dev', 2), portId: null },
  }
  await expect(
    planImport(fixture(), switchRun, {
      ...options,
      selected: ['lldp1'],
      links: { lldp1: wrongPort },
    }),
  ).rejects.toThrow()
  const nothingKnown = { a: { unknown: 'SW-1' }, b: { unknown: 'AP-1' } }
  await expect(
    planImport(fixture(), switchRun, {
      ...options,
      selected: ['lldp1'],
      links: { lldp1: nothingKnown },
    }),
  ).rejects.toThrow()
})

const adRun = {
  ...result,
  runId: 'run3',
  observations: [
    managed('ad1', 'adComputer', {
      name: 'PC-01',
      objectGUID: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
      dnsHostName: 'pc-01.example.internal',
      operatingSystem: 'Windows 11',
      enabled: true,
    }),
  ],
}

test('AD computers are adopted as new devices or bound to an existing one without edits', async () => {
  await expect(planImport(fixture(), adRun, { ...options, selected: ['ad1'] })).rejects.toThrow(
    /照合/,
  )
  const created = await planImport(fixture(), adRun, {
    ...options,
    selected: ['ad1'],
    mappings: { ad1: 'new' },
  })
  const device = created.doc.devices.at(-1)!
  expect(device.name).toBe('PC-01')
  expect(device.notes).toMatch(/3f2504e0/)
  const bound = await planImport(fixture(), adRun, {
    ...options,
    selected: ['ad1'],
    mappings: { ad1: id('dev', 1) },
  })
  expect(bound.doc.devices).toEqual(migrateV2(fixture(), options.documentId).devices)
  expect(bound.doc.importBatches?.at(-1)?.bindings[0]?.entityId).toBe(id('dev', 1))
})

const scopeRun = {
  ...result,
  runId: 'run4',
  observations: [
    managed('scope1', 'dhcpScope', {
      server: '192.168.1.3',
      scopeId: '192.168.1.0',
      name: 'LAN',
      subnetMask: '255.255.255.0',
      start: '192.168.1.100',
      end: '192.168.1.200',
      leaseSeconds: 691200,
      exclusions: [{ start: '192.168.1.150', end: '192.168.1.160' }],
      reservations: [{ address: '192.168.1.120', clientId: '00-11-22-33-44-66' }],
      leases: [],
      options: [
        { optionId: 3, values: ['192.168.1.1'] },
        { optionId: 6, values: ['192.168.1.2'] },
      ],
    }),
  ],
}

test('a DHCP server scope fills an empty segment and never overwrites a recorded scope', async () => {
  const kept = await planImport(fixture(), scopeRun, { ...options, selected: ['scope1'] })
  expect(kept.doc.dhcpScopes).toEqual(fixture().dhcpScopes)
  expect(kept.conflicts.join()).toMatch(/DHCP/)
  const empty = fixture()
  empty.dhcpScopes = []
  const filled = await planImport(empty, scopeRun, { ...options, selected: ['scope1'] })
  const scope = filled.doc.dhcpScopes[0]!
  expect(scope.segmentId).toBe(id('seg', 1))
  expect(scope.ranges).toEqual([{ start: '192.168.1.100', end: '192.168.1.200' }])
  expect(scope.exclusions).toEqual([{ start: '192.168.1.150', end: '192.168.1.160' }])
  expect(scope.reservations).toEqual([{ address: '192.168.1.120', mac: '00:11:22:33:44:66' }])
  expect(scope.lease).toEqual({ value: 8, unit: 'days' })
  expect([scope.gateway, scope.dns, scope.approval]).toEqual([
    '192.168.1.1',
    ['192.168.1.2'],
    'unknown',
  ])
  expect(scope.serverUnknown).toMatch(/192\.168\.1\.3/)
})

test('a managed Windows host keeps its static/DHCP assignment mode', async () => {
  const windows = {
    ...result,
    observations: [{ ...observation, value: { ...observation.value, assignmentMode: 'static' } }],
  }
  const plan = await planImport(fixture(), windows, options)
  expect(plan.doc.ipAssignments.at(-1)?.mode).toBe('static')
})

const camera = {
  ...observation,
  id: 'observedCamera',
  value: { ...observation.value, ip: '192.168.1.43', mac: '00:11:22:33:44:77', hostname: 'cam' },
}
const two = { ...result, observations: [observation, camera] }

test('overlapping partial imports and retries never duplicate an adopted observation', async () => {
  const first = await planImport(fixture(), two, { ...options, selected: ['observedPrinter'] })
  const second = await planImport(first.doc, two, {
    ...options,
    selected: ['observedPrinter', 'observedCamera'],
  })
  expect(second.doc.devices).toHaveLength(4)
  expect(second.doc.importBatches).toHaveLength(2)
  const printerKey = 'run1:observedPrinter:device'
  expect(second.doc.importBatches![1]!.bindings.find((b) => b.key === printerKey)).toEqual(
    first.doc.importBatches![0]!.bindings[0],
  )
  const retry = await planImport(second.doc, two, {
    ...options,
    selected: ['observedPrinter', 'observedCamera'],
  })
  expect(retry.doc).toEqual(second.doc)
})

test('re-adopting after Undo keeps the reverted record and the same stable ids', async () => {
  const first = await planImport(fixture(), result, options)
  const undone = migrateV2(fixture(), options.documentId)
  undone.importBatches = first.doc.importBatches!.map((b) => ({ ...b, state: 'reverted' as const }))
  const again = await planImport(undone, result, options)
  expect(again.importId).not.toBe(first.importId)
  expect(again.doc.importBatches!.map((b) => b.state)).toEqual(['reverted', 'applied'])
  expect(again.doc.devices.at(-1)!.id).toBe(first.doc.devices.at(-1)!.id)
  // A canonical file restored to an older version (no batch at all) also maps to the same ids.
  const restored = await planImport(fixture(), result, options)
  expect(restored.doc.devices.at(-1)!.id).toBe(first.doc.devices.at(-1)!.id)
})

test('the same importId with another run, selection or package is refused', async () => {
  const first = await planImport(fixture(), result, options)
  const tampered = structuredClone(first.doc)
  tampered.importBatches![0]!.selectionHash = 'f'.repeat(64)
  await expect(planImport(tampered, result, options)).rejects.toThrow(/取り込みID/)
})

test('the public projection never carries import records or the document identity', async () => {
  const plan = await planImport(fixture(), result, options)
  const publicDoc = toPublic(plan.doc, { siteIds: [id('sit', 1)], fields: { evidence: true } }, NOW)
  const text = JSON.stringify(publicDoc)
  expect(text).not.toContain(plan.importId)
  expect(text).not.toContain(options.documentId)
  expect(text).not.toContain('a'.repeat(64))
})

test('one PC seen in hundreds of ARP packets and both Nmap phases is one row', () => {
  const at = (s: number) => `2026-11-10T15:50:${String(s).padStart(2, '0')}+09:00`
  const obs = (id: string, type: string, source: string, s: number, value: object) => ({
    id,
    type,
    source,
    observedAt: at(s),
    segment: 'sit',
    value,
  })
  const pc = { ip: '192.168.8.47', mac: 'b0:7b:25:17:87:d2' }
  const rows = groupDevices([
    ...Array.from({ length: 300 }, (_, i) => obs(`a${i}`, 'arp', 'tshark', i % 60, pc)),
    obs('n1', 'device', 'nmap', 10, { ...pc, ports: [], hostname: null }),
    obs('n2', 'device', 'nmap', 20, {
      ...pc,
      ports: [
        { port: 445, protocol: 'tcp', state: 'open' },
        { port: 22, protocol: 'tcp', state: 'filtered' },
      ],
    }),
    obs('x', 'arp', 'tshark', 5, { ip: '192.168.8.5', mac: '00:00:00:00:00:05' }),
    obs('dns', 'dns', 'tshark', 5, { ip: '192.168.8.5' }),
  ] as never)
  expect(rows.map((r) => r.ip)).toEqual(['192.168.8.5', '192.168.8.47'])
  const row = rows[1]!
  expect(row.ids).toHaveLength(302)
  expect(row.sources).toEqual(['tshark', 'nmap'])
  expect([row.first, row.last]).toEqual([at(0), at(59)])
  expect(row.openPorts).toEqual(['445/tcp'])
})
