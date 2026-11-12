import { expect, test } from 'vitest'
import { render } from 'vitest-browser-svelte'
import App from './App.svelte'
import EntityScreen from './components/EntityScreen.svelte'
import { createWorkspace } from './lib/store.svelte'
import { fixture, id, memoryFolder, NOW } from './lib/test-fixture'

type Screen = Awaited<ReturnType<typeof render>>
const jsonName = `network-${new Date().getFullYear()}.json`
const step = (screen: Screen, name: string) =>
  screen
    .getByRole('navigation', { name: '監査の段階' })
    .getByRole('link', { name: new RegExp(name) })
async function startAudit(screen: Screen) {
  await screen.getByRole('button', { name: `${jsonName} を作って始める` }).click()
  await expect.element(screen.getByRole('heading', { name: '現地LANを調べる' })).toBeVisible()
}
async function addSite(screen: Screen, name: string) {
  await step(screen, '差分・基準').click()
  await screen.getByRole('link', { name: '拠点・設置場所', exact: true }).click()
  await screen.getByRole('button', { name: '拠点を追加' }).click()
  await screen.getByRole('textbox', { name: '名称', exact: true }).fill(name)
  await screen.getByRole('button', { name: '確定', exact: true }).click()
}

test('ファイルを開くと①実行に入り、②の台帳で拠点・機器を登録でき、キャンセル・Undoが動作する', async () => {
  window.location.hash = ''
  const screen = await render(App, { folder: memoryFolder().folder })
  await startAudit(screen)
  await expect.element(step(screen, '実行')).toHaveAttribute('aria-current', 'step')
  await addSite(screen, '本社')
  await expect.element(screen.getByText('本社', { exact: true }).first()).toBeVisible()
  await screen.getByRole('link', { name: '管理機器', exact: true }).click()
  await screen.getByRole('button', { name: '機器を追加' }).click()
  await screen.getByRole('textbox', { name: '名称', exact: true }).fill('コアスイッチ')
  await screen.getByRole('button', { name: '確定', exact: true }).click()
  await expect
    .element(screen.getByRole('button', { name: 'コアスイッチ', exact: true }))
    .toBeVisible()
  await screen.getByRole('button', { name: 'コアスイッチ', exact: true }).click()
  await screen.getByRole('button', { name: '編集', exact: true }).click()
  await screen.getByRole('textbox', { name: '名称', exact: true }).fill('破棄する変更')
  await screen.getByRole('button', { name: 'キャンセル', exact: true }).click()
  await expect.element(screen.getByText('破棄する変更', { exact: true })).not.toBeInTheDocument()
  await screen.getByRole('button', { name: '取り消す' }).click()
  await expect
    .element(screen.getByRole('button', { name: 'コアスイッチ', exact: true }))
    .not.toBeInTheDocument()
})

test('runesの単一正本、10世代Undo、不正読込の保護、出力状態', () => {
  const ws = createWorkspace(fixture())
  for (let i = 0; i < 12; i++) {
    ws.commit((d) => {
      d.devices[0]!.name = `更新${i}`
    })
  }
  expect(ws.undoCount).toBe(10)
  expect(ws.saveState).toBe('dirty')
  expect(ws.doc.devices[0]!.name).toBe('更新11')
  expect(ws.load('{')).toBe(false)
  expect(ws.doc.devices[0]!.name).toBe('更新11')
  ws.undo()
  expect(ws.doc.devices[0]!.name).toBe('更新10')
  const out = ws.exportJson(NOW, '担当者')
  expect(out.doc.project.revision).toBe(1)
  expect(ws.saveState).toBe('clean')
  expect(ws.doc.project.revision).toBe(1)
  expect(
    ws.commit((d) => {
      d.ports[0]!.deviceId = id('dev', 999)
    }),
  ).toBe(false)
  expect(ws.doc.ports[0]!.deviceId).toBe(id('dev', 1))
  expect(ws.load(out.text)).toBe(true)
  expect(ws.undoCount).toBe(0)
  // Old formats are refused instead of half-read.
  expect(ws.load(JSON.stringify({ ...fixture(), schemaVersion: 2 }))).toBe(false)
  expect(ws.issues[0]?.message).toMatch(/v3のみ/)
})

test('入力中の画面移動を止め、続行を選ぶまで下書きを保持する', async () => {
  window.location.hash = ''
  const screen = await render(App, { folder: memoryFolder().folder })
  await startAudit(screen)
  await step(screen, '差分・基準').click()
  await screen.getByRole('link', { name: '拠点・設置場所', exact: true }).click()
  await screen.getByRole('button', { name: '拠点を追加' }).click()
  await screen.getByRole('textbox', { name: '名称', exact: true }).fill('入力途中の拠点')
  await step(screen, '判定').click()
  await expect.element(screen.getByRole('alertdialog')).toBeVisible()
  await screen.getByRole('button', { name: '現在の作業を続ける' }).click()
  await expect
    .element(screen.getByRole('textbox', { name: '名称', exact: true }))
    .toHaveValue('入力途中の拠点')
  await step(screen, '判定').click()
  await screen.getByRole('button', { name: '変更を破棄して続行' }).click()
  await expect.element(screen.getByRole('heading', { name: '20項目の判定' })).toBeVisible()
})

test('回次作成画面から20項目を生成し、監査必須欄エラーでも下書きを保持する', async () => {
  const workspace = createWorkspace(fixture())
  const rounds = await render(EntityScreen, { workspace, collection: 'auditRounds' })
  await rounds.getByRole('button', { name: '監査回次を追加' }).click()
  await rounds.getByRole('textbox', { name: '名称', exact: true }).fill('初回調査')
  await rounds.getByRole('button', { name: '確定', exact: true }).click()
  expect(workspace.doc.auditResults).toHaveLength(20)
  expect(workspace.doc.auditResults.every((r) => r.judgment === 'unchecked')).toBe(true)
  await rounds.unmount()
  const screen = await render(EntityScreen, {
    workspace,
    collection: 'auditResults',
    selectedId: workspace.doc.auditResults[0]!.id,
  })
  await screen.getByRole('button', { name: '編集', exact: true }).click()
  await screen.getByRole('combobox', { name: '判定', exact: true }).selectOptions('ok')
  await screen.getByRole('button', { name: '確定', exact: true }).click()
  await expect.element(screen.getByRole('alert')).toBeVisible()
  await expect
    .element(screen.getByRole('combobox', { name: '判定', exact: true }))
    .toHaveValue('ok')
  expect(workspace.doc.auditResults[0]!.judgment).toBe('unchecked')
})

test('③では1行ずつ判定し、要対応は対応事項を作る', async () => {
  window.location.hash = '#/judge'
  const fake = memoryFolder()
  const doc = fixture()
  await fake.folder.write('working/network.json', JSON.stringify(doc), 'new')
  const screen = await render(App, { folder: fake.folder })
  await screen.getByText('別のファイルを開く・名前を決めて作る').click()
  await screen.getByRole('button', { name: 'network.json を開く' }).click()
  await step(screen, '判定').click()
  await expect.element(screen.getByText(/まだ監査回次がありません/)).toBeVisible()
  // A round normally comes from the first run; here it is made by hand.
  await screen.getByRole('link', { name: '監査回次' }).click()
  await screen.getByRole('button', { name: '監査回次を追加' }).click()
  await screen.getByRole('textbox', { name: '名称', exact: true }).fill('2026')
  await screen.getByRole('button', { name: '確定', exact: true }).click()
  await step(screen, '判定').click()
  await screen.getByRole('textbox', { name: '確認者' }).fill('調査者')
  await screen.getByRole('button', { name: '判定する' }).nth(12).click() // No.16 IP異常
  await screen.getByRole('radio', { name: '要対応' }).click()
  await screen.getByRole('textbox', { name: /確認結果・現状/ }).fill('169.254の端末あり')
  await screen.getByRole('textbox', { name: /問題点/ }).fill('DHCP枯渇の疑い')
  await screen.getByRole('button', { name: '判定を確定' }).click()
  await expect.element(screen.getByRole('button', { name: '判定を確定' })).not.toBeInTheDocument()
  await expect.element(step(screen, '対応').getByText('1', { exact: true })).toBeVisible()
  await step(screen, '対応').click()
  await expect.element(screen.getByRole('button', { name: 'DHCP枯渇の疑い' })).toBeVisible()
})

test('起動プログラムなしでは編集不可', async () => {
  const screen = await render(App, { folder: null })
  await expect
    .element(screen.getByRole('heading', { name: /tylan\.cmd から起動してください/ }))
    .toBeVisible()
  await expect.element(screen.getByRole('button', { name: '拠点を追加' })).not.toBeInTheDocument()
})

test('今年のJSONは前年分を引き継いで1クリックで作られ、自動保存・開き直し・競合の保護が働く', async () => {
  window.location.hash = ''
  const fake = memoryFolder()
  const path = `working/${jsonName}`
  await fake.folder.write('working/network-2000.json', JSON.stringify(fixture()), 'new')
  const first = await render(App, { folder: fake.folder })
  await expect.element(first.getByText(/network-2000\.json の管理機器・基準/)).toBeVisible()
  await startAudit(first)
  const created = JSON.parse(fake.files.get(path)!.text)
  expect(created.devices).toHaveLength(2)
  expect(created.documentId).not.toBe(fixture().documentId)
  expect(JSON.parse(fake.files.get('working/network-2000.json')!.text)).toEqual(fixture())
  await addSite(first, '本社')
  await expect.poll(() => fake.files.get(path)!.text, { timeout: 3000 }).toContain('本社')
  await expect.element(first.getByText(/^保存済み/)).toBeVisible()
  await first.unmount()

  // Browser closed and reopened: the data lives in the file, not in the page.
  const second = await render(App, { folder: fake.folder })
  await second.getByRole('button', { name: `${jsonName} を開いて続ける` }).click()
  await addSite(second, '支社')
  await expect.poll(() => fake.files.get(path)!.text, { timeout: 3000 }).toContain('支社')

  // Another PC saves the file: autosave must stop instead of overwriting.
  fake.touch(path)
  const outside = fake.files.get(path)!.text
  await second.getByRole('button', { name: '本社', exact: true }).click()
  await second.getByRole('button', { name: '編集', exact: true }).click()
  await second.getByRole('textbox', { name: '名称', exact: true }).fill('本社ビル')
  await second.getByRole('button', { name: '確定', exact: true }).click()
  await expect
    .element(second.getByText(/ファイルが別の場所で変更されています/), { timeout: 3000 })
    .toBeVisible()
  expect(fake.files.get(path)!.text).toBe(outside)
  await second.getByRole('button', { name: 'この画面の内容で上書きする' }).click()
  await expect.poll(() => fake.files.get(path)!.text).toContain('本社ビル')

  // A named file can still be made by hand; the source stays untouched.
  await second.getByRole('button', { name: 'ファイルを閉じる' }).click()
  const before = fake.files.get(path)!.text
  await second.getByText('別のファイルを開く・名前を決めて作る').click()
  await second.getByRole('textbox', { name: 'ファイル名' }).fill('network-next.json')
  await second.getByRole('combobox', { name: '引き継ぐデータ' }).selectOptions(jsonName)
  await second.getByRole('button', { name: '作成して始める' }).click()
  await expect.element(second.getByText('network-next.json', { exact: true })).toBeVisible()
  expect(fake.files.get('working/network-next.json')!.text).toContain('本社ビル')
  expect(fake.files.get(path)!.text).toBe(before)
})

test('取り込み処理中は画面移動とページ終了を止める', async () => {
  window.location.hash = ''
  const fake = memoryFolder()
  await fake.folder.write('working/network.json', JSON.stringify(fixture()), 'new')
  let sealing = false
  const result = {
    format: 'tylan-collection',
    schemaVersion: 1,
    runId: 'run1',
    profile: {},
    tools: {},
    scope: {},
    startedAt: NOW,
    endedAt: NOW,
    collectors: [],
    findings: [],
    observations: [
      {
        id: 'printer',
        type: 'device',
        source: 'synthetic',
        segment: 'site',
        observedAt: NOW,
        value: { ip: '192.168.1.42', mac: '00:11:22:33:44:55', ports: [] },
      },
    ],
  }
  const replies: Record<string, unknown> = {
    'audit/runs': [{ runId: 'run1' }],
    'audit/runs/run1': {
      response: { accepted: true, runId: 'run1' },
      state: { runId: 'run1', state: 'completed', stage: 'finalized', sequence: 1 },
    },
    'audit/runs/run1/result': result,
  }
  fake.folder.audit = async (_method, path) => {
    if (path === 'audit/runs/run1/evidence') {
      sealing = true
      return new Promise(() => {}) // the evidence folder stalls while the import holds the file
    }
    return replies[path] ?? []
  }
  const screen = await render(App, { folder: fake.folder })
  await screen.getByText('別のファイルを開く・名前を決めて作る').click()
  await screen.getByRole('button', { name: 'network.json を開く' }).click()
  // A finished run moves straight to its diff.
  await expect.poll(() => window.location.hash).toBe('#/diff')
  await expect
    .element(screen.getByRole('checkbox', { name: '192.168.1.42を台帳に追加' }))
    .toBeChecked()
  await screen.getByRole('textbox', { name: '確認者' }).fill('調査者')
  await screen.getByRole('button', { name: /取り込む/ }).click()
  await expect.poll(() => sealing).toBe(true)
  await step(screen, '判定').click()
  await expect.element(screen.getByText(/取り込み処理中は画面を移動できません/)).toBeVisible()
  expect(window.location.hash).toBe('#/diff')
  const unload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unload)
  expect(unload.defaultPrevented).toBe(true)
})

test('実行中の監査は他の段階でも右端の文字で進捗を示す', async () => {
  window.location.hash = ''
  const fake = memoryFolder()
  await fake.folder.write('working/network.json', JSON.stringify(fixture()), 'new')
  const now = Date.now() / 1000
  const replies: Record<string, unknown> = {
    'audit/runs': [{ runId: 'run1' }],
    'audit/runs/run1': {
      response: { accepted: true, runId: 'run1' },
      state: {
        runId: 'run1',
        state: 'running',
        stage: 'scanning',
        sequence: 3,
        startedAt: now - 30,
        stages: ['validating', 'scanning'],
        progress: { done: 1, total: 4 },
      },
    },
  }
  fake.folder.audit = async (_method, path) => replies[path] ?? []
  const screen = await render(App, { folder: fake.folder })
  await screen.getByText('別のファイルを開く・名前を決めて作る').click()
  await screen.getByRole('button', { name: 'network.json を開く' }).click()
  await expect.element(screen.getByText('network.json を開きました。')).toBeVisible()
  await step(screen, '判定').click()
  await expect.element(screen.getByText(/監査 機器探索・ポート/)).toBeVisible()
  await expect.element(screen.getByText('1/4 バッチ')).toBeVisible()
  expect(document.querySelector('progress, .job-chip')).toBeNull()
})
