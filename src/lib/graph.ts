import type { Edge, Node } from '@xyflow/svelte'
import { auditBadge } from './audit-master'
import { autoLayout } from './layout'
import type { PublicDoc } from './publish'
import type { Doc } from './schema'
export type GraphDoc = Pick<
  PublicDoc,
  'sites' | 'locations' | 'devices' | 'ipAssignments' | 'auditResults' | 'layouts'
> & {
  ports: (PublicDoc['ports'][number] & { segmentIds?: string[] })[]
  links: (PublicDoc['links'][number] & { segmentIds?: string[] })[]
  segments?: Doc['segments']
  wirelessNetworks?: Doc['wirelessNetworks']
}
export type GraphOptions = {
  layoutId?: string
  query?: string
  kind?: string
  judgment?: string
  roundId?: string
  selectedId?: string
  locationId?: string
  observation?: string
  segmentId?: string
  wirelessId?: string
}
export type DeviceData = {
  label: string
  kind: string
  ip: string
  location: string
  observation: string
  badge: ReturnType<typeof auditBadge>
  ports: { id: string; name: string }[]
  unknown?: boolean
  hiddenConnections: number
  pinned: boolean
}
export function groupBy<T>(items: T[], key: (item: T) => string | undefined) {
  const groups = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    if (k !== undefined) {
      const list = groups.get(k)
      if (list) {
        list.push(item)
      } else {
        groups.set(k, [item])
      }
    }
  }
  return groups
}
export function toGraph(doc: GraphDoc, siteId: string, options: GraphOptions = {}) {
  const layout =
    doc.layouts.find((l) => l.id === options.layoutId && l.siteId === siteId) ??
    doc.layouts.find((l) => l.siteId === siteId)
  const positions = { ...autoLayout(doc, siteId, layout), ...layout?.positions }
  const siteDevices = doc.devices.filter(
    (d) =>
      d.siteId === siteId &&
      !layout?.hidden.includes(d.id) &&
      (!layout?.deviceIds.length || layout.deviceIds.includes(d.id)),
  )
  const ids = new Set(siteDevices.map((d) => d.id))
  const links = doc.links.filter(
    (l) =>
      (!layout?.linkIds.length || layout.linkIds.includes(l.id)) &&
      [l.a, l.b].every((ep) => 'unknown' in ep || ids.has(ep.deviceId)) &&
      [l.a, l.b].some((ep) => 'deviceId' in ep && ids.has(ep.deviceId)),
  )
  const results = doc.auditResults.filter((r) => !options.roundId || r.roundId === options.roundId)
  // Index once: per-device scans over all ports × IPs took ~20s at 300 nodes.
  const portsById = new Map(doc.ports.map((p) => [p.id, p]))
  const portsByDevice = groupBy(doc.ports, (p) => p.deviceId)
  const ipsByDevice = groupBy(
    doc.ipAssignments.filter((a) => a.address),
    (a) => portsById.get(a.portId)?.deviceId,
  )
  const ipText = new Map(
    siteDevices.map((d) => [d.id, (ipsByDevice.get(d.id) ?? []).map((a) => a.address).join(' / ')]),
  )
  const ips = (deviceId: string) => ipText.get(deviceId) ?? ''
  const resultsByDevice = groupBy(results, (r) =>
    r.targetRef?.type === 'device'
      ? r.targetRef.id
      : r.targetRef?.type === 'port'
        ? portsById.get(r.targetRef.id)?.deviceId
        : undefined,
  )
  const badges = new Map(
    siteDevices.map((d) => [d.id, auditBadge(resultsByDevice.get(d.id) ?? [])]),
  )
  const deviceById = new Map(doc.devices.map((d) => [d.id, d]))
  const locationName = new Map(doc.locations.map((l) => [l.id, l.name]))
  const matched = new Set(
    siteDevices
      .filter((d) => {
        const search = [d.name, d.model, ips(d.id), locationName.get(d.locationId ?? '')]
          .join(' ')
          .toLowerCase()
        return (
          (!options.query || search.includes(options.query.toLowerCase())) &&
          (!options.kind || d.kind === options.kind) &&
          (!options.locationId || d.locationId === options.locationId) &&
          (!options.observation || d.observation === options.observation) &&
          (!options.segmentId ||
            (portsByDevice.get(d.id) ?? []).some((p) =>
              p.segmentIds?.includes(options.segmentId!),
            )) &&
          (!options.wirelessId ||
            doc.wirelessNetworks?.some(
              (w) => w.id === options.wirelessId && w.apDeviceIds.includes(d.id),
            )) &&
          (!options.judgment || badges.get(d.id)!.judgment === options.judgment)
        )
      })
      .map((d) => d.id),
  )
  const retained = new Set(matched)
  const neighbors = new Set<string>(options.selectedId ? [options.selectedId] : [])
  for (const l of links) {
    if ('deviceId' in l.a && 'deviceId' in l.b) {
      if (matched.has(l.a.deviceId)) {
        retained.add(l.b.deviceId)
      }
      if (matched.has(l.b.deviceId)) {
        retained.add(l.a.deviceId)
      }
      if (options.selectedId === l.a.deviceId) {
        neighbors.add(l.b.deviceId)
      }
      if (options.selectedId === l.b.deviceId) {
        neighbors.add(l.a.deviceId)
      }
    }
  }
  const nodes: Node<DeviceData | Record<string, unknown>>[] = []
  for (const d of siteDevices.filter((d) => retained.has(d.id))) {
    const p = positions[d.id]!
    const adjacent = links.filter((l) =>
      [l.a, l.b].some((e) => 'deviceId' in e && e.deviceId === d.id),
    )
    const hiddenConnections = adjacent.filter((l) =>
      [l.a, l.b].some((e) => 'deviceId' in e && !matched.has(e.deviceId)),
    ).length
    nodes.push({
      id: d.id,
      type: 'device',
      position: { x: p.x, y: p.y },
      width: 220,
      draggable: !p.pinned,
      style: `opacity:${!matched.has(d.id) || (options.selectedId && !neighbors.has(d.id)) ? 0.3 : 1}`,
      data: {
        label: d.name,
        kind: d.kind,
        ip: ips(d.id) || 'IP未確認',
        location: locationName.get(d.locationId ?? '') ?? '設置場所未確認',
        observation: d.observation,
        badge: badges.get(d.id)!,
        ports: (portsByDevice.get(d.id) ?? []).map((p) => ({ id: p.id, name: p.name })),
        hiddenConnections,
        pinned: p.pinned,
      },
    })
  }
  const edges: Edge[] = []
  for (const l of links) {
    if ([l.a, l.b].some((e) => 'deviceId' in e && !retained.has(e.deviceId))) {
      continue
    }
    const endpoint = (side: 'a' | 'b') => {
      const ep = l[side]
      if ('deviceId' in ep) {
        return ep.deviceId
      }
      const key = `unknown:${l.id}:${side}`
      if (layout?.hidden.includes(key)) {
        return null
      }
      const pos = positions[key] ?? { x: 0, y: 0, pinned: false }
      nodes.push({
        id: key,
        type: 'device',
        position: { x: pos.x, y: pos.y },
        width: 220,
        draggable: !pos.pinned,
        data: {
          label: ep.unknown,
          kind: 'unknown',
          ip: '不明端点',
          location: '',
          observation: 'unknown',
          badge: auditBadge([]),
          ports: [],
          unknown: true,
          hiddenConnections: 0,
          pinned: pos.pinned,
        },
      })
      return key
    }
    const source = endpoint('a')
    const target = endpoint('b')
    if (!source || !target) {
      continue
    }
    const uncertain = l.certainty !== 'confirmed' || 'unknown' in l.a || 'unknown' in l.b
    const portName = (side: 'a' | 'b') => {
      const ep = l[side]
      return 'deviceId' in ep ? (portsById.get(ep.portId ?? '')?.name ?? 'ポート未確認') : '不明'
    }
    const badge = auditBadge(
      results.filter((r) => r.targetRef?.type === 'link' && r.targetRef.id === l.id),
    )
    const aPortId = 'deviceId' in l.a ? l.a.portId : null
    const aPort = portsById.get(aPortId ?? '')
    const media = { copper: '銅線', fiber: '光', wireless: '無線', unknown: '媒体不明' }
    const networkLabel = l.segmentIds
      ?.map((id) => doc.segments?.find((s) => s.id === id)?.vlanId ?? '?')
      .join('/')
    const details = [
      l.speedMbps ? `${l.speedMbps}Mbps` : '',
      aPort ? media[aPort.medium] : '',
      networkLabel ? `VLAN ${networkLabel}` : '',
      badge.count ? badge.label : '',
    ].filter(Boolean)
    edges.push({
      id: l.id,
      source,
      target,
      sourceHandle: 'deviceId' in l.a ? (l.a.portId ?? 'device') : 'device',
      targetHandle: 'deviceId' in l.b ? (l.b.portId ?? 'device') : 'device',
      type: 'smoothstep',
      label: [`${uncertain ? '? ' : ''}${portName('a')} ↔ ${portName('b')}`, ...details].join(
        ' · ',
      ),
      style: `stroke:${badge.judgment === 'ng' ? '#dc4545' : l.kind === 'logical' ? '#8995a7' : '#507590'};stroke-width:${l.kind === 'wireless' ? 1 : 2};${uncertain || l.kind !== 'physical' ? `stroke-dasharray:${l.kind === 'wireless' ? '2 5' : '7 5'};` : ''}${options.selectedId && ![source, target].includes(options.selectedId) ? 'opacity:0.2;' : ''}`,
      animated: false,
    })
  }
  // Parent boxes are derived from absolute saved coordinates; drag results are converted back in the shell.
  const site = doc.sites.find((s) => s.id === siteId)
  const groups: Node<Record<string, unknown>>[] = []
  if (nodes.length && site) {
    const makeGroup = (id: string, label: string, children: typeof nodes) => {
      const x = Math.min(...children.map((n) => n.position.x)) - 30
      const y = Math.min(...children.map((n) => n.position.y)) - 45
      const width = Math.max(...children.map((n) => n.position.x + (n.width ?? 220))) - x + 30
      const height = Math.max(...children.map((n) => n.position.y + (n.height ?? 200))) - y + 25
      const group: Node<Record<string, unknown>> = {
        id,
        type: 'group',
        data: { label },
        position: { x, y },
        width,
        height,
        style: `width:${width}px;height:${height}px;background:#edf3f850;border:1px solid #b8cad9;border-radius:14px`,
        draggable: false,
        selectable: false,
        zIndex: -1,
      }
      for (const n of children) {
        n.parentId = id
        n.position = { x: n.position.x - x, y: n.position.y - y }
      }
      return group
    }
    if (layout?.groupByLocation !== false) {
      for (const location of doc.locations.filter((l) => l.siteId === siteId)) {
        const children = nodes.filter((n) => deviceById.get(n.id)?.locationId === location.id)
        if (children.length) {
          groups.push(makeGroup(`group:${location.id}`, location.name, children))
        }
      }
    }
    const rootChildren = [...groups, ...nodes.filter((n) => !n.parentId)]
    const siteGroup = makeGroup(`group:${site.id}`, site.name, rootChildren)
    return {
      nodes: [siteGroup, ...groups, ...nodes],
      edges,
      matchedCount: matched.size,
      matchedIds: [...matched],
    }
  }
  return { nodes, edges, matchedCount: matched.size, matchedIds: [...matched] }
}
