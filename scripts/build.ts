import { readFile, writeFile } from 'node:fs/promises'
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
