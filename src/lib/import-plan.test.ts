import { expect, test } from 'vitest'
import { migrateV2, planImport } from './import-plan'
import { parseDocument } from './io'
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
