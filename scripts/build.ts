import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { parseConfigFileTextToJson } from 'typescript'
import { build } from 'vite'

await build({ mode: 'viewer' })
await build({ mode: 'editor' })
await mkdir('dist', { recursive: true })
// The launcher does the share I/O (Edge cannot write to SMB itself); it ships next to editor.html in tools\.
await copyFile('launcher/tylan.ps1', 'dist/tylan.ps1')
await copyFile('launcher/tylan.cmd', 'dist/tylan.cmd')
await copyFile('launcher/audit.ps1', 'dist/audit.ps1')
await mkdir('dist/collector', { recursive: true })
const collectorFiles = (await readdir('collector')).filter((name) => /\.(py|ps1)$/.test(name))
for (const name of collectorFiles) {
  await copyFile(`collector/${name}`, `dist/collector/${name}`)
}
const sums = []
for (const name of [
  'editor.html',
  'tylan.cmd',
  'tylan.ps1',
  'audit.ps1',
  ...collectorFiles.map((name) => `collector/${name}`),
]) {
  sums.push(
    `${createHash('sha256')
      .update(await readFile(`dist/${name}`))
      .digest('hex')}  ${name}\n`,
  )
}
await writeFile('dist/SHA256SUMS.txt', sums.join(''))
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
