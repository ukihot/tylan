import { type Collection, prefixes } from './schema'
export const screenCollections = {
  project: ['sites', 'locations'],
  devices: ['devices'],
  ports: ['ports', 'links'],
  network: ['segments', 'ipAssignments', 'dhcpScopes', 'wirelessNetworks'],
  audit: ['auditRounds', 'auditResults', 'evidence'],
  actions: ['actionItems'],
} as const
export const screens = [
  ['project', '開始・プロジェクト'],
  ['topology', 'トポロジー'],
  ['devices', '機器・資産台帳'],
  ['ports', 'ポート・接続'],
  ['network', 'ネットワーク設定'],
  ['audit', '監査'],
  ['actions', '対応事項'],
  ['export', '検証・書き出し'],
] as const
export function entityHref(id: string | null, path = '') {
  const collection =
    (Object.keys(prefixes) as Collection[]).find((k) => id?.startsWith(`${prefixes[k]}_`)) ??
    path.split('.')[0]
  if (collection === 'layouts') {
    return '#/topology'
  }
  for (const [screen, collections] of Object.entries(screenCollections)) {
    if ((collections as readonly string[]).includes(collection ?? '')) {
      return `#/${screen}/${collection}/${id ?? ''}`
    }
  }
  return '#/export'
}
