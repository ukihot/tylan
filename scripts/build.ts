import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseConfigFileTextToJson } from 'typescript'
import { build } from 'vite'

await build({ mode: 'viewer' })
await build({ mode: 'editor' })
// dist/ holds editor.html only: launcher/tylan.cmd serves it from the checkout on the audit host.
const lock = parseConfigFileTextToJson('bun.lock', await readFile('bun.lock', 'utf8')).config as {
  packages: Record<string, [string, ...unknown[]]>
}
const licenses = []
for (const [name, [specifier]] of Object.entries(lock.packages)) {
  try {
    const pkg = JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8'))
    const licenseFile = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'LICENSE-MIT'].map(
      (n) => `node_modules/${name}/${n}`,
    )
    let licenseText = ''
    for (const file of licenseFile) {
      try {
        licenseText = await readFile(file, 'utf8')
        break
      } catch {
        /* alternate filename */
      }
    }
    licenses.push(
      `${specifier} | ${typeof pkg.license === 'string' ? pkg.license : JSON.stringify(pkg.license)}\n${licenseText}`,
    )
  } catch {
    /* platform-specific optional package not installed */
  }
}
await writeFile('dist/THIRD-PARTY-LICENSES.txt', licenses.join('\n\n-----\n\n'))

// release/tylan/: the portable tool for survey laptops that have only Python 3.12+ and Nmap.
// Copied by hand: this host -> file share -> laptop desktop. Keeps the checkout's relative layout,
// so launcher\tylan.ps1 finds dist\editor.html and collector\ without changes. No data\ inside:
// copying a new version over the old folder never touches the laptop's data\.
const pkg = 'release/tylan'
await rm(pkg, { recursive: true, force: true })
const files = [
  'launcher/tylan.ps1',
  'launcher/audit.ps1',
  'dist/editor.html',
  'dist/THIRD-PARTY-LICENSES.txt',
  ...(await readdir('collector')).filter((n) => /\.(py|ps1)$/.test(n)).map((n) => `collector/${n}`),
]
for (const file of files) {
  await mkdir(dirname(`${pkg}/${file}`), { recursive: true })
  await copyFile(file, `${pkg}/${file}`)
}
const crlf = (lines: string[]) => `${lines.join('\r\n')}\r\n`
await writeFile(
  `${pkg}/tylan.cmd`,
  crlf([
    '@echo off',
    'start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launcher\\tylan.ps1"',
  ]),
)
await writeFile(
  `${pkg}/使い方.txt`,
  crlf([
    'tylan 調査用ツール',
    '',
    '必要なもの: Python 3.12以上、Nmap（Npcap込みで導入）。Wireshark(TShark)はなくても動きます（通信観測だけ省略）。',
    '',
    '1. このフォルダ(tylan)をデスクトップへコピーする。',
    '2. 共有フォルダの台帳JSONを tylan\\data\\working\\ へコピーする（初回は tylan.cmd を一度起動すると data が作られる）。',
    '3. tylan.cmd をダブルクリック → JSONを開き「監査」画面で現地監査・取り込み。変更はJSONへ自動保存される。',
    '4. 終わったら tylan\\data\\working\\ のJSONを共有フォルダへ上書きコピーする。',
    '   証跡も残す場合は tylan\\data\\evidence\\ も共有フォルダへコピーする。',
    '',
    'ツール更新時は新しい tylan フォルダを上書きコピーする（data フォルダはそのまま残る）。',
  ]),
)
console.log(`portable tool: ${pkg}`)
