import { emptyDoc, newEntity } from './schema'
export const NOW = '2026-11-05T14:30:00+09:00'
export const id = (prefix: string, n: number) => `${prefix}_${String(n).padStart(16, '0')}`
/** In-memory stand-in for the browser file pickers (tests cannot click native dialogs). */
export function fakeFilePickers(target: object = window) {
  const files = new Map<string, { text: string; lastModified: number }>()
  const state = { files, toOpen: '' }
  const handle = (name: string) => ({
    name,
    kind: 'file',
    async getFile() {
      const f = files.get(name)!
      return new File([f.text], name, { lastModified: f.lastModified })
    },
    async createWritable() {
      const parts: (string | Blob)[] = []
      return {
        async write(chunk: string | Blob) {
          parts.push(chunk)
        },
        async close() {
          const f = files.get(name)!
          f.text = await new Blob(parts).text()
          f.lastModified++
        },
      }
    },
  })
  Object.assign(target, {
    async showSaveFilePicker(options: { suggestedName: string }) {
      files.set(options.suggestedName, { text: '', lastModified: 1 })
      return handle(options.suggestedName)
    },
    async showOpenFilePicker() {
      return [handle(state.toOpen)]
    },
  })
  return state
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
