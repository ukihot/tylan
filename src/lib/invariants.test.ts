import { expect, test } from 'vitest'
import { inCidr, ipNumber } from './address'
import { removeEntity, startRound, upsert } from './commands'
import { toCsv } from './csv'
import { toGraph } from './graph'
import { PublicDocSchema, toPublic } from './publish'
import { sampleDoc } from './sample'
import { newEntity } from './schema'
import { fixture, id, NOW } from './test-fixture'
import { validate } from './validate'

test('存在しないIDの削除で末尾の実在レコードを削除しない', () => {
  const doc = fixture()
  doc.evidence = [1, 2].map((n) => ({
    ...newEntity('evidence', id('evd', n)),
    description: `証跡${n}`,
  }))
  const result = removeEntity(doc, 'evidence', id('evd', 999))
  expect(result.ok).toBe(false)
  expect(doc.evidence).toHaveLength(2)
})
test.each(['2026-02-30T14:30:00+09:00', '2026-11-05T14:30:00Z', 'November 5, 2026 14:30:00+09:00'])(
  '非ISO・不正日・日本時間以外の日時を拒否：%s',
  (timestamp) => {
    const doc = fixture()
    doc.project.createdAt = timestamp
    expect(validate(doc).errors.length).toBeGreaterThan(0)
  },
)
test('IPv6の表記違いを同一IPとして検知し、異常なIPv6を拒否する', () => {
  expect(ipNumber('2001:db8::1')).toEqual(ipNumber('2001:0db8:0:0:0:0:0:1'))
  expect(inCidr('::ffff:192.0.2.1', '::ffff:0:0/96')).toBe(true)
  expect(ipNumber('1::2::3')).toBeNull()
  const doc = fixture()
  doc.segments[0]!.cidr = '2001:db8::/64'
  doc.ipAssignments[0]!.address = '2001:db8::1'
  doc.ipAssignments.push({ ...doc.ipAssignments[0]!, id: id('ip', 2), address: '2001:0db8::1' })
  expect(validate(doc).warnings.some((i) => i.code === 'duplicate-ip')).toBe(true)
})
test('対象機器を持たない接続は拠点へ帰属できないため拒否する', () => {
  const doc = fixture()
  doc.links[0]!.a = { unknown: '不明A' }
  doc.links[0]!.b = { unknown: '不明B' }
  expect(validate(doc).errors.some((i) => i.code === 'link-site')).toBe(true)
})
test('対応事項の作成で監査との相互参照を更新し、完了しても判定を変えない', () => {
  const round = { ...newEntity('auditRounds', id('rnd', 1)), name: '初回', siteIds: [id('sit', 1)] }
  const created = startRound(
    fixture(),
    round,
    Array.from({ length: 20 }, (_, i) => id('aud', i + 1)),
  )
  if (!created.ok) {
    throw new Error('fixture')
  }
  const audit = created.doc.auditResults[0]!
  const action = {
    ...newEntity('actionItems', id('act', 1)),
    content: '配線を確認',
    auditResultIds: [audit.id],
  }
  const linked = upsert(created.doc, 'actionItems', action)
  expect(linked.ok).toBe(true)
  if (!linked.ok) {
    return
  }
  expect(linked.doc.auditResults[0]!.actionItemIds).toEqual([action.id])
  const done = upsert(linked.doc, 'actionItems', {
    ...action,
    progress: 'done',
    completionRecord: '再配線を実施',
  })
  expect(done.ok && done.doc.auditResults[0]!.judgment).toBe('unchecked')
})
test('拠点の親グループが設置場所グループ全体を包含する', () => {
  const graph = toGraph(fixture(), id('sit', 1))
  const site = graph.nodes.find((n) => n.id === `group:${id('sit', 1)}`)!
  const location = graph.nodes.find((n) => n.id === `group:${id('loc', 1)}`)!
  expect(site.width).toBeGreaterThanOrEqual(location.position.x + location.width!)
  expect(site.height).toBeGreaterThanOrEqual(location.position.y + location.height!)
})
test('公開スキーマも参照切れや未知フィールドを拒否する', () => {
  const pub = toPublic(fixture(), { siteIds: [id('sit', 1)], fields: {} }, NOW)
  expect(PublicDocSchema.safeParse({ ...pub, secrets: 'hidden' }).success).toBe(false)
  pub.ports[0]!.deviceId = id('dev', 999)
  expect(PublicDocSchema.safeParse(pub).success).toBe(false)
})
test('空白の後から始まるCSV式も無害化する', () => {
  expect(toCsv([['  =1+1']])).toBe('\ufeff"\'  =1+1"\r\n')
})

test('全エンティティを含む受入サンプルを警告付きで保存・公開できる', () => {
  const doc = sampleDoc()
  const validation = validate(doc)
  expect(validation.errors).toEqual([])
  expect(validation.warnings.length).toBeGreaterThan(0)
  const graph = toGraph(doc, doc.sites[0]!.id, {
    observation: 'unknown',
    wirelessId: doc.wirelessNetworks[0]!.id,
  })
  expect(graph.matchedIds).toEqual([])
  const pub = toPublic(doc, doc.publishSettings, NOW)
  expect(pub.auditResults).toHaveLength(21)
  expect(pub.devices).toHaveLength(8)
})
