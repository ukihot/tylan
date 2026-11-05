import { describe, expect, test } from 'vitest'
import { AUDIT_MASTER, auditBadge, auditSummary } from './audit-master'
import { applyChange, removeEntity, startRound } from './commands'
import { toCsv } from './csv'
import { toGraph } from './graph'
import { parseDocument, prepareExport } from './io'
import { autoLayout } from './layout'
import { createViewer, readPublicData, toPublic } from './publish'
import { emptyDoc, entitySchemas } from './schema'
import { fixture, id, NOW } from './test-fixture'
import { findReferences, validate } from './validate'

describe('信頼境界・整合性', () => {
  test('空の正本と全種類のサンプルを受け付ける', () => {
    expect(validate(emptyDoc(NOW, id('prj', 1))).errors).toEqual([])
    expect(validate(fixture()).errors).toEqual([])
    expect(Object.keys(entitySchemas)).toHaveLength(14)
  })
  test('未知キー、将来版、非有限座標、誤ったIDを拒否する', () => {
    const doc = fixture()
    expect(validate({ ...doc, password: 'secret' }).errors.length).toBeGreaterThan(0)
    expect(validate({ ...doc, schemaVersion: 99 }).errors.length).toBeGreaterThan(0)
    doc.layouts[0]!.positions[id('dev', 1)] = { x: Infinity, y: 0, pinned: false }
    expect(validate(doc).errors.length).toBeGreaterThan(0)
    doc.devices[0]!.id = id('prt', 1)
    expect(validate(doc).errors.length).toBeGreaterThan(0)
  })
  test('参照切れ・ポート所属違い・物理ポート二重利用を拒否する', () => {
    const doc = fixture()
    doc.ports[0]!.deviceId = id('dev', 999)
    expect(validate(doc).errors.some((i) => i.code === 'reference')).toBe(true)
    const next = fixture()
    next.links.push({ ...next.links[0]!, id: id('lnk', 99), b: { unknown: '行先未確認' } })
    expect(validate(next).errors.some((i) => i.code === 'port-used')).toBe(true)
  })
  test('別ポートを使う冗長リンク・ループを許可する', () => {
    const doc = fixture()
    doc.ports.push({ ...doc.ports[0]!, id: id('prt', 3) }, { ...doc.ports[1]!, id: id('prt', 4) })
    doc.links.push({
      ...doc.links[0]!,
      id: id('lnk', 2),
      a: { deviceId: id('dev', 2), portId: id('prt', 4) },
      b: { deviceId: id('dev', 1), portId: id('prt', 3) },
    })
    expect(validate(doc).errors).toEqual([])
  })
  test('同じセグメントのIP重複とDHCP重なりは保存可能な警告', () => {
    const doc = fixture()
    doc.ipAssignments.push({ ...doc.ipAssignments[0]!, id: id('ip', 2), portId: id('prt', 2) })
    const result = validate(doc)
    expect(result.errors).toEqual([])
    expect(result.warnings.some((i) => i.code === 'duplicate-ip')).toBe(true)
    expect(result.warnings.some((i) => i.code === 'dhcp-overlap')).toBe(true)
    doc.segments.push({ ...doc.segments[0]!, id: id('seg', 2) })
    doc.ipAssignments[1]!.segmentId = id('seg', 2)
    expect(validate(doc).warnings.some((i) => i.code === 'duplicate-ip')).toBe(false)
  })
  test('DHCP範囲逆転はエラー、セグメント外は警告', () => {
    const doc = fixture()
    doc.dhcpScopes[0]!.ranges = [{ start: '192.168.1.200', end: '192.168.1.100' }]
    expect(validate(doc).errors.some((i) => i.code === 'range-order')).toBe(true)
    doc.dhcpScopes[0]!.ranges = [{ start: '192.168.2.100', end: '192.168.2.200' }]
    expect(validate(doc).errors).toEqual([])
    expect(validate(doc).warnings.some((i) => i.code === 'outside-segment')).toBe(true)
  })
})

describe('FCISの更新と監査', () => {
  test('不正な変更は原本に影響せず、変更成功時も原本は不変', () => {
    const doc = fixture()
    const before = structuredClone(doc)
    expect(
      applyChange(doc, (d) => {
        d.ports[0]!.deviceId = id('dev', 999)
      }).ok,
    ).toBe(false)
    expect(doc).toEqual(before)
    const result = applyChange(doc, (d) => {
      d.devices[0]!.name = '変更後'
    })
    expect(result.ok).toBe(true)
    expect(doc).toEqual(before)
  })
  test('参照元を表示して削除を止め、未参照の配下ポートだけ同時削除', () => {
    const doc = fixture()
    expect(findReferences(doc, id('dev', 1)).length).toBeGreaterThan(0)
    expect(removeEntity(doc, 'devices', id('dev', 1)).ok).toBe(false)
    doc.links = []
    doc.ipAssignments = []
    doc.dhcpScopes = []
    doc.layouts = []
    const result = removeEntity(doc, 'devices', id('dev', 1))
    expect(result.ok && result.doc.ports.some((p) => p.deviceId === id('dev', 1))).toBe(false)
  })
  test('20項目の元番号を維持し、新回次は未確認で開始する', () => {
    expect(AUDIT_MASTER.map((i) => i.no)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
    ])
    const result = startRound(
      fixture(),
      {
        id: id('rnd', 1),
        name: '2026年度',
        siteIds: [id('sit', 1)],
        startDate: '2026-11-05',
        endDate: null,
        surveyor: null,
      },
      Array.from({ length: 20 }, (_, i) => id('aud', i + 1)),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.doc.auditResults).toHaveLength(20)
    expect(result.doc.auditResults.every((r) => r.judgment === 'unchecked')).toBe(true)
    expect(auditSummary(result.doc.auditResults).unchecked).toBe(20)
  })
  test('必須欄・個別結果と総括の矛盾を検証し、バッジの優先度を守る', () => {
    const doc = fixture()
    const result = startRound(
      doc,
      {
        id: id('rnd', 1),
        name: '初回',
        siteIds: [id('sit', 1)],
        startDate: '2026-11-05',
        endDate: null,
        surveyor: null,
      },
      Array.from({ length: 20 }, (_, i) => id('aud', i + 1)),
    )
    if (!result.ok) {
      throw new Error('fixture')
    }
    const d = result.doc
    const summary = d.auditResults[0]!
    summary.judgment = 'ok'
    expect(validate(d).errors.length).toBeGreaterThan(0)
    Object.assign(summary, { finding: '現物確認', checkedBy: '担当者', checkedDate: '2026-11-05' })
    d.auditResults.push({
      ...summary,
      id: id('aud', 99),
      scope: 'target',
      targetRef: { type: 'device', id: id('dev', 1) },
      judgment: 'unchecked',
    })
    expect(validate(d).errors.some((i) => i.code === 'audit-conflict')).toBe(true)
    expect(auditBadge(d.auditResults).judgment).toBe('unchecked')
    expect(auditBadge([]).judgment).toBe('none')
  })
})

describe('入出力と公開', () => {
  test('JSON往復で全情報を維持し、版は一度だけ進める', () => {
    const doc = fixture()
    const out = prepareExport(doc, NOW, '担当者')
    const parsed = parseDocument(out.text)
    expect(parsed.project.revision).toBe(doc.project.revision + 1)
    expect(parsed.devices).toEqual(doc.devices)
    expect(parsed.layouts).toEqual(doc.layouts)
    expect(out.filename).toMatch(/^network-r0001-20261105-143000.json$/)
    expect(doc.project.revision).toBe(0)
    expect(() => parseDocument('{')).toThrow()
    expect(() => parseDocument(JSON.stringify({ ...doc, schemaVersion: 99 }))).toThrow(/対応/)
    expect(() => parseDocument(' ', 10 * 1024 * 1024 + 1)).toThrow(/10MiB/)
  })
  test('CSVの式・引用符・改行を安全に扱う', () => {
    expect(
      toCsv([
        ['名称', '備考'],
        ['=1+1', '"引用"\n次行'],
        ['\t=2', '@SUM(A1)'],
      ]),
    ).toBe('\ufeff"名称","備考"\r\n"\'=1+1","""引用""\n次行"\r\n"\'\t=2","\'@SUM(A1)"\r\n')
  })
  test('公開は許可リストから作り、除外した拠点や機密項目を残さない', () => {
    const doc = fixture()
    doc.devices[0]!.serial = 'SECRET-SERIAL'
    doc.devices.push({
      ...doc.devices[0]!,
      id: id('dev', 3),
      siteId: id('sit', 2),
      name: 'SECRET-SITE',
    })
    doc.sites.push({ ...doc.sites[0]!, id: id('sit', 2), name: '非公開拠点' })
    doc.devices[2]!.locationId = null
    const pub = toPublic(doc, { siteIds: [id('sit', 1)], fields: {} }, NOW)
    expect(JSON.stringify(pub)).not.toContain('SECRET')
    expect(pub.devices).toHaveLength(2)
    expect(pub.devices[0]).not.toHaveProperty('serial')
    expect(pub).not.toHaveProperty('evidence')
  })
  test('script終端・置換メタ文字を含んでも安全に復元できる', () => {
    const doc = fixture()
    doc.devices[0]!.name = '</script><script>alert(1)</script>$&\u2028'
    const pub = toPublic(doc, { siteIds: [id('sit', 1)], fields: {} }, NOW)
    const template =
      '<html><script type="application/json" id="tylan-data">/*TYLAN_DATA*/</script></html>'
    const html = createViewer(template, pub)
    expect(html).not.toContain('<script>alert')
    expect(readPublicData(html)).toEqual(pub)
    expect(() => createViewer(`${template}/*TYLAN_DATA*/`, pub)).toThrow()
  })
})

describe('構成図', () => {
  test('不明端点を資産にせず、未確認接続を破線・?で表示する', () => {
    const doc = fixture()
    doc.links[0]!.b = { unknown: '天井裏' }
    doc.links[0]!.certainty = 'estimated'
    const graph = toGraph(doc, id('sit', 1))
    expect(graph.nodes.some((n) => n.id === `unknown:${id('lnk', 1)}:b`)).toBe(true)
    expect(graph.edges[0]!.label).toContain('?')
    expect(graph.edges[0]!.style).toContain('stroke-dasharray')
    expect(doc.devices).toHaveLength(2)
  })
  test('レイアウトは決定的で、固定位置を守り、原本を変更しない', () => {
    const doc = fixture()
    const before = structuredClone(doc)
    doc.layouts[0]!.positions[id('dev', 1)] = { x: 987, y: 654, pinned: true }
    const positions = autoLayout(doc, id('sit', 1), doc.layouts[0]!)
    expect(positions[id('dev', 1)]).toEqual({ x: 987, y: 654, pinned: true })
    expect(positions).toEqual(autoLayout(doc, id('sit', 1), doc.layouts[0]!))
    expect(doc.devices).toEqual(before.devices)
  })
})
