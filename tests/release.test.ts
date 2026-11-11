import { type ChildProcess, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type Browser, type BrowserContext, chromium } from 'playwright'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createViewer, toPublic } from '../src/lib/publish'
import { sampleDoc } from '../src/lib/sample'
import { fixture, id, NOW } from '../src/lib/test-fixture'

let browser: Browser
const browserVersions: Record<string, string> = {}
const launchers: ChildProcess[] = []
beforeAll(async () => {
  browser = await chromium.launch()
  browserVersions.chromium = browser.version()
})
afterAll(async () => {
  await browser?.close()
  for (const p of launchers) {
    p.kill()
  }
  await writeFile('.build/browser-versions.json', JSON.stringify(browserVersions, null, 2))
})

/** Runs the real launcher\tylan.ps1 (Windows PowerShell 5.1) against a fresh data folder. */
async function startLauncher(name: string, json?: string, script = 'launcher/tylan.ps1') {
  const root = resolve('.build/launcher', name)
  await rm(root, { recursive: true, force: true })
  await mkdir(join(root, 'working'), { recursive: true })
  if (json) {
    await writeFile(join(root, 'working', 'network.json'), json)
  }
  const ps = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', resolve(script)].concat([
      '-Root',
      root,
      '-NoBrowser',
    ]),
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  launchers.push(ps)
  const url = await new Promise<string>((ok, fail) => {
    let out = ''
    ps.stdout.on('data', (d) => {
      out += d
      const m = out.match(/TYLAN_URL=(\S+)/)
      if (m) {
        ok(m[1]!)
      }
    })
    ps.stderr.on('data', (d) => {
      out += d
    })
    ps.on('exit', (code) => fail(new Error(`launcher exited (${code}): ${out}`)))
    setTimeout(() => fail(new Error(`launcher did not start: ${out}`)), 20000)
  })
  const base = new URL(url).origin
  return { root, url, base, token: new URL(url).searchParams.get('t')! }
}
/** Records any request that leaves the machine (everything except the launcher itself). */
async function watchedContext(b: Browser, allowed: string) {
  const context = await b.newContext({ viewport: { width: 1366, height: 900 } })
  const requests: string[] = []
  const errors: string[] = []
  context.on('request', (req) => {
    if (/^(https?|wss?):/.test(req.url()) && !req.url().startsWith(allowed)) {
      requests.push(req.url())
    }
  })
  context.on('page', (p) => p.on('pageerror', (e) => errors.push(e.message)))
  return { context, requests, errors }
}
async function noExternalResources(context: BrowserContext) {
  const page = context.pages()[0]!
  const resources = await page.evaluate(() =>
    [...document.querySelectorAll('script[src],link[href],img[src],iframe[src]')]
      .map((el) => el.getAttribute('src') ?? el.getAttribute('href'))
      .filter((url) => url && !/^(data:|blob:|#)/.test(url)),
  )
  expect(resources).toEqual([])
}

test('配布HTMLのCSPハッシュが実際のインラインコードと一致し、通信先を限定する', async () => {
  const html = await readFile('dist/editor.html', 'utf8')
  const scripts = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)]
  expect(scripts).toHaveLength(1)
  for (const match of scripts) {
    expect(html).toContain(`sha256-${createHash('sha256').update(match[1]!).digest('base64')}`)
  }
  expect(html).toContain("connect-src 'self'")
  expect(html).not.toContain('import(')
  expect(await readFile('.build/viewer/viewer-template.html', 'utf8')).toContain(
    "connect-src 'none'",
  )
})

test('editor.htmlを直接開くと編集できず、tylan.cmdからの起動を案内する', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(pathToFileURL(resolve('dist/editor.html')).href)
    await page.getByRole('heading', { name: /tylan\.cmd から起動してください/ }).waitFor()
    expect(await page.getByRole('button', { name: '拠点を追加' }).count()).toBe(0)
  } finally {
    await page.close()
  }
})

test('持ち出し用 release/tylan は単体で編集画面と収集器を見つける', async () => {
  const { url, base, token } = await startLauncher(
    'portable',
    JSON.stringify(fixture()),
    'release/tylan/launcher/tylan.ps1',
  )
  expect(await (await fetch(url)).text()).toBe(
    await readFile('release/tylan/dist/editor.html', 'utf8'),
  )
  const info = await (
    await fetch(`${base}/api/info`, { headers: { 'X-Tylan-Token': token } })
  ).json()
  expect(info.audit.available).toBe(true)
  expect(existsSync('release/tylan/tylan.cmd')).toBe(true)
  expect(existsSync('release/tylan/collector/tests')).toBe(false)
})

test('起動プログラムは合言葉・Host・Origin・フォルダ・競合を検査する', async () => {
  const { base, token } = await startLauncher('security')
  const h = { 'X-Tylan-Token': token }
  expect((await fetch(`${base}/`)).status).toBe(403)
  expect((await fetch(`${base}/api/info`)).status).toBe(403)
  expect(
    (await fetch(`${base}/api/info`, { headers: { ...h, Origin: 'http://evil.example' } })).status,
  ).toBe(403)
  expect(
    (await fetch(`${base}/api/file?path=working/..%2F..%2Fx.json`, { headers: h })).status,
  ).toBe(400)
  expect((await fetch(`${base}/api/file?path=dist/editor.html`, { headers: h })).status).toBe(400)
  const put = (expect: string, body: string) =>
    fetch(`${base}/api/file?path=working/a.json&expect=${expect}`, {
      method: 'PUT',
      headers: h,
      body,
    })
  expect((await put('new', '{"a":"日本語"}')).status).toBe(200)
  expect((await put('new', '{}')).status).toBe(409)
  expect((await put('12345', '{}')).status).toBe(409)
  const read = await fetch(`${base}/api/file?path=working/a.json`, { headers: h })
  expect(await read.text()).toBe('{"a":"日本語"}')
  expect((await put(read.headers.get('X-Last-Modified')!, '{"b":1}')).status).toBe(200)
  // DNS rebinding: a request arriving with another Host name is refused.
  const status = await new Promise<number>((ok) => {
    const u = new URL(base)
    request(
      {
        host: u.hostname,
        port: u.port,
        path: '/api/info',
        headers: { ...h, Host: 'evil.example' },
      },
      (res) => ok(res.statusCode!),
    ).end()
  })
  expect(status).toBe(403)
})

test('tylan.cmd起動の編集画面で開く・図・PNG・自動保存・公開・CSVが作業フォルダへ届く', async () => {
  const { root, url, base } = await startLauncher('日本語 空白', JSON.stringify(fixture()))
  const { context, requests, errors } = await watchedContext(browser, base)
  try {
    const page = await context.newPage()
    await page.goto(url)
    await page.getByRole('button', { name: 'network.json を開く' }).click()
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
    // Ticking a site is a change: it is autosaved to the file on disk as revision 1.
    const saved = async () =>
      JSON.parse(await readFile(join(root, 'working', 'network.json'), 'utf8')).project.revision
    await expect.poll(saved, { timeout: 5000 }).toBe(1)
    await page.getByRole('button', { name: '公開プレビューを確認' }).click()
    await page.getByRole('button', { name: /閲覧用HTMLを公開/ }).click()
    await page.getByText(/閲覧用HTML（r0001）を published/).waitFor()
    expect(await readFile(join(root, 'published', 'viewer.html'), 'utf8')).toContain('tylan-data')
    await page.getByRole('button', { name: '資産台帳CSV' }).click()
    await page.getByText(/working\\csv\\assets-r0001/).waitFor()
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
  const { context, requests, errors } = await watchedContext(browser, 'file:')
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
  'Edgeでもtylan.cmd起動の編集画面が動く',
  async () => {
    const { url, base } = await startLauncher('edge', JSON.stringify(sampleDoc()))
    const edge = await chromium.launch({ channel: 'msedge' })
    browserVersions.edge = edge.version()
    try {
      const { context, errors, requests } = await watchedContext(edge, base)
      const page = await context.newPage()
      await page.goto(url)
      await page.getByRole('button', { name: 'network.json を開く' }).click()
      // Opening ends on the project screen; navigate only after it has finished.
      await page.getByText('network.json を開きました。').waitFor()
      await page.getByRole('link', { name: 'トポロジー', exact: true }).click()
      await page.locator('.device-node').first().waitFor()
      expect(await page.locator('.device-node').count()).toBe(9)
      await page.getByRole('button', { name: '全体を表示' }).click()
      await page.screenshot({ path: '.build/editor-edge-1366.png', fullPage: true })
      expect(errors).toEqual([])
      expect(requests).toEqual([])
    } finally {
      await edge.close()
    }
  },
)
