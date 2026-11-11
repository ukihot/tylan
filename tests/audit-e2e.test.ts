// P3 end to end: built editor + checkout launcher + real Python job owner with a synthetic collector.
// No network is scanned; the collector returns a fixed collection (AuditFixture is test-only).
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { type Browser, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { startRound } from '../src/lib/commands'
import type { Doc } from '../src/lib/schema'
import { fixture, id, NOW } from '../src/lib/test-fixture'

let browser: Browser
let launcher: ChildProcess
let root: string
let url: string
beforeAll(async () => {
  // Japanese and spaces in the local path (AUTO-07, local part only; UNC is a site gate).
  root = resolve('.build', 'e2e', '監査 フォルダ')
  await rm(root, { recursive: true, force: true })
  await mkdir(join(root, 'working'), { recursive: true })
  const round = startRound(
    fixture(),
    {
      id: id('rnd', 1),
      name: '2026年度',
      siteIds: [id('sit', 1)],
      startDate: null,
      endDate: null,
      surveyor: null,
    },
    Array.from({ length: 20 }, (_, n) => id('aud', n + 1)),
  )
  if (!round.ok) {
    throw new Error(round.errors.map((e) => e.message).join('\n'))
  }
  await writeFile(join(root, 'working', 'network.json'), JSON.stringify(round.doc))
  const synthetic = join(root, 'synthetic.json')
  await writeFile(
    synthetic,
    JSON.stringify({
      diagnostics: {
        tools: { python: 'synthetic' },
        inventory: {
          adapters: [
            {
              ifIndex: 4,
              guid: '{4D36E972-E325-11CE-BFC1-08002BE10318}',
              name: 'Ethernet',
              description: 'synthetic NIC',
              mac: '00:11:22:33:44:01',
              status: 'Up',
              hardware: true,
            },
          ],
          addresses: [
            {
              ifIndex: 4,
              address: '192.168.1.20',
              prefixLength: 24,
              family: 'IPv4',
              state: 'Preferred',
            },
          ],
          routes: [],
          ipv6: { state: 'skipped', reason: 'IPv6 local check OFF' },
        },
      },
      collection: {
        format: 'tylan-collection',
        schemaVersion: 1,
        runId: 'replacedByOwner',
        profile: {},
        tools: {},
        scope: { observationPoint: 'host', captureFilter: 'arp' },
        startedAt: NOW,
        endedAt: NOW,
        collectors: [{ name: 'synthetic', state: 'completed' }],
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
        findings: [
          {
            id: 'dhcp-server-v1',
            itemNo: 14,
            status: 'inconclusive',
            reason: 'DHCP応答未観測。不在の証明ではありません',
            nextCheck: '配布元設定・リース・別の観測点を確認',
            observationIds: [],
          },
        ],
      },
    }),
  )
  launcher = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      resolve('launcher/tylan.ps1'),
      '-Root',
      root,
      '-NoBrowser',
      '-AuditFixture',
      synthetic,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  url = await new Promise<string>((ok, fail) => {
    let output = ''
    const timer = setTimeout(() => fail(new Error(output || 'launcher timeout')), 20000)
    launcher.stdout?.on('data', (data) => {
      output += data
      const match = output.match(/TYLAN_URL=(\S+)/)
      if (match) {
        clearTimeout(timer)
        ok(match[1]!)
      }
    })
    launcher.stderr?.on('data', (data) => {
      output += data
    })
    launcher.on('exit', () => fail(new Error(output)))
  })
  browser = await chromium.launch()
})
afterAll(async () => {
  await browser?.close()
  if (url) {
    const { origin, searchParams } = new URL(url)
    await fetch(`${origin}/api/audit/test-stop`, {
      method: 'POST',
      headers: { 'X-Tylan-Token': searchParams.get('t')! },
    }).catch(() => {})
  }
  launcher?.kill()
})
const saved = async () =>
  JSON.parse(await readFile(join(root, 'working', 'network.json'), 'utf8')) as Doc

async function openAudit(page: Page) {
  await page.goto(url)
  await page.getByRole('button', { name: 'network.json を開く' }).click()
  await page.getByText('network.json を開きました。').waitFor()
  await page.getByRole('link', { name: '監査', exact: true }).click()
}

test('start → result → adopt → Undo through the shipped launcher and job owner', async () => {
  const page = await browser.newPage()
  try {
    await openAudit(page)
    await page.getByRole('checkbox', { name: 'IPv6ローカル設定確認（送信なし）' }).uncheck()
    await page.getByRole('button', { name: 'ホスト設定を取得' }).click()
    await page.getByText(/IPv6ローカル設定確認はOFFです/).waitFor()
    await page.getByRole('combobox', { name: /送信元NIC/ }).selectOption('4:192.168.1.20')
    await page.getByRole('button', { name: '現地監査を開始' }).click()
    await page.getByText('収集結果を取得しました。正本には未採用です。').waitFor({ timeout: 20000 })
    // A finished collection is not a saved import.
    expect((await saved()).schemaVersion).toBe(1)

    await page.getByRole('checkbox', { name: '192.168.1.42を台帳に追加' }).check()
    await page.getByLabel(/No\.14/).check()
    await page.getByRole('textbox', { name: '確認者' }).fill('調査者')
    await page.getByRole('button', { name: '選択した結果を取り込む' }).click()
    await page.getByText(/選択した結果を保存しました/).waitFor({ timeout: 40000 })
    const adopted = await saved()
    expect(adopted.schemaVersion).toBe(2)
    expect(adopted.devices).toHaveLength(3)
    expect(adopted.importBatches?.map((b) => b.state)).toEqual(['applied'])
    const item14 = adopted.auditResults.find((r) => r.itemNo === 14 && r.scope === 'summary')!
    expect([item14.judgment, item14.attempted]).toEqual(['unchecked', true])
    expect(item14.evidenceIds).toHaveLength(1)
    expect(await readdir(join(root, 'archive'))).not.toHaveLength(0)
    const sealed = await readdir(join(root, 'evidence', id('sit', 1)))
    expect(sealed.length).toBeGreaterThan(0)

    await page.getByRole('button', { name: '取り消す' }).click()
    await expect
      .poll(async () => (await saved()).importBatches?.map((b) => b.state), { timeout: 10000 })
      .toEqual(['reverted'])
    const undone = await saved()
    expect(undone.devices).toHaveLength(2)
    // Undo never deletes the sealed evidence on the share.
    expect(await readdir(join(root, 'evidence', id('sit', 1)))).toEqual(sealed)

    // Reload: the canonical file, not the page, carries the history.
    await openAudit(page)
    await page.getByRole('button', { name: '取り消す' }).waitFor()
    expect((await saved()).importBatches?.[0]?.state).toBe('reverted')
  } finally {
    await page.close()
  }
}, 120000)
