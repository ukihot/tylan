import { expect, test } from 'vitest'
import { render } from 'vitest-browser-svelte'
import App from './App.svelte'
import EntityScreen from './components/EntityScreen.svelte'
import { createWorkspace } from './lib/store.svelte'
import { fakeTylanFolder, fixture, id, NOW } from './lib/test-fixture'

type Screen = Awaited<ReturnType<typeof render>>
const jsonName = `network-${new Date().getFullYear()}.json`
async function createJson(screen: Screen) {
  await screen.getByRole('button', { name: 'tylan フォルダを選ぶ' }).click()
  await screen.getByRole('button', { name: '作成して編集を始める' }).click()
  await expect.element(screen.getByRole('button', { name: '拠点を追加' })).toBeVisible()
}

test('新しいJSONを作って拠点・機器を登録し、キャンセル・Undoが動作する', async () => {
  fakeTylanFolder()
  const screen = await render(App)
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
  fakeTylanFolder()
  const screen = await render(App)
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

test('JSONを握るまで編集不可。変更はworkingへ自動保存され、開き直し・前回分の引き継ぎができ、他所の変更は上書きしない', async () => {
  window.location.hash = '#/project'
  const fake = fakeTylanFolder()
  const path = `working/${jsonName}`
  const first = await render(App)
  await expect.element(first.getByRole('button', { name: '拠点を追加' })).not.toBeInTheDocument()
  await createJson(first)
  await expect.poll(() => fake.files.get(path)?.text).toContain('"format": "tylan"')
  await first.getByRole('button', { name: '拠点を追加' }).click()
  await first.getByRole('textbox', { name: '名称', exact: true }).fill('本社')
  await first.getByRole('button', { name: '確定', exact: true }).click()
  await expect.poll(() => fake.files.get(path)!.text, { timeout: 3000 }).toContain('本社')
  await expect.element(first.getByText(/^保存済み/)).toBeVisible()
  await first.unmount()

  // Browser closed and reopened: the data lives in the file, not in the page.
  const second = await render(App)
  await second.getByRole('button', { name: 'tylan フォルダを選ぶ' }).click()
  await second.getByRole('button', { name: `${jsonName} を開く` }).click()
  await expect.element(second.getByRole('button', { name: '本社', exact: true })).toBeVisible()

  // Someone else changes the file: autosave must stop instead of overwriting.
  fake.files.get(path)!.lastModified += 100
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
  await expect.poll(() => fake.files.get('working/network-next.json')!.text).toContain('本社ビル')
  expect(fake.files.get(path)!.text).toBe(before)
})
