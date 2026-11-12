import { type Collection, prefixes } from './schema'
/** One audit, five steps in the order the work happens. The baseline ledger lives inside step 2. */
export const steps = [
  ['run', '実行', '現地LANを調べる'],
  ['diff', '差分・基準', '基準との差を確認して取り込む'],
  ['judge', '判定', '20項目を判定する'],
  ['actions', '対応', '要対応を追跡する'],
  ['publish', '公開', '閲覧用HTML・CSVを出す'],
] as const
export type Step = (typeof steps)[number][0]
/** The baseline: what the network should look like. Edited only here, read by every run. */
export const ledgerGroups = [
  ['管理機器', ['devices', 'ports', 'ipAssignments']],
  ['ネットワーク', ['segments', 'dhcpScopes', 'wirelessNetworks']],
  ['配線', ['links']],
  ['拠点・設置場所', ['sites', 'locations']],
  ['構成図', ['layouts']],
] as const satisfies readonly (readonly [string, readonly Collection[]])[]
export const stepCollections: Partial<Record<Step, readonly Collection[]>> = {
  diff: ledgerGroups.flatMap(([, c]) => c),
  judge: ['auditResults', 'auditRounds', 'evidence'],
  actions: ['actionItems'],
}
export function entityHref(id: string | null, path = '') {
  const collection =
    (Object.keys(prefixes) as Collection[]).find((k) => id?.startsWith(`${prefixes[k]}_`)) ??
    path.split('.')[0]
  for (const [step, collections] of Object.entries(stepCollections)) {
    if ((collections as readonly string[]).includes(collection ?? '')) {
      return `#/${step}/${collection}/${collection === 'layouts' ? '' : (id ?? '')}`
    }
  }
  return '#/publish'
}
