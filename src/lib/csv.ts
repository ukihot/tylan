import { judgmentLabels } from './audit-master'
import type { Doc } from './schema'
import { validate } from './validate'
export function toCsv(rows: unknown[][]) {
  return (
    '\ufeff' +
    rows
      .map((row) =>
        row
          .map((value) => {
            let s = value == null ? '' : String(value)
            if (/^(?:\s*[=+\-@]|[\t\r\n])/.test(s)) {
              s = `'${s}`
            }
            return `"${s.replace(/"/g, '""')}"`
          })
          .join(','),
      )
      .join('\r\n') +
    '\r\n'
  )
}
export function documentCsv(doc: Doc, kind: 'assets' | 'ports' | 'audit' | 'actions') {
  if (validate(doc).errors.length) {
    throw new Error('検証エラーを修正してください')
  }
  const deviceName = (id: string) => doc.devices.find((d) => d.id === id)?.name ?? id
  const siteName = (id: string) => doc.sites.find((d) => d.id === id)?.name ?? id
  if (kind === 'assets') {
    return toCsv([
      [
        'ID',
        '資産番号',
        '名称',
        '種別',
        'メーカー',
        '型番',
        'シリアル',
        '拠点',
        '設置場所',
        'IP',
        '所有者',
        '管理担当',
        '保守窓口',
        '承認状態',
        '使用状態',
        '確認状況',
        '備考',
      ],
      ...doc.devices.map((d) => [
        d.id,
        d.assetNumber,
        d.name,
        d.kind,
        d.manufacturer,
        d.model,
        d.serial,
        siteName(d.siteId),
        doc.locations.find((l) => l.id === d.locationId)?.name,
        doc.ipAssignments
          .filter((a) => doc.ports.some((p) => p.id === a.portId && p.deviceId === d.id))
          .map((a) => a.address)
          .join(' / '),
        d.owner,
        d.administrator,
        d.supportContact,
        d.approval,
        d.usage,
        d.observation,
        d.notes,
      ]),
    ])
  }
  if (kind === 'ports') {
    return toCsv([
      ['ID', '機器', 'ポート', '媒体', '速度Mbps', '状態', '用途', 'MAC', 'VLAN', '観測日時'],
      ...doc.ports.map((p) => [
        p.id,
        deviceName(p.deviceId),
        p.name,
        p.medium,
        p.speedMbps,
        p.status,
        p.purpose,
        p.mac,
        p.segmentIds.map((id) => doc.segments.find((s) => s.id === id)?.vlanId).join(' / '),
        p.observedAt,
      ]),
    ])
  }
  if (kind === 'actions') {
    return toCsv([
      ['ID', '内容', '優先度', '担当者', '期限', '進捗', '関連監査', '完了記録', '再確認記録'],
      ...doc.actionItems.map((a) => [
        a.id,
        a.content,
        a.priority,
        a.assignee ?? '未定',
        a.dueDate ?? '未定',
        a.progress,
        a.auditResultIds.join(' / '),
        a.completionRecord,
        a.recheckRecord,
      ]),
    ])
  }
  return toCsv([
    [
      'No.',
      '分類',
      '調査項目',
      '確認内容',
      '確認方法',
      '判定',
      '確認結果・現状',
      '問題点・対応事項',
      '拠点',
      '対象',
      '回次',
      '確認者',
      '確認日',
      '証跡',
      '理由',
      '次の確認方法',
      '再確認予定',
    ],
    ...doc.auditResults.map((r) => {
      const item = doc.auditTemplate.items.find((i) => i.no === r.itemNo)!
      return [
        r.itemNo,
        item.category,
        item.title,
        item.content,
        r.method ?? item.method,
        judgmentLabels[r.judgment],
        r.finding,
        [
          r.problem,
          ...r.actionItemIds.map((id) => doc.actionItems.find((a) => a.id === id)?.content),
        ]
          .filter(Boolean)
          .join(' / '),
        siteName(r.siteId),
        r.scope === 'summary' ? '拠点総括' : r.targetRef?.id,
        doc.auditRounds.find((a) => a.id === r.roundId)?.name,
        r.checkedBy,
        r.checkedDate,
        r.evidenceIds
          .map((id) => {
            const e = doc.evidence.find((e) => e.id === id)!
            return [e.description, e.referenceNumber, e.storageLocation].filter(Boolean).join('：')
          })
          .join(' / '),
        r.reason,
        r.nextCheck,
        r.recheckDate,
      ]
    }),
  ])
}
