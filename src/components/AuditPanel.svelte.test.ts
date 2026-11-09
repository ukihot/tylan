import { expect, test } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { createFileSession } from '../lib/file-session.svelte'
import { createWorkspace } from '../lib/store.svelte'
import { fixture, memoryFolder, NOW } from '../lib/test-fixture'
import AuditPanel from './AuditPanel.svelte'

test('IPv4 audit and IPv6 local-only controls are explicit and no scan starts on render', async () => {
  const memory = memoryFolder()
  const calls: string[] = []
  memory.folder.audit = async (method, path) => {
    calls.push(`${method} ${path}`)
    return []
  }
  const workspace = createWorkspace(fixture())
  const files = createFileSession(workspace, memory.folder)
  await memory.folder.write('working/network.json', JSON.stringify(fixture()), 'new')
  await files.open('network.json')
  const screen = await render(AuditPanel, { workspace, files, folder: memory.folder })
  await expect
    .element(
      screen.getByRole('checkbox', { name: 'IPv6ローカル設定確認（送信なし）', exact: true }),
    )
    .toBeChecked()
  await expect
    .element(screen.getByRole('checkbox', { name: 'IPv4機器探索', exact: true }))
    .toBeChecked()
  await expect
    .element(screen.getByText('IPv6キャプチャ・能動探索は初期版では未対応です。', { exact: true }))
    .toBeVisible()
  expect(calls).not.toContain('POST audit/runs')
})

type Routes = Record<string, unknown>
async function mount(routes: Routes) {
  const memory = memoryFolder()
  const calls: { method: string; path: string; body: unknown }[] = []
  memory.folder.audit = async (method, path, body) => {
    calls.push({ method, path, body })
    const hit = routes[`${method} ${path}`]
    if (typeof hit === 'function') {
      return hit(body)
    }
    return hit === undefined ? [] : structuredClone(hit)
  }
  const workspace = createWorkspace(fixture())
  const files = createFileSession(workspace, memory.folder)
  await memory.folder.write('working/network.json', JSON.stringify(fixture()), 'new')
  await files.open('network.json')
  const screen = await render(AuditPanel, { workspace, files, folder: memory.folder })
  return { screen, calls, files, workspace }
}
const inventory = {
  adapters: [
    {
      ifIndex: 4,
      guid: '{4D36E972-E325-11CE-BFC1-08002BE10318}',
      name: 'Ethernet',
      description: 'NIC',
      mac: '00:11:22:33:44:55',
      status: 'Up',
      hardware: true,
    },
  ],
  addresses: [
    { ifIndex: 4, address: '192.168.1.20', prefixLength: 24, family: 'IPv4', state: 'Preferred' },
  ],
  routes: [],
  ipv6: { state: 'failed', reason: 'access denied' },
}
const diagnosis = {
  'POST audit/diagnose': { requestId: 'd1' },
  'GET audit/responses?id=d1': { accepted: true, inventory },
}
async function chooseNic(screen: Awaited<ReturnType<typeof render>>) {
  await screen.getByRole('button', { name: 'ホスト設定を取得' }).click()
  await screen.getByRole('combobox', { name: /送信元NIC/ }).selectOptions('4:192.168.1.20')
}

test('host diagnosis carries the IPv6 switch and shows an IPv6 read failure as unchecked', async () => {
  const { screen, calls } = await mount(diagnosis)
  await screen
    .getByRole('checkbox', { name: 'IPv6ローカル設定確認（送信なし）', exact: true })
    .click()
  await screen.getByRole('button', { name: 'ホスト設定を取得' }).click()
  await expect.element(screen.getByText(/IPv6設定未確認：access denied/)).toBeVisible()
  expect(calls.find((c) => c.path === 'audit/diagnose')?.body).toEqual({ includeIPv6: false })
})

test('a refused start ends the run display and re-enables the form instead of polling on', async () => {
  const { screen, calls } = await mount({
    ...diagnosis,
    'POST audit/runs': { runId: 'run1', requestId: 'r1' },
    'GET audit/runs/run1': {
      response: { accepted: false, error: 'another run is active' },
      state: null,
    },
  })
  await chooseNic(screen)
  await screen.getByRole('button', { name: '現地監査を開始' }).click()
  await expect.element(screen.getByRole('alert')).toHaveTextContent('another run is active')
  await expect.element(screen.getByText(/受付拒否/)).toBeVisible()
  await expect.element(screen.getByRole('button', { name: '監査を中止' })).toBeDisabled()
  await expect.element(screen.getByRole('button', { name: '現地監査を開始' })).toBeEnabled()
  const polls = calls.filter((c) => c.path === 'audit/runs/run1').length
  await new Promise((resolve) => setTimeout(resolve, 1500))
  expect(calls.filter((c) => c.path === 'audit/runs/run1').length).toBe(polls)
})

const observed = (id: string, type: string, value: Record<string, unknown>) => ({
  id,
  type,
  source: 'synthetic',
  segment: 'site',
  observedAt: NOW,
  value,
})
const collection = (runId: string, observations: unknown[], collectors: unknown[] = []) => ({
  format: 'tylan-collection',
  schemaVersion: 1,
  runId,
  profile: { mode: 'standard' },
  tools: {},
  scope: { observationPoint: 'host' },
  startedAt: NOW,
  endedAt: NOW,
  collectors,
  observations,
  findings: [],
})
const printer = observed('printer', 'device', {
  ip: '192.168.1.42',
  mac: '00:11:22:33:44:55',
  ports: [],
})
const lldp = observed('lldp1', 'physicalCandidate', {
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
const finishedRun = {
  'GET audit/runs': [{ runId: 'run1' }],
  'GET audit/runs/run1': {
    response: { accepted: true, runId: 'run1' },
    state: { runId: 'run1', state: 'partial', stage: 'finalized', sequence: 2 },
  },
  'GET audit/runs/run1/result': collection(
    'run1',
    [printer, lldp],
    [
      {
        name: 'capture',
        state: 'truncated',
        reason: '容量上限で観測を打ち切り',
        captured: null,
        dropped: null,
        rows: 1,
        omitted: 0,
      },
    ],
  ),
}

test('a partial run, unknown drops and switch link candidates are shown as such', async () => {
  const { screen } = await mount(finishedRun)
  await expect.element(screen.getByText(/部分完了：一部の収集器が完了していません/)).toBeVisible()
  await expect.element(screen.getByText(/ドロップ 取得不能/)).toBeVisible()
  await expect.element(screen.getByRole('combobox', { name: 'SW-1 Gi1の接続元機器' })).toBeVisible()
  await expect.element(screen.getByRole('combobox', { name: 'SW-1 Gi1の接続先機器' })).toBeVisible()
})

test('the previous-run comparison lists additions and not-observed devices, never removals', async () => {
  const old = observed('old', 'device', { ip: '192.168.1.50', mac: '00:11:22:33:44:99', ports: [] })
  const { screen } = await mount({
    ...finishedRun,
    'GET audit/past': [{ runId: 'run0', state: 'completed', stage: 'finalized', sequence: 1 }],
    'POST audit/open': { runId: 'run0' },
    'GET audit/runs/run0/result': collection('run0', [old]),
  })
  await expect.element(screen.getByText(/部分完了：一部の収集器が完了していません/)).toBeVisible()
  await screen.getByText('保存済みの実行結果').click()
  await screen.getByRole('button', { name: '比較元にする' }).click()
  await expect.element(screen.getByText(/今回未観測（撤去とは判断しません）/)).toBeVisible()
  await expect.element(screen.getByText(/192\.168\.1\.50/)).toBeVisible()
  await expect.element(screen.getByText(/追加 1件/)).toBeVisible()
})
