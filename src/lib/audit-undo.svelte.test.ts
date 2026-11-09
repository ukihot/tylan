import { expect, test } from 'vitest'
import { createFileSession } from './file-session.svelte'
import { migrateV2 } from './import-plan'
import { createWorkspace } from './store.svelte'
import { fixture, id, memoryFolder, NOW } from './test-fixture'

test('import Undo restores business values and keeps reverted history through ordinary Undo', () => {
  const workspace = createWorkspace(migrateV2(fixture(), id('doc', 1)))
  const candidate = structuredClone(workspace.doc)
  candidate.devices[0]!.name = 'observed'
  candidate.importBatches!.push({
    id: id('imp', 1),
    runId: 'run1',
    packageHash: 'a'.repeat(64),
    selectionHash: 'b'.repeat(64),
    state: 'applied',
    bindings: [],
    evidenceIds: [],
    intentReference: null,
    checkedBy: 'tester',
    appliedAt: NOW,
  })
  expect(workspace.acceptImport(candidate, id('imp', 1))).toBe(true)
  workspace.commit((doc) => {
    doc.project.name = 'edited'
  })
  workspace.undo()
  expect(workspace.doc.importBatches?.[0]?.state).toBe('applied')
  workspace.undo()
  expect(workspace.doc.devices[0]?.name).toBe('機器1')
  expect(workspace.doc.importBatches?.[0]?.state).toBe('reverted')
})

test('preparing a save does not mark clean before acknowledgement', () => {
  const workspace = createWorkspace(fixture())
  workspace.commit((doc) => {
    doc.project.name = 'unsaved'
  })
  const candidate = workspace.prepareSave(NOW, 'tester')
  expect(workspace.saveState).toBe('dirty')
  expect(workspace.doc.project.revision).toBe(0)
  workspace.acknowledgeSave(candidate)
  expect(workspace.saveState).toBe('clean')
  expect(workspace.doc.project.revision).toBe(1)
})

test('closing the file is refused while an import holds the canonical file', async () => {
  const memory = memoryFolder()
  const workspace = createWorkspace(fixture())
  const files = createFileSession(workspace, memory.folder)
  await memory.folder.write('working/network.json', JSON.stringify(fixture()), 'new')
  await files.open('network.json')
  await files.beginImport()
  expect(await files.close()).toBe(false)
  expect(files.isOpen).toBe(true)
  files.endImport()
  expect(await files.close()).toBe(true)
})
