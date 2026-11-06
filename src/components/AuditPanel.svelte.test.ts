import { expect, test } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { createFileSession } from '../lib/file-session.svelte'
import { createWorkspace } from '../lib/store.svelte'
import { fixture, memoryFolder } from '../lib/test-fixture'
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
