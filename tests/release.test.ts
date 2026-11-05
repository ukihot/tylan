import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createViewer, toPublic } from '../src/lib/publish'
import { sampleDoc } from '../src/lib/sample'
import { fakeFilePickers, fixture, id, NOW } from '../src/lib/test-fixture'

let browser: Browser
const browserVersions: Record<string, string> = {}
beforeAll(async () => {
  browser = await chromium.launch()
  browserVersions.chromium = browser.version()
})
afterAll(async () => {
  await browser?.close()
  await writeFile('.build/browser-versions.json', JSON.stringify(browserVersions, null, 2))
})
async function offlineContext() {
  const context = await browser.newContext({
    offline: true,
    viewport: { width: 1366, height: 900 },
  })
  const requests: string[] = []
  const errors: string[] = []
  context.on('request', (req) => {
    if (/^(https?|wss?):/.test(req.url())) {
      requests.push(req.url())
    }
  })
  context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)))
  return { context, requests, errors }
}
// Native file dialogs cannot be clicked in automation; replace them with in-memory files.
type Fake = ReturnType<typeof fakeFilePickers>
async function openJsonFile(page: Page, json: string) {
  await page.addInitScript(`window.__fake = (${fakeFilePickers.toString()})(window)`)
  await page.reload()
  await page.evaluate((text) => {
    const fake = (window as unknown as { __fake: Fake }).__fake
    fake.files.set('network.json', { text, lastModified: 1 })
    fake.toOpen = 'network.json'
  }, json)
  await page.getByRole('button', { name: /既存のJSONを開く/ }).click()
}
const savedFiles = (page: Page) =>
  page.evaluate(() =>
    Object.fromEntries((window as unknown as { __fake: Fake }).__fake.files),
  ) as Promise<Record<string, { text: string }>>
async function noExternalResources(context: BrowserContext) {
  const page = context.pages()[0]!
  const resources = await page.evaluate(() =>
    [...document.querySelectorAll('script[src],link[href],img[src],iframe[src]')]
      .map((el) => el.getAttribute('src') ?? el.getAttribute('href'))
      .filter((url) => url && !/^(data:|blob:|#)/.test(url)),
  )
  expect(resources).toEqual([])
}
test('配布HTMLのCSPハッシュが実際のインラインコードと一致する', async () => {
  const html = await readFile('dist/editor.html', 'utf8')
  const scripts = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)]
  expect(scripts).toHaveLength(1)
  for (const match of scripts) {
    expect(html).toContain(`sha256-${createHash('sha256').update(match[1]!).digest('base64')}`)
  }
  expect(html).toContain("connect-src 'none'")
  expect(html).not.toContain('import(')
})
test('編集用HTMLがオフラインのfile://で起動し、読込・図・公開・PNGが動く', async () => {
  const { context, requests, errors } = await offlineContext()
  try {
    const page = await context.newPage()
    await page.goto(pathToFileURL(resolve('dist/editor.html')).href)
    await page.getByRole('heading', { name: '監査用のJSONファイルを用意します' }).waitFor()
    await openJsonFile(page, JSON.stringify(fixture()))
    await page.getByRole('button', { name: '東京', exact: true }).waitFor()
    await page.getByRole('link', { name: 'トポロジー', exact: true }).click()
    await page.locator('.device-node').first().waitFor()
    expect(await page.locator('.device-node').count()).toBe(2)
    await page.getByRole('button', { name: '全体を表示' }).click()
    const pngPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'PNG出力' }).click()
    const png = await pngPromise
    expect(png.suggestedFilename()).toMatch(/\.png$/)
    expect(await png.failure()).toBeNull()
    await page.getByRole('link', { name: '検証・書き出し', exact: true }).click()
    await page.getByRole('checkbox', { name: '東京', exact: true }).check()
    // Ticking a site is a change: it is autosaved to the opened file as revision 1.
    await expect
      .poll(async () => JSON.parse((await savedFiles(page))['network.json']!.text).project.revision)
      .toBe(1)
    await page.getByRole('button', { name: '公開プレビューを確認' }).click()
    await page.getByRole('button', { name: '閲覧用HTMLを保存' }).click()
    await page.getByText(/閲覧用HTML（r0001）を保存しました/).waitFor()
    const saved = Object.keys(await savedFiles(page))
    expect(saved.some((n) => n.startsWith('viewer-r0001'))).toBe(true)
    expect(errors).toEqual([])
    expect(requests).toEqual([])
    await noExternalResources(context)
  } finally {
    await context.close()
  }
})
test('閲覧HTMLが日本語・空白のパスで開き、XSSを実行せず非公開値を含まない', async () => {
  const doc = fixture()
  doc.devices[0]!.name = '</script><img src=x onerror="globalThis.pwned=1">'
  doc.devices[0]!.serial = 'SECRET-SERIAL-NEVER-PUBLISH'
  const html = createViewer(
    await readFile('.build/viewer/viewer-template.html', 'utf8'),
    toPublic(doc, { siteIds: [id('sit', 1)], fields: {} }, NOW),
  )
  expect(html).not.toContain('SECRET-SERIAL-NEVER-PUBLISH')
  await mkdir('.build/日本語 空白', { recursive: true })
  const path = resolve('.build/日本語 空白/viewer.html')
  await writeFile(path, html)
  const { context, requests, errors } = await offlineContext()
  try {
    const page = await context.newPage()
    await page.goto(pathToFileURL(path).href)
    await page.getByText('閲覧専用', { exact: true }).waitFor()
    await page.locator('.device-node').first().waitFor()
    expect(await page.locator('.device-node').count()).toBe(2)
    expect(await page.evaluate(() => (globalThis as Record<string, unknown>).pwned)).toBeUndefined()
    expect(await page.getByRole('button', { name: '確定', exact: true }).count()).toBe(0)
    expect(await page.getByText(doc.devices[0]!.name, { exact: true }).count()).toBeGreaterThan(0)
    expect(errors).toEqual([])
    expect(requests).toEqual([])
    await noExternalResources(context)
    await page.screenshot({ path: '.build/viewer-1366.png', fullPage: true })
  } finally {
    await context.close()
  }
})

test.runIf(existsSync('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'))(
  'Edgeでも単体HTMLをfile://でオフライン起動する',
  async () => {
    const edge = await chromium.launch({ channel: 'msedge' })
    browserVersions.edge = edge.version()
    try {
      const context = await edge.newContext({
        offline: true,
        viewport: { width: 1366, height: 768 },
      })
      const page = await context.newPage()
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(pathToFileURL(resolve('dist/editor.html')).href)
      await page.getByRole('heading', { name: '監査用のJSONファイルを用意します' }).waitFor()
      await openJsonFile(page, JSON.stringify(sampleDoc()))
      await page.getByRole('link', { name: 'トポロジー', exact: true }).click()
      await page.locator('.device-node').first().waitFor()
      expect(await page.locator('.device-node').count()).toBe(9)
      await page.getByRole('button', { name: '全体を表示' }).click()
      await page.screenshot({ path: '.build/editor-edge-1366.png', fullPage: true })
      expect(errors).toEqual([])
    } finally {
      await edge.close()
    }
  },
)
