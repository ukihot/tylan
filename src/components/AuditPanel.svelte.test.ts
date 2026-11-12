import { expect, test } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { fidget } from '../lib/fidget.svelte'
import { createFileSession } from '../lib/file-session.svelte'
import { createWorkspace } from '../lib/store.svelte'
import { fixture, id, memoryFolder, NOW } from '../lib/test-fixture'
import AuditPanel from './AuditPanel.svelte'

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
    {
      ifIndex: 9,
      guid: '{4D36E972-E325-11CE-BFC1-08002BE10319}',
      name: 'Wi-Fi',
      description: 'WLAN',
      mac: '00:11:22:33:44:56',
      status: 'Up',
      hardware: true,
    },
  ],
  addresses: [
    { ifIndex: 4, address: '10.0.0.5', prefixLength: 24, family: 'IPv4', state: 'Preferred' },
    { ifIndex: 9, address: '192.168.1.20', prefixLength: 24, family: 'IPv4', state: 'Preferred' },
  ],
  routes: [{ prefix: '0.0.0.0/0', ifIndex: 9, nextHop: '192.168.1.1', metric: 25 }],
  ipv6: { state: 'failed', reason: 'access denied' },
}
type Routes = Record<string, unknown>
async function mount(routes: Routes, view: 'run' | 'diff' = 'run') {
  const memory = memoryFolder()
  const calls: { method: string; path: string; body: unknown }[] = []
  const all: Routes = {
    'POST audit/diagnose': { requestId: 'd1' },
    'GET audit/responses?id=d1': { accepted: true, inventory },
    ...routes,
  }
  memory.folder.info = async () => ({ root: 'D:\\tylan\\data', audit: { available: true } })
  memory.folder.audit = async (method, path, body) => {
    calls.push({ method, path, body })
    const hit = all[`${method} ${path}`]
    if (typeof hit === 'function') {
      return hit(body)
    }
    return hit === undefined ? [] : structuredClone(hit)
  }
  const workspace = createWorkspace(fixture())
  const files = createFileSession(workspace, memory.folder)
  await memory.folder.write('working/network.json', JSON.stringify(fixture()), 'new')
  await files.open('network.json')
  const screen = await render(AuditPanel, {
    workspace,
    files,
    folder: memory.folder,
    view,
    siteId: id('sit', 1),
  })
  return { screen, calls, files, workspace, memory }
}

test('the NIC with the default route is found on open; only the start button remains', async () => {
  const { screen, calls } = await mount({})
  await expect.element(screen.getByText(/^192\.168\.1\.0\/24/)).toBeVisible()
  await expect.element(screen.getByText(/Wi-Fi 192\.168\.1\.20 から/)).toBeVisible()
  await expect.element(screen.getByRole('button', { name: '監査を開始' })).toBeEnabled()
  // The yardstick comes from the JSON baseline: unset values are said to be unset.
  await expect.element(screen.getByText(/GW 未設定 \/ DNS 未設定/)).toBeVisible()
  expect(calls.map((c) => `${c.method} ${c.path}`)).not.toContain('POST audit/runs')
})

test('the IPv6 switch travels with the host diagnosis', async () => {
  const { screen, calls } = await mount({})
  await expect.element(screen.getByRole('button', { name: '監査を開始' })).toBeEnabled()
  await screen.getByText('実行条件を変える').click()
  await screen.getByRole('checkbox', { name: 'IPv6設定の読取（送信なし）' }).click()
  await screen.getByRole('button', { name: 'NICを取得し直す' }).click()
  await expect
    .poll(() => calls.filter((c) => c.path === 'audit/diagnose').at(-1)?.body)
    .toEqual({ includeIPv6: false })
})

test('tools missing on the audit host are listed before any audit starts', async () => {
  const memory = memoryFolder()
  memory.folder.info = async () => ({
    root: 'D:\\tylan\\data',
    audit: { available: true, missing: ['Nmap', 'Npcap'], optional: ['Wireshark (TShark)'] },
  })
  memory.folder.audit = async () => []
  const workspace = createWorkspace(fixture())
  const files = createFileSession(workspace, memory.folder)
  await memory.folder.write('working/network.json', JSON.stringify(fixture()), 'new')
  await files.open('network.json')
  const screen = await render(AuditPanel, {
    workspace,
    files,
    folder: memory.folder,
    view: 'run',
    siteId: id('sit', 1),
  })
  await expect.element(screen.getByText(/見つかりません：Nmap、Npcap/)).toBeVisible()
  await expect.element(screen.getByText(/なしでも監査できます）：Wireshark/)).toBeVisible()
})

test('starting makes the first round, and a refused start stops polling', async () => {
  const { screen, calls, workspace } = await mount({
    'POST audit/runs': { runId: 'run1', requestId: 'r1' },
    'GET audit/runs/run1': {
      response: { accepted: false, error: 'another run is active' },
      state: null,
    },
  })
  await screen.getByRole('button', { name: '監査を開始' }).click()
  await expect.element(screen.getByRole('alert')).toHaveTextContent('another run is active')
  await expect.element(screen.getByText(/受付拒否/)).toBeVisible()
  expect(workspace.doc.auditRounds).toHaveLength(1)
  expect(workspace.doc.auditResults).toHaveLength(20)
  const profile = calls.find((c) => c.path === 'audit/runs' && c.method === 'POST')?.body as {
    profile: Record<string, unknown>
  }
  expect(profile.profile).toMatchObject({
    cidrs: ['192.168.1.0/24'],
    source: '192.168.1.20',
    approvedDhcp: null,
    roundId: workspace.doc.auditRounds[0]!.id,
  })
  await expect.element(screen.getByRole('button', { name: '監査を中止' })).toBeDisabled()
  await expect.element(screen.getByRole('button', { name: '監査を開始' })).toBeEnabled()
  const polls = calls.filter((c) => c.path === 'audit/runs/run1').length
  await new Promise((resolve) => setTimeout(resolve, 1500))
  expect(calls.filter((c) => c.path === 'audit/runs/run1').length).toBe(polls)
})

const observed = (oid: string, type: string, value: Record<string, unknown>) => ({
  id: oid,
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
  profile: { mode: 'standard', cidrs: ['192.168.1.0/24'], source: '192.168.1.20' },
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
  ports: [{ port: 9100, protocol: 'tcp', state: 'open' }],
})
const phone = observed('phone', 'arp', { ip: '192.168.1.150', mac: '9e:da:7f:dc:ee:9f' })
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
    [printer, phone, lldp],
    [{ name: 'capture', state: 'truncated', reason: '容量上限で観測を打ち切り' }],
  ),
}

test('the diff names managed devices, counts clients and never lists a phone', async () => {
  const { screen } = await mount(finishedRun, 'diff')
  await expect.element(screen.getByText(/一部の収集が完了していません/)).toBeVisible()
  await expect
    .element(screen.getByRole('checkbox', { name: '192.168.1.42を台帳に追加' }))
    .toBeChecked()
  await expect.element(screen.getByText(/DHCP範囲外の固定IPなのに台帳にない/)).toBeVisible()
  await expect.element(screen.getByText('1台')).toBeVisible()
  await expect
    .element(screen.getByRole('checkbox', { name: '192.168.1.150を台帳に追加' }))
    .not.toBeInTheDocument()
  await expect.element(screen.getByRole('combobox', { name: 'SW-1 Gi1の接続元機器' })).toBeVisible()
  await expect.element(screen.getByRole('combobox', { name: 'SW-1 Gi1の接続先機器' })).toBeVisible()
})

const epoch = () => Date.now() / 1000
const runningRun = (state: Record<string, unknown>) => ({
  'GET audit/runs': [{ runId: 'run1' }],
  'GET audit/runs/run1': {
    response: { accepted: true, runId: 'run1' },
    state: {
      runId: 'run1',
      state: 'running',
      sequence: 3,
      startedAt: epoch() - 90,
      stageStartedAt: epoch() - 10,
      ...state,
    },
  },
})
const line = (key: string) => fidget.lines.find((l) => l.key === key)

test('a running scan floats its stage and counted progress as plain text', async () => {
  const { screen } = await mount(
    runningRun({
      stage: 'scanning',
      stages: ['validating', 'observing', 'scanning'],
      progress: { done: 2, total: 4 },
    }),
  )
  await expect
    .poll(() => line('run'))
    .toMatchObject({ text: '監査 機器探索・ポート', detail: '2/4 バッチ', done: false })
  await expect.element(screen.getByText(/開始から 1:3\d/)).toBeVisible()
  expect(document.querySelector('progress')).toBeNull()
})

test('the observation window shows elapsed and remaining time', async () => {
  await mount(
    runningRun({
      stage: 'observing',
      stages: ['validating', 'observing'],
      progress: { startedAt: epoch() - 60, endsAt: epoch() + 240 },
    }),
  )
  await expect.poll(() => line('run')?.detail).toMatch(/^1:0\d\/5:00$/)
})

test('an unaccepted request is shown as waiting, never as running', async () => {
  const { screen } = await mount({
    'POST audit/runs': { runId: 'run1', requestId: 'r1' },
    'GET audit/runs/run1': {
      response: { accepted: null, state: 'pendingAcceptance' },
      state: null,
    },
  })
  await screen.getByRole('button', { name: '監査を開始' }).click()
  await expect
    .poll(() => line('run'))
    .toMatchObject({ text: '監査 受付待ち', detail: '受付確認中', done: false })
})

test('a pending host diagnosis names the job that is running', async () => {
  const { screen } = await mount({ 'GET audit/responses?id=d1': { accepted: null } })
  await expect.element(screen.getByText('このPCのNICを確認中…')).toBeVisible()
  expect(line('busy')).toMatchObject({ text: 'ホスト設定の取得', done: false })
})

test('adoption shows which of its steps is in progress', async () => {
  const { screen } = await mount(
    { ...finishedRun, 'POST audit/runs/run1/evidence': () => new Promise(() => {}) },
    'diff',
  )
  await screen.getByRole('textbox', { name: '確認者' }).fill('調査者')
  await screen.getByRole('button', { name: /取り込む/ }).click()
  await expect.poll(() => line('adopt')?.text).toBe('取り込み 証跡の転送・封印')
})
