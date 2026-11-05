import { emptyDoc, newEntity } from './schema'
export const NOW = '2026-11-05T14:30:00+09:00'
export const id = (prefix: string, n: number) => `${prefix}_${String(n).padStart(16, '0')}`
/**
 * In-memory stand-in for the shared tylan folder and the browser pickers
 * (tests cannot click native dialogs). Keys of `files` are paths like `working/network-2026.json`.
 * Self-contained so it can also be injected into a page with `.toString()`.
 */
export function fakeTylanFolder(target: object = window) {
  const files = new Map<string, { text: string; lastModified: number }>()
  const dirs = new Set(['', 'tools'])
  const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
  const missing = () => new DOMException('not found', 'NotFoundError')
  const fileHandle = (path: string) => ({
    kind: 'file',
    name: path.split('/').at(-1),
    async getFile() {
      const f = files.get(path)!
      return new File([f.text], path.split('/').at(-1)!, { lastModified: f.lastModified })
    },
    async createWritable() {
      const parts: (string | Blob)[] = []
      return {
        async write(chunk: string | Blob) {
          parts.push(chunk)
        },
        async close() {
          const f = files.get(path)!
          f.text = await new Blob(parts).text()
          f.lastModified++
        },
      }
    },
  })
  const dirHandle = (path: string): object => ({
    kind: 'directory',
    name: path.split('/').at(-1) || 'tylan',
    async getDirectoryHandle(name: string, options?: { create?: boolean }) {
      const p = join(path, name)
      if (!dirs.has(p)) {
        if (!options?.create) {
          throw missing()
        }
        dirs.add(p)
      }
      return dirHandle(p)
    },
    async getFileHandle(name: string, options?: { create?: boolean }) {
      const p = join(path, name)
      if (!files.has(p)) {
        if (!options?.create) {
          throw missing()
        }
        files.set(p, { text: '', lastModified: 1 })
      }
      return fileHandle(p)
    },
    async *values() {
      for (const key of files.keys()) {
        if (
          key.startsWith(path ? `${path}/` : '') &&
          !key.slice(path ? path.length + 1 : 0).includes('/')
        ) {
          yield fileHandle(key)
        }
      }
    },
  })
  Object.assign(target, {
    async showDirectoryPicker() {
      return dirHandle('')
    },
    async showSaveFilePicker(options: { suggestedName: string }) {
      const p = join('saved', options.suggestedName)
      files.set(p, { text: '', lastModified: 1 })
      return fileHandle(p)
    },
  })
  return { files }
}
export function fixture() {
  const doc = emptyDoc(NOW, id('prj', 1))
  doc.sites.push({ ...newEntity('sites', id('sit', 1)), name: '東京' })
  doc.locations.push({
    ...newEntity('locations', id('loc', 1)),
    siteId: id('sit', 1),
    name: 'ラック',
  })
  for (let i = 1; i <= 2; i++) {
    doc.devices.push({
      ...newEntity('devices', id('dev', i)),
      siteId: id('sit', 1),
      locationId: id('loc', 1),
      name: `機器${i}`,
      kind: i === 1 ? 'serviceAdapter' : 'switch',
    })
    doc.ports.push({ ...newEntity('ports', id('prt', i)), deviceId: id('dev', i), name: 'LAN1' })
  }
  doc.links.push({
    ...newEntity('links', id('lnk', 1)),
    a: { deviceId: id('dev', 1), portId: id('prt', 1) },
    b: { deviceId: id('dev', 2), portId: id('prt', 2) },
    certainty: 'confirmed',
  })
  doc.segments.push({
    ...newEntity('segments', id('seg', 1)),
    siteId: id('sit', 1),
    name: 'LAN',
    cidr: '192.168.1.0/24',
  })
  doc.ipAssignments.push({
    ...newEntity('ipAssignments', id('ip', 1)),
    portId: id('prt', 1),
    segmentId: id('seg', 1),
    address: '192.168.1.100',
    mode: 'static',
  })
  doc.dhcpScopes.push({
    ...newEntity('dhcpScopes', id('dhc', 1)),
    segmentId: id('seg', 1),
    serverDeviceId: id('dev', 1),
    serverUnknown: null,
    ranges: [{ start: '192.168.1.100', end: '192.168.1.200' }],
  })
  doc.layouts.push({
    ...newEntity('layouts', id('lay', 1)),
    name: '物理構成',
    siteId: id('sit', 1),
  })
  return doc
}
