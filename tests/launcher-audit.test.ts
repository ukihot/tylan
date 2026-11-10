import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { migrateV2, planImport } from '../src/lib/import-plan'
import { prepareExport } from '../src/lib/io'
import type { Doc } from '../src/lib/schema'
import { fixture, id, NOW } from '../src/lib/test-fixture'

let child: ChildProcess
let base: string
let token: string
let root: string
beforeAll(async () => {
  await mkdir('.build', { recursive: true })
  root = await mkdtemp(resolve('.build/audit-contract-'))
  // A stand-in checkout: launcher\ next to dist\editor.html, data under -Root.
  const launcher = join(root, 'launcher')
  await mkdir(launcher)
  await mkdir(join(root, 'dist'))
  await mkdir(join(root, 'working'))
  await writeFile(join(root, 'dist', 'editor.html'), '<!doctype html><title>test</title>')
  await copyFile('launcher/tylan.ps1', join(launcher, 'tylan.ps1'))
  await copyFile('launcher/audit.ps1', join(launcher, 'audit.ps1'))
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
      join(launcher, 'tylan.ps1'),
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
  expect(Array.isArray(info.audit.missing)).toBe(true)
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

type Reply = {
  accepted: boolean | null
  error?: string
  package?: { path: string; hash: string }
}
const json = async <T = Record<string, unknown>>(response: Promise<Response>) =>
  (await (await response).json()) as T
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

async function finishedRun(profile: object = { siteId: id('sit', 1) }) {
  const key = `k${Math.random().toString(36).slice(2)}`
  const started = await json<{ runId: string }>(
    call('audit/runs', 'POST', JSON.stringify({ key, profile })),
  )
  await expect
    .poll(
      async () =>
        (await json<{ state?: { state: string } }>(call(`audit/runs/${started.runId}`))).state
          ?.state,
      { timeout: 15000 },
    )
    .toBe('completed')
  return started.runId
}
async function reply(requestId: string) {
  let value: Reply = { accepted: null }
  await expect
    .poll(
      async () => {
        value = await json<Reply>(call(`audit/responses?id=${requestId}`))
        return value.accepted
      },
      { timeout: 20000 },
    )
    .not.toBeNull()
  return value
}
async function importReply(importId: string) {
  let value: Reply = { accepted: null }
  await expect
    .poll(
      async () => {
        value = (await json<{ response: Reply }>(call(`imports/${importId}`))).response
        return value.accepted
      },
      { timeout: 20000 },
    )
    .not.toBeNull()
  return value
}
async function verify(importId: string) {
  expect((await call(`imports/${importId}/verify`, 'POST')).status).toBe(202)
  return importReply(importId)
}
/** Seals a finished fixture run and prepares its import into a fresh working/<file>. */
async function prepared(file: string, edit?: (candidate: Doc) => void) {
  const runId = await finishedRun()
  const collection = await json(call(`audit/runs/${runId}/result`))
  const sealed = await reply(
    (await json<{ requestId: string }>(call(`audit/runs/${runId}/evidence`, 'POST'))).requestId,
  )
  expect(sealed.accepted, sealed.error).toBe(true)
  const doc = migrateV2(fixture(), id('doc', 7))
  const created = await json<{ lastModified: string }>(
    call(`file?path=working/${file}&expect=new`, 'PUT', JSON.stringify(doc)),
  )
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
  const candidate = JSON.parse(prepareExport(plan.doc, NOW, 'tester').text) as Doc
  edit?.(candidate)
  const body = {
    importId: plan.importId,
    path: `working/${file}`,
    expect: created.lastModified,
    siteId: id('sit', 1),
    text: JSON.stringify(candidate),
  }
  const response = await call('imports/prepare', 'POST', JSON.stringify(body))
  return { runId, plan, body, response, sealed, path: join(root, 'working', file) }
}
const fault = (point: string) => call(`test/fault?point=${point}`, 'POST')
const reconcile = async (importId: string) =>
  (await json<{ state: string }>(call(`imports/${importId}/reconcile`))).state

test('a read never pairs one content with another version stamp while a writer races', async () => {
  const target = join(root, 'working', 'race.json')
  await writeFile(target, '{"n":0}')
  let writing = true
  const writer = (async () => {
    for (let n = 1; writing; n++) {
      await writeFile(target, JSON.stringify({ n, pad: 'x'.repeat(n % 4000) })).catch(() => {})
    }
  })()
  let checked = 0
  for (let i = 0; i < 60; i++) {
    const response = await call('file?path=working/race.json')
    if (response.status !== 200) {
      expect(response.status).toBe(409) // busy is acceptable; a torn pair is not
      continue
    }
    const text = await response.text()
    expect(response.headers.get('X-Last-Modified')!.split(':')[1]).toBe(sha(text))
    checked++
  }
  writing = false
  await writer
  expect(checked).toBeGreaterThan(10)
}, 60000)

test('importId stays bound to its run, selection and evidence package', async () => {
  const unknown = await prepared('bind-unknown.json', (doc) => {
    doc.importBatches![0]!.runId = 'neverStartedHere'
  })
  expect(unknown.response.status).toBe(403)
  const first = await prepared('bind.json')
  expect(first.response.status).toBe(202)
  const tampered = JSON.parse(first.body.text) as Doc
  tampered.importBatches![0]!.selectionHash = 'f'.repeat(64)
  const again = await call(
    'imports/prepare',
    'POST',
    JSON.stringify({ ...first.body, text: JSON.stringify(tampered) }),
  )
  expect(again.status).toBe(409)
}, 60000)

test('a failed replace keeps the canonical file and a clean retry applies once', async () => {
  const { plan, response, path } = await prepared('fault-replace.json')
  expect(response.status).toBe(202)
  expect((await importReply(plan.importId)).accepted).toBe(true)
  expect((await verify(plan.importId)).accepted).toBe(true)
  const before = await readFile(path, 'utf8')
  expect((await fault('replace')).status).toBe(204)
  expect((await call(`imports/${plan.importId}/commit`, 'POST')).status).toBe(500)
  expect(await readFile(path, 'utf8')).toBe(before)
  expect(await reconcile(plan.importId)).toBe('notApplied')
  expect((await verify(plan.importId)).accepted).toBe(true)
  expect((await call(`imports/${plan.importId}/commit`, 'POST')).status).toBe(200)
  expect(await reconcile(plan.importId)).toBe('applied')
  expect(JSON.parse(await readFile(path, 'utf8')).devices).toHaveLength(3)
}, 60000)

test('a lost commit response is recovered by reconcile, never by re-saving', async () => {
  const { plan, path } = await prepared('fault-respond.json')
  expect((await importReply(plan.importId)).accepted).toBe(true)
  expect((await verify(plan.importId)).accepted).toBe(true)
  expect((await fault('respond')).status).toBe(204)
  expect((await call(`imports/${plan.importId}/commit`, 'POST')).status).toBe(500)
  expect(await reconcile(plan.importId)).toBe('applied')
  expect((await verify(plan.importId)).accepted).toBe(true)
  expect((await call(`imports/${plan.importId}/commit`, 'POST')).status).toBe(409)
  const saved = JSON.parse(await readFile(path, 'utf8'))
  expect(saved.devices).toHaveLength(3)
  expect(saved.importBatches).toHaveLength(1)
}, 60000)

test('a failed import receipt does not undo or fail a verified canonical save', async () => {
  const { plan } = await prepared('fault-receipt.json')
  expect((await importReply(plan.importId)).accepted).toBe(true)
  expect((await verify(plan.importId)).accepted).toBe(true)
  expect((await fault('receipt')).status).toBe(204)
  expect((await call(`imports/${plan.importId}/commit`, 'POST')).status).toBe(200)
  expect(await reconcile(plan.importId)).toBe('applied')
}, 60000)

test('an ordinary save that fails before writing leaves the file as it was', async () => {
  const created = await json<{ lastModified: string }>(
    call('file?path=working/fault-write.json&expect=new', 'PUT', '{"v":1}'),
  )
  expect((await fault('write')).status).toBe(204)
  const failed = await call(
    `file?path=working/fault-write.json&expect=${encodeURIComponent(created.lastModified)}`,
    'PUT',
    '{"v":2}',
  )
  expect(failed.status).toBe(500)
  expect(await readFile(join(root, 'working', 'fault-write.json'), 'utf8')).toBe('{"v":1}')
})

test('evidence lost after preparation blocks commit until identical local content restores it', async () => {
  const { plan, body, path, sealed } = await prepared('evidence-lost.json')
  expect((await importReply(plan.importId)).accepted).toBe(true)
  await rm(join(sealed.package!.path, 'result.json'))
  expect((await verify(plan.importId)).accepted).toBe(false)
  expect((await call(`imports/${plan.importId}/commit`, 'POST')).status).toBe(409)
  expect(JSON.parse(await readFile(path, 'utf8')).devices).toHaveLength(2)
  expect((await call('imports/prepare', 'POST', JSON.stringify(body))).status).toBe(202)
  expect((await importReply(plan.importId)).accepted).toBe(true)
  expect((await verify(plan.importId)).accepted).toBe(true)
  expect((await call(`imports/${plan.importId}/commit`, 'POST')).status).toBe(200)
}, 90000)

test('an evidence transfer failure is reported and nothing is sealed', async () => {
  const runId = await finishedRun()
  await mkdir(join(root, 'evidence', id('sit', 1)), { recursive: true })
  await writeFile(join(root, 'evidence', id('sit', 1), runId), 'not a folder')
  const sealed = await reply(
    (await json<{ requestId: string }>(call(`audit/runs/${runId}/evidence`, 'POST'))).requestId,
  )
  expect(sealed.accepted).toBe(false)
})

test('an offline switch export becomes an imported run without sending anything', async () => {
  const runId = await finishedRun({
    mode: 'offline',
    siteId: id('sit', 1),
    switchExport: {
      format: 'tylan-switch-export',
      schemaVersion: 1,
      vendor: 'generic',
      records: [
        {
          protocol: 'lldp',
          localDevice: 'SW-1',
          localPort: 'Gi1',
          remoteDevice: 'AP-1',
          remotePort: 'eth0',
        },
      ],
    },
  })
  const result = await json<{
    scope: { observationPoint: string }
    observations: { type: string; source: string }[]
  }>(call(`audit/runs/${runId}/result`))
  expect(result.scope.observationPoint).toBe('imported')
  expect(result.observations[0]?.type).toBe('physicalCandidate')
  expect(result.observations.some((o) => o.source === 'synthetic')).toBe(false)
})

test('the IPv6 switch reaches the real read-only host diagnosis through PowerShell and Python', async () => {
  const diagnose = async (includeIPv6: boolean) => {
    const request = await json<{ requestId: string }>(
      call('audit/diagnose', 'POST', JSON.stringify({ includeIPv6 })),
    )
    return (await reply(request.requestId)) as Reply & {
      inventory?: { ipv6?: { state: string; reason: string | null } }
    }
  }
  const off = await diagnose(false)
  expect(off.accepted, off.error).toBe(true)
  expect(off.inventory?.ipv6?.state).toBe('skipped')
  const on = await diagnose(true)
  expect(['completed', 'failed']).toContain(on.inventory?.ipv6?.state)
}, 60000)

test('a stopped owner reports itself and ordinary saves keep working', async () => {
  expect((await call('audit/test-stop', 'POST')).status).toBe(202)
  await expect
    .poll(
      async () => {
        const diagnose = await json<{ requestId: string }>(call('audit/diagnose', 'POST', '{}'))
        return (await json<Reply>(call(`audit/responses?id=${diagnose.requestId}`))).error ?? ''
      },
      { timeout: 15000 },
    )
    .toMatch(/stopped/)
  expect((await call('file?path=working/after-stop.json&expect=new', 'PUT', '{}')).status).toBe(200)
}, 30000)
