import { mkdir, writeFile } from 'node:fs/promises'
import { sampleDoc } from '../src/lib/sample'
import { validate } from '../src/lib/validate'

const doc = sampleDoc()
const result = validate(doc)
if (result.errors.length) {
  throw new Error(JSON.stringify(result.errors))
}
await mkdir('examples', { recursive: true })
await writeFile('examples/network.json', `${JSON.stringify(doc, null, 2)}\n`)
console.log(
  `Fictional sample: ${doc.devices.length} devices, ${doc.links.length} links, ${result.warnings.length} warnings`,
)
