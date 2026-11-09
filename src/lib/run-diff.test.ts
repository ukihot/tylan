import { expect, test } from 'vitest'
import type { CollectionResult } from './collection-schema'
import { compareRuns } from './run-diff'
import { NOW } from './test-fixture'

const device = (id: string, ip: string, mac: string | null, open: number[] = []) => ({
  id,
  type: 'device' as const,
  source: 'nmap',
  segment: 'site',
  observedAt: NOW,
  value: {
    ip,
    mac,
    ports: open.map((port) => ({ protocol: 'tcp', port, state: 'open', reason: 'syn-ack' })),
  },
})
const run = (
  profile: Record<string, unknown>,
  observations: ReturnType<typeof device>[],
  tools = {},
): CollectionResult => ({
  format: 'tylan-collection',
  schemaVersion: 1,
  runId: 'r',
  profile,
  tools,
  scope: {},
  startedAt: NOW,
  endedAt: NOW,
  collectors: [],
  observations,
  findings: [],
})

test('the diff lists added, changed and not-observed devices and never calls them removed', () => {
  const previous = run({ mode: 'standard', ports: [22] }, [
    device('a', '192.168.1.10', 'aa:aa:aa:aa:aa:aa', [22]),
    device('b', '192.168.1.11', 'bb:bb:bb:bb:bb:bb'),
    device('c', '192.168.1.12', null),
  ])
  const current = run({ mode: 'standard', ports: [22, 80] }, [
    device('a2', '192.168.1.10', 'aa:aa:aa:aa:aa:aa', [22, 80]),
    device('d', '192.168.1.13', 'dd:dd:dd:dd:dd:dd'),
    device('c2', '192.168.1.12', null),
  ])
  const diff = compareRuns(previous, current)
  expect(diff.added.map((d) => d.ip)).toEqual(['192.168.1.13'])
  expect(diff.changed).toEqual([
    {
      key: 'aa:aa:aa:aa:aa:aa',
      ip: '192.168.1.10',
      fields: ['開放ポート'],
      before: 'tcp/22',
      after: 'tcp/22, tcp/80',
    },
  ])
  expect(diff.unobserved.map((d) => d.ip)).toEqual(['192.168.1.11'])
  expect(diff.conditions).toEqual(['ports'])
})

test('an address move of the same MAC is a change, and tool versions are compared too', () => {
  const previous = run({}, [device('a', '192.168.1.10', 'aa:aa:aa:aa:aa:aa')], { nmap: '7.94' })
  const current = run({}, [device('a', '192.168.1.20', 'AA:AA:AA:AA:AA:AA')], { nmap: '7.95' })
  const diff = compareRuns(previous, current)
  expect(diff.changed[0]?.fields).toEqual(['IP'])
  expect(diff.added).toEqual([])
  expect(diff.unobserved).toEqual([])
  expect(diff.conditions).toEqual(['tools'])
})
