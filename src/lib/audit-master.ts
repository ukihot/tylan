import type { EntityMap } from './schema'

const rows = [
  [
    1,
    '機器・設置',
    'サービスアダプタ',
    'IIJサービスアダプタの設置場所、型番、シリアル番号、ランプ状態を確認',
    '現物・ラベルを確認',
  ],
  [
    2,
    '機器・設置',
    'スイッチ',
    'L2スイッチのメーカー、型番、台数、設置場所、管理可否を確認',
    '現物・管理画面を確認',
  ],
  [3, '機器・設置', '無線AP', '無線AP・中継器の台数、型番、設置場所を確認', '現物と設置場所を確認'],
  [
    4,
    '機器・設置',
    '非承認機器',
    '私物ルーター、ハブ、無断AP、テザリング機器の常設がないか',
    '現場担当者へ聞き取り・目視',
  ],
  [
    5,
    '機器・設置',
    '旧設備',
    '旧NEC機器・旧AP・使われないハブなどの接続、残置を確認',
    '現物・接続を確認',
  ],
  [6, '機器・設置', '機器管理', '設置機器の所有者、管理担当者、保守窓口を確認', '担当者へ聞き取り'],
  [
    7,
    '配線・物理構成',
    '接続構成',
    'サービスアダプタ→スイッチ→AP・端末等の接続関係を記録',
    'ケーブルを追跡し構成図を起こす',
  ],
  [
    8,
    '配線・物理構成',
    'ポート',
    'スイッチの使用ポート、空きポート、用途不明ポートを確認',
    'ポート番号と接続先を記録',
  ],
  [
    12,
    'IP・DHCP・DNS',
    'アドレス設計',
    '拠点LANのIPアドレス帯、サブネット、デフォルトGWを把握',
    '管理設定・代表端末で確認',
  ],
  [
    13,
    'IP・DHCP・DNS',
    'DHCP',
    'DHCPの配布元、配布範囲、除外範囲、リース設定を確認',
    'ルーター設定・代表端末で確認',
  ],
  [
    14,
    'IP・DHCP・DNS',
    '不審なDHCP',
    '管理外のDHCPサーバ、二重配布の兆候がないか',
    '管理画面・現場聞き取りで確認',
  ],
  [
    15,
    'IP・DHCP・DNS',
    '固定IP',
    'プリンタ・NAS等の固定IP一覧と実機の設定を突き合わせる',
    '機器設定と台帳を確認',
  ],
  [
    16,
    'IP・DHCP・DNS',
    'IP異常',
    'IP重複、169.254.x.x、用途不明IPの発生がないか',
    '現場聞き取り・代表端末を確認',
  ],
  [
    17,
    'IP・DHCP・DNS',
    'DNS',
    '端末が想定する社内AD/DNSを使用しているか',
    '代表端末・DHCP設定を確認',
  ],
  [
    18,
    '無線LAN',
    'SSID',
    '業務用・ゲスト用・用途不明SSIDの有無と利用目的を確認',
    'AP設定・現地確認',
  ],
  [
    19,
    '無線LAN',
    '認証・暗号化',
    'WPA2-AES/WPA3等の方式、共通パスワードの管理を確認',
    'AP管理画面で確認（秘密そのものは記録しない）',
  ],
  [
    20,
    '無線LAN',
    '接続分離',
    'ゲストWi-Fiから社内LANへのアクセス制限を確認',
    '設定・許可範囲を確認',
  ],
  [
    21,
    '無線LAN',
    '電波状況',
    '接続しづらい場所、APの過密・死角、電波不安定箇所を確認',
    '現場で実測・利用者聞き取り',
  ],
  [
    22,
    '接続機器・資産',
    '接続機器一覧',
    'PC、プリンタ、NAS、カメラ、勤怠機器、IoT機器を把握',
    '現物・DHCP一覧・台帳を照合',
  ],
  [
    23,
    '接続機器・資産',
    '未使用機器',
    '長期間未使用の端末、ネットワーク接続したままの不要機器がないか',
    '現物・担当者へ聞き取り',
  ],
] as const
export const AUDIT_MASTER = rows.map(([no, category, title, content, method]) => ({
  no,
  category,
  title,
  content,
  method,
}))
export const judgmentLabels = {
  unchecked: '未確認',
  ok: '問題なし',
  ng: '要対応',
  na: '対象外',
  none: '監査記録なし',
}
export function auditBadge(results: Pick<EntityMap['auditResults'], 'judgment'>[]) {
  const judgment =
    (['ng', 'unchecked', 'ok', 'na'] as const).find((j) => results.some((r) => r.judgment === j)) ??
    'none'
  return { judgment, label: judgmentLabels[judgment], count: results.length }
}
export function auditSummary(results: EntityMap['auditResults'][]) {
  const summary = results.filter((r) => r.scope === 'summary')
  return {
    total: summary.length,
    targets: results.length - summary.length,
    ...Object.fromEntries(
      (['unchecked', 'ok', 'ng', 'na'] as const).map((j) => [
        j,
        summary.filter((r) => r.judgment === j).length,
      ]),
    ),
  } as { total: number; targets: number; unchecked: number; ok: number; ng: number; na: number }
}
