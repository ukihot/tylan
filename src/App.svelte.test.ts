import { expect, test } from 'vitest'
import { render } from 'vitest-browser-svelte'
import App from './App.svelte'
import EntityScreen from './components/EntityScreen.svelte'
import { createWorkspace } from './lib/store.svelte'
import { fixture, id, memoryFolder, NOW } from './lib/test-fixture'

type Screen = Awaited<ReturnType<typeof render>>
const jsonName = `network-${new Date().getFullYear()}.json`
async function createJson(screen: Screen) {
  await screen.getByRole('button', { name: '作成して編集を始める' }).click()
  await expect.element(screen.getByRole('button', { name: '拠点を追加' })).toBeVisible()
}

test('新しいJSONを作って拠点・機器を登録し、キャンセル・Undoが動作する', async () => {
  const screen = await render(App, { folder: memoryFolder().folder })
  await createJson(screen)
  await screen.getByRole('button', { name: '拠点を追加' }).click()
  await screen.getByRole('textbox', { name: '名称', exact: true }).fill('本社')
  await screen.getByRole('button', { name: '確定', exact: true }).click()
  await expect.element(screen.getByText('本社', { exact: true }).first()).toBeVisible()
  await screen.getByRole('link', { name: '機器・資産台帳' }).click()
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
})

test('入力中の画面移動を止め、続行を選ぶまで下書きを保持する', async () => {
  window.location.hash = '#/project'
  const screen = await render(App, { folder: memoryFolder().folder })
  await createJson(screen)
  await screen.getByRole('button', { name: '拠点を追加' }).click()
  await screen.getByRole('textbox', { name: '名称', exact: true }).fill('入力途中の拠点')
  await screen.getByRole('link', { name: '機器・資産台帳', exact: true }).click()
  await expect.element(screen.getByRole('alertdialog')).toBeVisible()
  await screen.getByRole('button', { name: '現在の作業を続ける' }).click()
  await expect
    .element(screen.getByRole('textbox', { name: '名称', exact: true }))
    .toHaveValue('入力途中の拠点')
  await screen.getByRole('link', { name: '機器・資産台帳', exact: true }).click()
  await screen.getByRole('button', { name: '変更を破棄して続行' }).click()
  await expect.element(screen.getByRole('heading', { name: '機器', exact: true })).toBeVisible()
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

test('起動プログラムなしでは編集不可', async () => {
  const screen = await render(App, { folder: null })
  await expect
    .element(screen.getByRole('heading', { name: /tylan\.cmd から起動してください/ }))
    .toBeVisible()
  await expect.element(screen.getByRole('button', { name: '拠点を追加' })).not.toBeInTheDocument()
})

test('JSONを握るまで編集不可。変更はworkingへ自動保存され、開き直し・前回分の引き継ぎができ、他所の変更は上書きしない', async () => {
  window.location.hash = '#/project'
  const fake = memoryFolder()
  const path = `working/${jsonName}`
  const first = await render(App, { folder: fake.folder })
  await expect.element(first.getByRole('button', { name: '作成して編集を始める' })).toBeVisible()
  await expect.element(first.getByRole('button', { name: '拠点を追加' })).not.toBeInTheDocument()
  await createJson(first)
  expect(fake.files.get(path)?.text).toContain('"format": "tylan"')
  await first.getByRole('button', { name: '拠点を追加' }).click()
  await first.getByRole('textbox', { name: '名称', exact: true }).fill('本社')
  await first.getByRole('button', { name: '確定', exact: true }).click()
  await expect.poll(() => fake.files.get(path)!.text, { timeout: 3000 }).toContain('本社')
  await expect.element(first.getByText(/^保存済み/)).toBeVisible()
  await first.unmount()

  // Browser closed and reopened: the data lives in the file, not in the page.
  const second = await render(App, { folder: fake.folder })
  await second.getByRole('button', { name: `${jsonName} を開く` }).click()
  await expect.element(second.getByRole('button', { name: '本社', exact: true })).toBeVisible()

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

  // Next audit: a new file that carries over last year's data; the source stays untouched.
  await second.getByRole('button', { name: 'ファイルを閉じる' }).click()
  const before = fake.files.get(path)!.text
  await second.getByRole('textbox', { name: 'ファイル名' }).fill('network-next.json')
  await second.getByRole('button', { name: '作成して編集を始める' }).click()
  await expect.element(second.getByText('network-next.json', { exact: true })).toBeVisible()
  expect(fake.files.get('working/network-next.json')!.text).toContain('本社ビル')
  expect(fake.files.get(path)!.text).toBe(before)
})

test('取り込み処理中は画面移動とページ終了を止める', async () => {
  window.location.hash = '#/project'
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
      return new Promise(() => {}) // the share stalls while the import holds the file
    }
    return replies[path] ?? []
  }
  const screen = await render(App, { folder: fake.folder })
  await screen.getByRole('button', { name: 'network.json を開く' }).click()
  await screen.getByRole('link', { name: '監査', exact: true }).click()
  await screen.getByRole('checkbox', { name: '192.168.1.42を台帳に追加' }).click()
  await screen.getByRole('textbox', { name: '確認者' }).fill('調査者')
  await screen.getByRole('button', { name: '選択した結果を取り込む' }).click()
  await expect.poll(() => sealing).toBe(true)
  await screen.getByRole('link', { name: '機器・資産台帳', exact: true }).click()
  await expect.element(screen.getByText(/取り込み処理中は画面を移動できません/)).toBeVisible()
  expect(window.location.hash).toBe('#/audit')
  const unload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unload)
  expect(unload.defaultPrevented).toBe(true)
})

test('実行中の監査は他の画面でも状況と進捗を表示し、監査画面へ戻れる', async () => {
  window.location.hash = '#/project'
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
  await screen.getByRole('button', { name: 'network.json を開く' }).click()
  await expect.element(screen.getByText('network.json を開きました。')).toBeVisible()
  const chip = screen.getByRole('link', { name: /現地監査.*機器探索・ポート/ })
  await expect.element(chip).toBeVisible()
  await expect.element(chip.getByRole('progressbar')).toHaveAttribute('value', '1')
  await chip.click()
  await expect.poll(() => window.location.hash).toBe('#/audit')
  await expect
    .element(screen.getByRole('progressbar', { name: '機器探索・ポートの進捗' }))
    .toBeVisible()
  await expect.element(chip).not.toBeInTheDocument()
})
