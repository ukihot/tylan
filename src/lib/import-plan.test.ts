import { expect, test } from 'vitest'
import { analyze, baselineFor, planImport } from './import-plan'
import { toPublic } from './publish'
import { fixture, fixtureWithRound, id, NOW } from './test-fixture'
import { validate } from './validate'

/** LAN 192.168.1.0/24, DHCP pool .100-.200, 機器1 at fixed .100 (no MAC recorded). */
const base = () => fixtureWithRound()
const seen = (oid: string, ip: string, mac: string | null, ports: number[] = [], extra = {}) => ({
  id: oid,
  type: 'device',
  source: 'nmap',
  segment: id('sit', 1),
  observedAt: NOW,
  value: {
    ip,
    mac,
    hostname: null,
    ports: ports.map((port) => ({ port, protocol: 'tcp', state: 'open' })),
    ...extra,
  },
})
const offer = (oid: string, server: string) => ({
  id: oid,
  type: 'dhcp',
  source: 'tshark',
  segment: id('sit', 1),
  observedAt: NOW,
  value: {
    server,
    ip: server,
    message: '2',
    offeredAddress: '192.168.1.150',
    gateway: '192.168.1.1',
    dns: ['192.168.1.2'],
    relay: null,
    mac: null,
    leaseSeconds: 3600,
  },
})
const observation = seen('observedPrinter', '192.168.1.42', '00:11:22:33:44:55', [9100])
const result = {
  format: 'tylan-collection',
  schemaVersion: 1,
  runId: 'run1',
  profile: { cidrs: ['192.168.1.0/24'], source: '192.168.1.99' },
  tools: {},
  startedAt: NOW,
  endedAt: NOW,
  scope: {},
  collectors: [],
  observations: [observation],
  findings: [],
}
const options = {
  siteId: id('sit', 1),
  roundId: id('rnd', 1),
  selected: ['host:00:11:22:33:44:55'],
  checkedBy: '調査者',
  now: NOW,
  packageHash: 'a'.repeat(64),
  storageLocation: '\\\\server\\evidence\\sealed',
}
const office = {
  ...result,
  observations: [
    observation, // printer outside the pool → unregistered
    seen('fixed', '192.168.1.100', 'aa:aa:aa:aa:aa:01'), // 機器1's fixed IP → known
    seen('pc', '192.168.1.120', '00:15:5d:00:00:01', [135, 445], { vendor: 'Dell' }),
    seen('pc2', '192.168.1.121', '00:15:5d:00:00:02', [135], { vendor: 'Dell' }),
    seen('phone', '192.168.1.150', '9e:da:7f:dc:ee:9f'), // random MAC → client
    seen('camera', '192.168.1.160', '00:40:8c:00:00:01', [554]), // in pool, RTSP → candidate
    seen('self', '192.168.1.99', '00:00:00:00:00:99'), // the audit PC itself is never listed
  ],
}
const classes = (rows: { ip: string; class: string }[]) => rows.map((r) => [r.ip, r.class])

test('hosts sort into managed, unregistered, candidate and anonymous clients', () => {
  const a = analyze(base(), office as never, id('sit', 1))
  expect(classes(a.hosts)).toEqual([
    ['192.168.1.42', 'unregistered'],
    ['192.168.1.100', 'known'],
    ['192.168.1.120', 'client'],
    ['192.168.1.121', 'client'],
    ['192.168.1.150', 'client'],
    ['192.168.1.160', 'candidate'],
  ])
  expect(a.clients).toEqual([
    {
      cidr: '192.168.1.0/24',
      total: 3,
      randomMac: 1,
      linkLocal: 0,
      vendors: [
        { name: 'Dell', count: 2 },
        { name: 'ランダムMAC', count: 1 },
      ],
    },
  ])
  expect(a.unseen).toEqual([])
  const quiet = analyze(base(), { ...office, observations: [] } as never, id('sit', 1))
  expect(quiet.unseen.map((d) => d.id)).toEqual([id('dev', 1)])
})

test('without a recorded DHCP pool nothing is called a fixed address', () => {
  const doc = base()
  doc.dhcpScopes = []
  const a = analyze(doc, office as never, id('sit', 1))
  expect(a.poolsKnown).toBe(false)
  expect(a.hosts.find((h) => h.ip === '192.168.1.42')?.class).toBe('candidate')
})

test('an unapproved DHCP server is rogue only once an approved one is recorded', () => {
  const run = {
    ...office,
    observations: [seen('r', '192.168.1.5', '00:aa:00:00:00:05'), offer('o', '192.168.1.5')],
  }
  expect(analyze(base(), run as never, id('sit', 1)).hosts[0]).toMatchObject({
    class: 'unregistered',
    why: 'DHCP範囲外の固定IPなのに台帳にない（DHCP配布元）',
  })
  const doc = base()
  doc.dhcpScopes[0]!.approval = 'approved'
  doc.dhcpScopes[0]!.serverAddress = '192.168.1.1'
  const a = analyze(doc, run as never, id('sit', 1))
  expect(a.hosts[0]).toMatchObject({ class: 'rogue', why: '承認されていないDHCP配布元' })
  expect(a.baseline.find((b) => b.field === 'dhcp')?.state).toBe('differs')
})

test('a fixed IP used by another MAC is flagged, not merged', () => {
  const doc = base()
  doc.ports[0]!.mac = 'aa:aa:aa:aa:aa:01'
  const run = { ...office, observations: [seen('x', '192.168.1.100', 'bb:bb:bb:bb:bb:01')] }
  const row = analyze(doc, run as never, id('sit', 1)).hosts[0]!
  expect(row.class).toBe('unregistered')
  expect(row.why).toMatch(/機器1/)
})

test('clients are stored as counts on the round and never become devices', async () => {
  const plan = await planImport(base(), office, {
    ...options,
    selected: ['host:9e:da:7f:dc:ee:9f', 'host:00:15:5d:00:00:01'],
  })
  expect(plan.doc.devices).toHaveLength(2)
  expect(plan.doc.auditRounds[0]!.clients).toEqual([
    expect.objectContaining({ segmentId: id('seg', 1), runId: 'run1', total: 3, randomMac: 1 }),
  ])
  expect(validate(plan.doc).errors).toEqual([])
  const again = await planImport(plan.doc, { ...office, runId: 'run2' }, options)
  expect(again.doc.auditRounds[0]!.clients.map((c) => c.runId)).toEqual(['run1', 'run2'])
})

test('a managed device is found again by MAC after DHCP moves it', async () => {
  const plan = await planImport(base(), office, {
    ...options,
    selected: ['host:00:40:8c:00:00:01', 'host:aa:aa:aa:aa:aa:01'],
    kinds: { 'host:00:40:8c:00:00:01': 'camera' },
  })
  const camera = plan.doc.devices.at(-1)!
  expect([camera.kind, camera.observation]).toEqual(['camera', 'observed'])
  expect(plan.doc.ipAssignments.at(-1)?.mode).toBe('dhcp')
  // the hand-registered device learned its MAC from its fixed IP
  expect(plan.doc.ports[0]?.mac).toBe('aa:aa:aa:aa:aa:01')
  const moved = {
    ...office,
    runId: 'run2',
    observations: [seen('c', '192.168.1.177', '00:40:8c:00:00:01', [554])],
  }
  const row = analyze(plan.doc, moved as never, id('sit', 1)).hosts[0]!
  expect([row.class, row.deviceId]).toEqual(['known', camera.id])
})

test('an unset baseline is adopted from what was observed and then compared', async () => {
  const doc = base()
  const run = { ...office, observations: [offer('o', '192.168.1.1')] }
  const first = analyze(doc, run as never, id('sit', 1))
  expect(first.baseline.map((b) => [b.field, b.state])).toEqual([
    ['gateway', 'unset'],
    ['dns', 'unset'],
    ['dhcp', 'unset'],
  ])
  expect(baselineFor(doc, id('sit', 1))).toEqual({
    approvedDhcp: null,
    expectedDns: null,
    expectedGateway: null,
  })
  const plan = await planImport(doc, run, {
    ...options,
    selected: first.baseline.map((b) => b.key),
  })
  expect(baselineFor(plan.doc, id('sit', 1))).toEqual({
    approvedDhcp: ['192.168.1.1'],
    expectedDns: ['192.168.1.2'],
    expectedGateway: ['192.168.1.1'],
  })
  const next = analyze(plan.doc, run as never, id('sit', 1))
  expect(next.baseline.map((b) => b.state)).toEqual(['match', 'match', 'match'])
})

test('imports need a round and verified evidence; unsafe results are refused', async () => {
  await expect(planImport(fixture(), result, options)).rejects.toThrow(/回次/)
  await expect(planImport(base(), result, { ...options, packageHash: '' })).rejects.toThrow()
  await expect(planImport(base(), { ...result, injected: true }, options)).rejects.toThrow()
})

test('repeated and overlapping imports use stable identities without duplicating assets', async () => {
  const first = await planImport(base(), office, options)
  expect(first.doc.devices).toHaveLength(3)
  expect(first.doc.devices.at(-1)?.approval).toBe('unknown')
  expect(first.doc.ipAssignments.at(-1)?.mode).toBe('static')
  for (let i = 0; i < 5; i++) {
    expect((await planImport(first.doc, office, options)).doc).toEqual(first.doc)
  }
  const both = { ...options, selected: [...options.selected, 'host:00:40:8c:00:00:01'] }
  const second = await planImport(first.doc, office, both)
  expect(second.doc.devices).toHaveLength(4)
  expect(second.doc.importBatches).toHaveLength(2)
  expect((await planImport(second.doc, office, both)).doc).toEqual(second.doc)
})

test('re-adopting after Undo keeps the reverted record and the same stable ids', async () => {
  const first = await planImport(base(), result, options)
  const undone = base()
  undone.importBatches = first.doc.importBatches.map((b) => ({ ...b, state: 'reverted' as const }))
  const again = await planImport(undone, result, options)
  expect(again.importId).not.toBe(first.importId)
  expect(again.doc.importBatches.map((b) => b.state)).toEqual(['reverted', 'applied'])
  expect(again.doc.devices.at(-1)!.id).toBe(first.doc.devices.at(-1)!.id)
})

test('the same importId with another run, selection or package is refused', async () => {
  const first = await planImport(base(), result, options)
  const tampered = structuredClone(first.doc)
  tampered.importBatches[0]!.selectionHash = 'f'.repeat(64)
  await expect(planImport(tampered, result, options)).rejects.toThrow(/取り込みID/)
})

test('the public projection never carries import records or the document identity', async () => {
  const plan = await planImport(base(), result, options)
  const publicDoc = toPublic(plan.doc, { siteIds: [id('sit', 1)], fields: { evidence: true } }, NOW)
  const text = JSON.stringify(publicDoc)
  expect(text).not.toContain(plan.importId)
  expect(text).not.toContain(plan.doc.documentId)
  expect(text).not.toContain('a'.repeat(64))
})

test('a first audit of a site with no segments makes one from the scanned CIDR', async () => {
  const empty = { ...base(), segments: [], ipAssignments: [], dhcpScopes: [] }
  empty.ports = empty.ports.map((p) => ({ ...p, segmentIds: [] }))
  const scan = {
    ...result,
    profile: { cidrs: ['192.168.4.0/24'] },
    observations: [seen('a', '192.168.4.11', '00:11:22:33:44:55', [9100])],
  }
  const plan = await planImport(empty, scan, options)
  expect(plan.doc.segments.map((s) => [s.name, s.cidr, s.siteId])).toEqual([
    ['192.168.4.0/24', '192.168.4.0/24', options.siteId],
  ])
  expect(plan.doc.ipAssignments.map((a) => a.segmentId)).toEqual([plan.doc.segments[0]!.id])
  expect(validate(plan.doc).errors).toEqual([])
  expect((await planImport(empty, scan, options)).doc).toEqual(plan.doc)
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
  await expect(planImport(base(), switchRun, noLinks)).rejects.toThrow(/対応付け/)
  const plan = await planImport(base(), switchRun, {
    ...options,
    selected: ['lldp1', 'mac1'],
    links: { lldp1: endpoints('', 'dev'), mac1: endpoints('', '') },
  })
  const added = plan.doc.links.slice(base().links.length)
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
    planImport(base(), switchRun, {
      ...options,
      selected: ['lldp1'],
      links: { lldp1: wrongPort },
    }),
  ).rejects.toThrow()
  const nothingKnown = { a: { unknown: 'SW-1' }, b: { unknown: 'AP-1' } }
  await expect(
    planImport(base(), switchRun, {
      ...options,
      selected: ['lldp1'],
      links: { lldp1: nothingKnown },
    }),
  ).rejects.toThrow()
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
  const kept = await planImport(base(), scopeRun, { ...options, selected: ['scope1'] })
  expect(kept.doc.dhcpScopes).toEqual(base().dhcpScopes)
  expect(kept.conflicts.join()).toMatch(/DHCP/)
  const empty = base()
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
    'approved',
  ])
  expect(scope.serverAddress).toBe('192.168.1.3')
  expect(scope.serverUnknown).toMatch(/192\.168\.1\.3/)
})
