import type { Doc, EntityMap } from './schema'
export function autoLayout(
  doc: {
    devices: Pick<Doc['devices'][number], 'id' | 'siteId' | 'name' | 'kind'>[]
    links: Pick<Doc['links'][number], 'id' | 'kind' | 'a' | 'b'>[]
  },
  siteId: string,
  layout?: EntityMap['layouts'],
) {
  const devices = doc.devices
    .filter((d) => d.siteId === siteId)
    .sort((a, b) => a.name.localeCompare(b.name, 'ja') || a.id.localeCompare(b.id))
  const ids = new Set(devices.map((d) => d.id))
  const adjacency = new Map<string, string[]>()
  for (const link of doc.links) {
    if (
      link.kind === 'physical' &&
      'deviceId' in link.a &&
      'deviceId' in link.b &&
      ids.has(link.a.deviceId) &&
      ids.has(link.b.deviceId)
    ) {
      for (const [a, b] of [
        [link.a.deviceId, link.b.deviceId],
        [link.b.deviceId, link.a.deviceId],
      ]) {
        adjacency.set(a!, [...(adjacency.get(a!) ?? []), b!])
      }
    }
  }
  const depths = new Map<string, number>()
  const queue = devices.filter((d) => d.kind === 'serviceAdapter').map((d) => d.id)
  for (const id of queue) {
    depths.set(id, 0)
  }
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!
    for (const next of adjacency.get(current) ?? []) {
      if (!depths.has(next)) {
        depths.set(next, depths.get(current)! + 1)
        queue.push(next)
      }
    }
  }
  const lastColumn = Math.max(0, ...depths.values()) + 1
  const counts = new Map<number, number>()
  const positions: EntityMap['layouts']['positions'] = {}
  const ordered = [...queue, ...devices.filter((d) => !depths.has(d.id)).map((d) => d.id)]
  for (const id of ordered) {
    const column = depths.get(id) ?? lastColumn
    const row = counts.get(column) ?? 0
    counts.set(column, row + 1)
    positions[id] = layout?.positions[id]?.pinned
      ? { ...layout.positions[id] }
      : { x: column * 300 + 80, y: row * 180 + 100, pinned: false }
  }
  for (const link of doc.links) {
    for (const side of ['a', 'b'] as const) {
      if ('unknown' in link[side]) {
        const other = link[side === 'a' ? 'b' : 'a']
        if ('deviceId' in other && ids.has(other.deviceId)) {
          const key = `unknown:${link.id}:${side}`
          const base = positions[other.deviceId]!
          const column = Math.round(base.x / 300) + 1
          const row = counts.get(column) ?? 0
          counts.set(column, row + 1)
          positions[key] = layout?.positions[key]?.pinned
            ? { ...layout.positions[key] }
            : { x: column * 300 + 80, y: row * 180 + 100, pinned: false }
        }
      }
    }
  }
  return positions
}
