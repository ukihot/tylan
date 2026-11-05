import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { parseConfigFileTextToJson } from 'typescript'
import { build } from 'vite'

await build({ mode: 'viewer' })
await build({ mode: 'editor' })
await mkdir('dist', { recursive: true })
const html = await readFile('dist/editor.html')
await writeFile(
  'dist/SHA256SUMS.txt',
  `${createHash('sha256').update(html).digest('hex')}  editor.html\n`,
)
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
