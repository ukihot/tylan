import { type ChildProcess, spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { migrateV2, planImport } from '../src/lib/import-plan'
import { prepareExport } from '../src/lib/io'
import { fixture, id, NOW } from '../src/lib/test-fixture'

let child: ChildProcess
let base: string
let token: string
let root: string
beforeAll(async () => {
  await mkdir('.build', { recursive: true })
  root = await mkdtemp(resolve('.build/audit-contract-'))
  const tools = join(root, 'tools')
  await mkdir(tools)
  await mkdir(join(root, 'working'))
  await writeFile(join(tools, 'editor.html'), '<!doctype html><title>test</title>')
  await copyFile('launcher/tylan.ps1', join(tools, 'tylan.ps1'))
  await copyFile('launcher/audit.ps1', join(tools, 'audit.ps1'))
  const fake = join(root, 'synthetic.json')
  await writeFile(
    fake,
    JSON.stringify({
      collection: {
        format: 'tylan-collection',
        schemaVersion: 1,
        runId: 'replacedByOwner',
        profile: {},
        tools: {},
        scope: {},
        startedAt: NOW,
        endedAt: NOW,
        collectors: [{ name: 'synthetic', state: 'completed' }],
        findings: [],
        observations: [
          {
            id: 'printer',
            type: 'device',
            source: 'synthetic',
            segment: id('sit', 1),
            observedAt: NOW,
            value: { ip: '192.168.1.42', mac: '00:11:22:33:44:55', hostname: 'printer', ports: [] },
          },
        ],
      },
    }),
  )
  child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(tools, 'tylan.ps1'),
      '-Root',
      root,
      '-NoBrowser',
      '-CollectorRoot',
      resolve('.'),
      '-AuditFixture',
      fake,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  const url = await new Promise<string>((ok, fail) => {
    let output = ''
    const timer = setTimeout(() => fail(new Error(output || 'launcher timeout')), 15000)
    child.stdout?.on('data', (data) => {
      output += data
      const match = output.match(/TYLAN_URL=(\S+)/)
      if (match) {
        clearTimeout(timer)
        ok(match[1]!)
      }
    })
    child.stderr?.on('data', (data) => {
      output += data
    })
    child.on('exit', () => {
      clearTimeout(timer)
      fail(new Error(output))
    })
  })
  base = new URL(url).origin
  token = new URL(url).searchParams.get('t')!
})
afterAll(async () => {
  if (base) {
    await call('audit/test-stop', 'POST').catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  child?.kill()
})
const call = (path: string, method = 'GET', body?: string) =>
  fetch(`${base}/api/${path}`, { method, headers: { 'X-Tylan-Token': token }, body })

test('canonical save detects equal-mtime content changes and preserves the previous version', async () => {
  const created = await call('file?path=working/a.json&expect=new', 'PUT', '{"value":1}')
  expect(created.status).toBe(200)
  const stamp = (await created.json()).lastModified
  expect(stamp).toContain(':')
  const saved = await call(
    `file?path=working/a.json&expect=${encodeURIComponent(stamp)}`,
    'PUT',
    '{"value":2}',
  )
  expect(saved.status).toBe(200)
  expect(
    (
      await call(
        `file?path=working/a.json&expect=${encodeURIComponent(stamp)}`,
        'PUT',
        '{"value":3}',
      )
    ).status,
  ).toBe(409)
  expect(await readFile(join(root, 'working/a.json'), 'utf8')).toBe('{"value":2}')
  expect((await call('list?dir=archive')).status).toBe(200)
  expect((await (await call('list?dir=archive')).json()).length).toBeGreaterThan(0)
})

test('audit capabilities and unavailable owner cannot disable ordinary saves', async () => {
  const info = await (await call('info')).json()
  expect(info.audit).toBeDefined()
  expect((await call('audit/runs/not-allowed/../../file')).status).not.toBe(200)
  expect((await call('file?path=working/after.json&expect=new', 'PUT', '{}')).status).toBe(200)
})

test('real IPC seals evidence before canonical commit and reconciles a lost acknowledgement', async () => {
  const key = `contract-${Date.now().toString(36)}`
  const started = await call(
    'audit/runs',
    'POST',
    JSON.stringify({ key, profile: { siteId: id('sit', 1) } }),
  )
  expect(started.status, await started.clone().text()).toBe(202)
  const run = await started.json()
  await expect
    .poll(async () => (await (await call(`audit/runs/${run.runId}`)).json()).state?.state, {
      timeout: 15000,
    })
    .toBe('completed')
  const duplicate = await (
    await call('audit/runs', 'POST', JSON.stringify({ key, profile: { siteId: id('sit', 1) } }))
  ).json()
  expect(duplicate.runId).toBe(run.runId)
  const collection = await (await call(`audit/runs/${run.runId}/result`)).json()
  const sealedRequest = await (await call(`audit/runs/${run.runId}/evidence`, 'POST')).json()
  let sealed: { accepted?: boolean; package?: { path: string; hash: string }; error?: string } = {}
  await expect
    .poll(
      async () => {
        sealed = await (await call(`audit/responses?id=${sealedRequest.requestId}`)).json()
        return sealed.accepted === false ? sealed.error : sealed.accepted
      },
      { timeout: 20000 },
    )
    .toBe(true)
  const doc = migrateV2(fixture(), id('doc', 1))
  const created = await (
    await call('file?path=working/network.json&expect=new', 'PUT', JSON.stringify(doc))
  ).json()
  const plan = await planImport(doc, collection, {
    documentId: doc.documentId!,
    siteId: id('sit', 1),
    segmentId: id('seg', 1),
    roundId: null,
    selected: ['printer'],
    mappings: {},
    checkedBy: 'tester',
    now: NOW,
    packageHash: sealed.package!.hash,
    storageLocation: sealed.package!.path,
  })
  const out = prepareExport(plan.doc, NOW, 'tester')
  expect(
    (
      await call(
        'imports/prepare',
        'POST',
        JSON.stringify({
          importId: plan.importId,
          path: 'working/network.json',
          expect: created.lastModified,
          siteId: id('sit', 1),
          text: out.text,
        }),
      )
    ).status,
  ).toBe(202)
  // A prepared candidate is not yet a committed canonical document.
  expect(
    JSON.parse(await readFile(join(root, 'working/network.json'), 'utf8')).devices,
  ).toHaveLength(2)
  await expect
    .poll(
      async () => {
        const state = await (await call(`imports/${plan.importId}`)).json()
        return state.response.accepted === false ? state.response.error : state.response.accepted
      },
      { timeout: 20000 },
    )
    .toBe(true)
  expect((await call(`imports/${plan.importId}/commit`, 'POST')).status).toBe(409)
  expect((await call(`imports/${plan.importId}/verify`, 'POST')).status).toBe(202)
  await expect
    .poll(async () => (await (await call(`imports/${plan.importId}`)).json()).response.accepted, {
      timeout: 15000,
    })
    .toBe(true)
  const committed = await call(`imports/${plan.importId}/commit`, 'POST')
  expect(committed.status, await committed.clone().text()).toBe(200)
  const reconciled = await (await call(`imports/${plan.importId}/reconcile`)).json()
  expect(reconciled.state).toBe('applied')
  expect(JSON.parse(reconciled.text).devices).toHaveLength(3)
  expect(JSON.parse(reconciled.text).importBatches[0].id).toBe(plan.importId)
}, 60000)
