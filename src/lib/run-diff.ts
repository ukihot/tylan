import type { CollectionResult } from './collection-schema'

type Seen = { key: string; ip: string; mac: string | null; ports: string }
type Port = { protocol: string; port: number; state: string }

/** Devices by MAC when known, otherwise by IP. ARP and Nmap sightings of one MAC merge. */
function seen(result: CollectionResult) {
  const found = new Map<string, Seen & { open: Port[] }>()
  for (const o of result.observations) {
    if (o.type !== 'device' && o.type !== 'arp') {
      continue
    }
    const ip = String(o.value.ip ?? '')
    const mac = typeof o.value.mac === 'string' && o.value.mac ? o.value.mac.toLowerCase() : null
    const key = mac ?? `ip:${ip}`
    const open = (Array.isArray(o.value.ports) ? (o.value.ports as Port[]) : []).filter(
      (p) => p.state === 'open',
    )
    const entry = found.get(key) ?? { key, ip, mac, ports: '', open: [] }
    entry.open.push(...open)
    found.set(key, entry)
  }
  return new Map(
    [...found].map(([key, { open, ...entry }]) => [
      key,
      {
        ...entry,
        ports: [...new Set(open.map((p) => `${p.protocol}/${p.port}`))]
          .sort((x, y) => x.localeCompare(y, 'en', { numeric: true }))
          .join(', '),
      },
    ]),
  )
}

/**
 * Previous-run comparison. A device missing now is "not observed this time", never removed:
 * power, firewalls and observation limits all hide devices.
 */
export function compareRuns(previous: CollectionResult, current: CollectionResult) {
  const before = seen(previous)
  const after = seen(current)
  const changed = []
  for (const [key, now] of after) {
    const then = before.get(key)
    if (!then) {
      continue
    }
    const fields = [
      ...(then.ip !== now.ip ? (['IP', then.ip, now.ip] as const) : []),
      ...(then.ports !== now.ports ? (['開放ポート', then.ports, now.ports] as const) : []),
    ]
    if (fields.length) {
      const names = fields.filter((_, i) => i % 3 === 0)
      changed.push({
        key,
        ip: now.ip,
        fields: names,
        before: fields.filter((_, i) => i % 3 === 1).join(' / '),
        after: fields.filter((_, i) => i % 3 === 2).join(' / '),
      })
    }
  }
  const keys = new Set([...Object.keys(previous.profile), ...Object.keys(current.profile)])
  keys.delete('approvedPlanHash')
  const conditions = [...keys]
    .filter((k) => JSON.stringify(previous.profile[k]) !== JSON.stringify(current.profile[k]))
    .sort()
  if (JSON.stringify(previous.tools) !== JSON.stringify(current.tools)) {
    conditions.push('tools')
  }
  return {
    added: [...after.values()].filter((d) => !before.has(d.key)),
    changed,
    unobserved: [...before.values()].filter((d) => !after.has(d.key)),
    conditions,
  }
}
