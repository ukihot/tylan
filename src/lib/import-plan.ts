import { inCidr, inRange } from './address'
import { type CollectionResult, CollectionSchema, sha256 } from './collection-schema'
import { type Doc, type EntityMap, type ImportBatch, newEntity } from './schema'
import { validate } from './validate'

export type Endpoint = EntityMap['links']['a']
type Kind = EntityMap['devices']['kind']

/** Phones and tablets randomize their Wi-Fi MAC per network: the locally administered bit is set. */
export const randomMac = (mac: string | null) =>
  !!mac && (Number.parseInt(mac.slice(0, 2), 16) & 2) === 2
const macOf = (value: unknown) =>
  typeof value === 'string' && /^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(value)
    ? value.toLowerCase().replaceAll('-', ':')
    : null
const ipOrder = (ip: string) => ip.split('.').reduce((n, octet) => n * 256 + Number(octet), 0)
const unique = <T>(values: T[]) => [...new Set(values)]

/**
 * The run's yardstick comes from the JSON's baseline only (one place to edit it).
 * null means 基準未設定: the collector then reports statistics, never "問題なし".
 */
export function baselineFor(doc: Doc, siteId: string) {
  const segments = doc.segments.filter((s) => s.siteId === siteId)
  const ids = new Set(segments.map((s) => s.id))
  const list = (values: (string | null)[]) => {
    const found = unique(values.filter((v): v is string => !!v))
    return found.length ? found : null
  }
  return {
    approvedDhcp: list(
      doc.dhcpScopes
        .filter((d) => ids.has(d.segmentId) && d.approval === 'approved')
        .map((d) => d.serverAddress),
    ),
    expectedDns: list(segments.flatMap((s) => s.dns)),
    expectedGateway: list(segments.map((s) => s.gateway)),
  }
}

// ponytail: port/MAC heuristic only; it suggests, the operator decides what is managed.
function guess(mac: string | null, openPorts: string[]) {
  const has = (...ports: number[]) => ports.some((p) => openPorts.includes(`${p}/tcp`))
  const as = (kind: Kind, label: string, managed: boolean) => ({ kind, label, managed })
  if (randomMac(mac)) {
    return as('other', 'スマホ・タブレット等（ランダムMAC）', false)
  }
  if (has(9100, 515, 631)) {
    return as('printer', 'プリンター・複合機', true)
  }
  if (has(554)) {
    return as('camera', 'カメラ・録画機（RTSP）', true)
  }
  if (has(135, 3389)) {
    return as('pc', 'Windows PC', false)
  }
  if (has(139, 445)) {
    return as('nas', 'NAS・ファイル共有', true)
  }
  if (has(53)) {
    return as('unknown', 'ルーター・DNS', true)
  }
  if (has(22, 23, 80, 443, 8080, 8443)) {
    return as('unknown', '管理画面あり（ネットワーク機器等）', true)
  }
  return as('unknown', '不明（開いているポートなし）', false)
}

/**
 * known: a managed device of the ledger (MAC, or a fixed IP).
 * rogue: hands out DHCP while an approved server is recorded.
 * unregistered: a fixed address (outside every DHCP pool, or reserved) missing from the ledger.
 * candidate: behaves like infrastructure (printer, camera, NAS, GW, DHCP/DNS, admin UI).
 * client: everything else. Counted, never registered: DHCP gives it another IP tomorrow.
 */
export type HostClass = 'known' | 'rogue' | 'unregistered' | 'candidate' | 'client'
export type HostRow = {
  key: string
  ip: string
  mac: string | null
  hostname: string | null
  vendor: string | null
  openPorts: string[]
  sources: string[]
  cidr: string | null
  class: HostClass
  why: string
  label: string
  kind: Kind
  deviceId: string | null
  /** in a DHCP pool; null when the baseline records no pool for the segment */
  inPool: boolean | null
}
export type BaselineRow = {
  key: string
  cidr: string
  field: 'gateway' | 'dns' | 'dhcp'
  expected: string[]
  observed: string[]
  state: 'match' | 'unset' | 'differs' | 'unobserved'
}
export type ClientSummary = {
  cidr: string
  total: number
  randomMac: number
  linkLocal: number
  vendors: { name: string; count: number }[]
}
export const fieldLabels = { gateway: 'デフォルトGW', dns: 'DNS', dhcp: 'DHCP配布元' } as const

/** One pure pass shared by the diff screen and the import, so both always agree. */
export function analyze(doc: Doc, result: CollectionResult, siteId: string) {
  const segments = doc.segments.filter((s) => s.siteId === siteId)
  const devices = doc.devices.filter((d) => d.siteId === siteId)
  const deviceIds = new Set(devices.map((d) => d.id))
  const ports = doc.ports.filter((p) => deviceIds.has(p.deviceId))
  const portDevice = new Map(ports.map((p) => [p.id, p.deviceId]))
  const byMac = new Map(
    ports.flatMap((p) => (macOf(p.mac) ? [[macOf(p.mac)!, p.deviceId] as const] : [])),
  )
  const scopes = doc.dhcpScopes.filter((d) => segments.some((s) => s.id === d.segmentId))
  const reserved = new Set(scopes.flatMap((s) => s.reservations.map((r) => macOf(r.mac))))
  const pools = scopes.filter((s) => s.ranges.length)
  const inPool = (ip: string) =>
    pools.some((s) => s.ranges.some((r) => inRange(ip, r))) &&
    !pools.some((s) => s.exclusions.some((r) => inRange(ip, r)))
  const poolOf = (ip: string) => {
    const segment = segments.find((s) => s.cidr && inCidr(ip, s.cidr))
    return segment && pools.some((p) => p.segmentId === segment.id) ? inPool(ip) : null
  }
  const byIp = new Map(
    doc.ipAssignments
      .filter((a) => a.address && portDevice.has(a.portId))
      .map((a) => [
        a.address!,
        {
          deviceId: portDevice.get(a.portId)!,
          mac: macOf(ports.find((p) => p.id === a.portId)?.mac),
          fixed: a.mode === 'static' || poolOf(a.address!) === false,
        },
      ]),
  )
  const profileCidrs = Array.isArray(result.profile.cidrs) ? result.profile.cidrs.map(String) : []
  const cidrs = profileCidrs.length
    ? profileCidrs
    : segments.flatMap((s) => (s.cidr && !s.cidr.includes(':') ? [s.cidr] : []))
  const cidrOf = (ip: string) => cidrs.find((c) => inCidr(ip, c)) ?? null
  const self = String(result.profile.source ?? '')
  const of = (type: string) => result.observations.filter((o) => o.type === type)
  const answers = of('dhcp').filter((o) => ['2', '5'].includes(String(o.value.message)))
  const host = of('hostConfiguration').find((o) =>
    (o.value.addresses as { address: string }[] | undefined)?.some((a) => a.address === self),
  )?.value as
    | {
        addresses: { ifIndex: number; address: string }[]
        routes: { prefix: string; ifIndex: number; nextHop: string }[]
        dns: { ifIndex: number; addresses: string[] }[]
      }
    | undefined
  const ifIndex = host?.addresses.find((a) => a.address === self)?.ifIndex
  const observedFor = (cidr: string) => {
    const mine = answers.filter((o) =>
      [o.value.offeredAddress, o.value.gateway, o.value.ip].some(
        (ip) => typeof ip === 'string' && inCidr(ip, cidr),
      ),
    )
    const local = !!self && inCidr(self, cidr)
    return {
      gateway: unique([
        ...mine.flatMap((o) => (typeof o.value.gateway === 'string' ? [o.value.gateway] : [])),
        ...(local
          ? (host?.routes ?? [])
              .filter((r) => r.prefix === '0.0.0.0/0' && r.ifIndex === ifIndex)
              .map((r) => r.nextHop)
          : []),
      ]),
      dns: unique([
        ...mine.flatMap((o) => (Array.isArray(o.value.dns) ? o.value.dns.map(String) : [])),
        ...(local
          ? (host?.dns.find((d) => d.ifIndex === ifIndex)?.addresses ?? []).filter((a) =>
              /^\d+\.\d+\.\d+\.\d+$/.test(a),
            )
          : []),
      ]),
      dhcp: unique(mine.map((o) => String(o.value.server))),
    }
  }
  const baseline: BaselineRow[] = []
  const approvedIn = new Map<string, string[]>()
  for (const cidr of cidrs) {
    const segment = segments.find((s) => s.cidr === cidr)
    const observed = observedFor(cidr)
    const expected = {
      gateway: segment?.gateway ? [segment.gateway] : [],
      dns: segment?.dns ?? [],
      dhcp: unique(
        scopes
          .filter((d) => d.segmentId === segment?.id && d.approval === 'approved')
          .flatMap((d) => (d.serverAddress ? [d.serverAddress] : [])),
      ),
    }
    approvedIn.set(cidr, expected.dhcp)
    for (const field of ['gateway', 'dns', 'dhcp'] as const) {
      const [e, o] = [expected[field], observed[field]]
      baseline.push({
        key: `baseline:${cidr}:${field}`,
        cidr,
        field,
        expected: e,
        observed: o,
        state: !o.length
          ? 'unobserved'
          : !e.length
            ? 'unset'
            : o.every((v) => e.includes(v))
              ? 'match'
              : 'differs',
      })
    }
  }
  const dhcpServers = new Set(answers.map((o) => String(o.value.server)))
  const roles = (ip: string) => {
    const cidr = cidrOf(ip)
    const seen = cidr ? observedFor(cidr) : { gateway: [], dns: [], dhcp: [] }
    return [
      ...(seen.gateway.includes(ip) ? ['デフォルトGW'] : []),
      ...(dhcpServers.has(ip) ? ['DHCP配布元'] : []),
      ...(seen.dns.includes(ip) ? ['DNSサーバー'] : []),
    ]
  }

  type Group = Omit<HostRow, 'class' | 'why' | 'label' | 'kind' | 'deviceId' | 'inPool'> & {
    last: string
  }
  const groups = new Map<string, Group>()
  for (const obs of result.observations) {
    if (obs.type !== 'device' && obs.type !== 'arp') {
      continue
    }
    const ip = String(obs.value.ip ?? '')
    if (!ip || ip === self) {
      continue
    }
    const mac = macOf(obs.value.mac)
    // DHCP renews can move one MAC to another IP within a run: the MAC is the identity.
    const key = `host:${mac ?? ip}`
    const row = groups.get(key) ?? {
      key,
      ip,
      mac,
      hostname: null,
      vendor: null,
      openPorts: [],
      sources: [],
      cidr: null,
      last: obs.observedAt,
    }
    if (obs.observedAt >= row.last) {
      row.ip = ip
      row.last = obs.observedAt
    }
    row.hostname ??=
      typeof obs.value.hostname === 'string' && obs.value.hostname ? obs.value.hostname : null
    row.vendor ??=
      typeof obs.value.vendor === 'string' && obs.value.vendor ? obs.value.vendor : null
    for (const p of (obs.value.ports as { port: number; protocol: string; state: string }[]) ??
      []) {
      const name = `${p.port}/${p.protocol}`
      if (p.state === 'open' && !row.openPorts.includes(name)) {
        row.openPorts.push(name)
      }
    }
    if (!row.sources.includes(obs.source)) {
      row.sources.push(obs.source)
    }
    groups.set(key, row)
  }
  const name = (id: string) => doc.devices.find((d) => d.id === id)?.name ?? id
  const hosts: HostRow[] = [...groups.values()].map(({ last: _last, ...g }) => {
    const row = { ...g, cidr: cidrOf(g.ip), inPool: poolOf(g.ip) }
    const sorted = row.openPorts.toSorted((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))
    const guessed = guess(row.mac, sorted)
    const as = (cls: HostClass, why: string, deviceId: string | null = null): HostRow => ({
      ...row,
      openPorts: sorted,
      class: cls,
      why,
      label: guessed.label,
      kind: guessed.kind,
      deviceId,
    })
    const byMacId = row.mac ? byMac.get(row.mac) : undefined
    if (byMacId) {
      return as('known', 'MACが台帳と一致', byMacId)
    }
    const recorded = byIp.get(row.ip)
    if (recorded?.fixed && recorded.mac && row.mac && recorded.mac !== row.mac) {
      return as(
        'unregistered',
        `台帳の「${name(recorded.deviceId)}」の固定IPを別のMACが使用（機器交換・IP重複の可能性）`,
      )
    }
    if (recorded?.fixed) {
      return as('known', '固定IPが台帳と一致（MACは未登録）', recorded.deviceId)
    }
    const approved = row.cidr ? (approvedIn.get(row.cidr) ?? []) : []
    if (dhcpServers.has(row.ip) && approved.length && !approved.includes(row.ip)) {
      return as('rogue', '承認されていないDHCP配布元')
    }
    if (row.mac && reserved.has(row.mac)) {
      return as('unregistered', 'DHCP予約があるのに台帳にない')
    }
    const role = roles(row.ip)
    if (row.inPool === false && !randomMac(row.mac)) {
      const what = role.length ? `（${role.join('・')}）` : ''
      return as('unregistered', `DHCP範囲外の固定IPなのに台帳にない${what}`)
    }
    if (role.length) {
      return as('candidate', role.join('・'))
    }
    if (guessed.managed) {
      return as('candidate', guessed.label)
    }
    return as('client', guessed.label)
  })
  hosts.sort((a, b) => ipOrder(a.ip) - ipOrder(b.ip))

  const clients: ClientSummary[] = []
  for (const cidr of cidrs) {
    const list = hosts.filter(
      (h) => h.class === 'client' && (h.cidr === cidr || (!h.cidr && cidr === cidrs[0])),
    )
    if (!list.length) {
      continue
    }
    const vendors = new Map<string, number>()
    for (const h of list) {
      const vendor = h.vendor ?? (randomMac(h.mac) ? 'ランダムMAC' : 'メーカー不明')
      vendors.set(vendor, (vendors.get(vendor) ?? 0) + 1)
    }
    clients.push({
      cidr,
      total: list.length,
      randomMac: list.filter((h) => randomMac(h.mac)).length,
      linkLocal: list.filter((h) => h.ip.startsWith('169.254.')).length,
      vendors: [...vendors]
        .map(([vendor, count]) => ({ name: vendor.slice(0, 100), count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
        .slice(0, 30),
    })
  }
  const seenIds = new Set(hosts.flatMap((h) => (h.deviceId ? [h.deviceId] : [])))
  const unseen = devices.filter(
    (d) =>
      d.usage !== 'retired' &&
      !seenIds.has(d.id) &&
      doc.ipAssignments.some(
        (a) => a.address && portDevice.get(a.portId) === d.id && cidrOf(a.address),
      ),
  )
  return {
    hosts,
    baseline,
    clients,
    unseen,
    cidrs,
    poolsKnown: pools.length > 0,
    adComputers: of('adComputer').length,
  }
}
export type Analysis = ReturnType<typeof analyze>

const endKey = (end: Endpoint) =>
  'unknown' in end ? `unknown:${end.unknown}` : `${end.deviceId}:${end.portId ?? '-'}`
const linkKey = (kind: string, a: Endpoint, b: Endpoint) =>
  `${kind}:${[endKey(a), endKey(b)].sort().join('|')}`
const maskBits = (mask: string) =>
  mask.split('.').reduce((n, octet) => n + Number(octet).toString(2).replaceAll('0', '').length, 0)
function leaseOf(seconds: unknown): EntityMap['dhcpScopes']['lease'] {
  if (typeof seconds !== 'number' || seconds <= 0) {
    return null
  }
  if (seconds % 86400 === 0) {
    return { value: seconds / 86400, unit: 'days' }
  }
  if (seconds % 3600 === 0) {
    return { value: seconds / 3600, unit: 'hours' }
  }
  return { value: Math.ceil(seconds / 60), unit: 'minutes' }
}

export type ImportOptions = {
  siteId: string
  roundId: string
  /** row keys from analyze(): host:…, baseline:…, finding ids, switch and DHCP-scope observation ids */
  selected: string[]
  /** device kind chosen by the operator for a new managed device */
  kinds?: Record<string, Kind>
  /** switch candidate id → both endpoints chosen by the operator; never inferred */
  links?: Record<string, { a: Endpoint; b: Endpoint }>
  checkedBy: string
  now: string
  packageHash: string
  storageLocation: string
}

export async function planImport(original: Doc, input: unknown, options: ImportOptions) {
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > 10 * 1024 * 1024) {
    throw new Error('収集結果は10MiB以下にしてください')
  }
  const result: CollectionResult = CollectionSchema.parse(input)
  if (
    !/^[a-f0-9]{64}$/.test(options.packageHash) ||
    !options.storageLocation ||
    !options.checkedBy.trim()
  ) {
    throw new Error('検証済み証跡と確認者が必要です')
  }
  const doc = structuredClone(original)
  if (!doc.sites.some((s) => s.id === options.siteId)) {
    throw new Error('対象拠点を選んでください')
  }
  const round = doc.auditRounds.find(
    (r) => r.id === options.roundId && r.siteIds.includes(options.siteId),
  )
  if (!round) {
    throw new Error('監査回次を選んでください')
  }
  const selected = unique(options.selected).sort()
  const kinds = Object.entries(options.kinds ?? {})
    .filter(([key]) => selected.includes(key))
    .sort()
  const links = Object.entries(options.links ?? {}).sort()
  const selectionHash = await sha256(
    JSON.stringify([selected, ...(kinds.length ? [kinds] : []), ...(links.length ? [links] : [])]),
  )
  const seed = `${doc.documentId}:${result.runId}`
  const identity = async (prefix: string, key: string) =>
    `${prefix}_${(await sha256(`${seed}:${key}`)).slice(0, 16)}`
  // Re-adopting after Undo is a new operation: the reverted record stays, entity ids stay stable.
  const generation = doc.importBatches.filter(
    (b) => b.runId === result.runId && b.selectionHash === selectionHash && b.state === 'reverted',
  ).length
  const importId = await identity(
    'imp',
    generation ? `${selectionHash}:${generation}` : selectionHash,
  )
  const existing = doc.importBatches.find((b) => b.id === importId)
  if (
    existing &&
    (existing.runId !== result.runId ||
      existing.selectionHash !== selectionHash ||
      existing.packageHash !== options.packageHash)
  ) {
    throw new Error('同じ取り込みIDの内容が違います（run・選択・証跡を確認してください）')
  }
  if (existing?.state === 'applied') {
    return { doc, importId, selectionHash, conflicts: [] as string[] }
  }
  const batch: ImportBatch = {
    id: importId,
    runId: result.runId,
    packageHash: options.packageHash,
    selectionHash,
    state: 'applied',
    bindings: [],
    evidenceIds: [],
    intentReference: null,
    checkedBy: options.checkedBy,
    appliedAt: options.now,
  }
  const evidenceId = await identity('evd', options.packageHash)
  if (!doc.evidence.some((e) => e.id === evidenceId)) {
    doc.evidence.push({
      ...newEntity('evidence', evidenceId),
      description: `自動監査 ${result.runId}`.slice(0, 100),
      referenceNumber: options.packageHash,
      storageLocation: options.storageLocation,
      acquiredDate: result.endedAt.slice(0, 10),
      acquiredBy: options.checkedBy,
    })
  }
  batch.evidenceIds = [evidenceId]
  const conflicts: string[] = []
  const today = options.now.slice(0, 10)
  const analysis = analyze(original, result, options.siteId)
  /** A first audit of a site has no segments yet: the scanned CIDR becomes one. */
  const segmentFor = async (cidr: string) => {
    const known = doc.segments.find((s) => s.siteId === options.siteId && s.cidr === cidr)
    if (known) {
      return known
    }
    const made = {
      ...newEntity('segments', await identity('seg', `${options.siteId}:${cidr}`)),
      siteId: options.siteId,
      name: cidr,
      cidr,
    }
    doc.segments.push(made)
    return made
  }
  const prior = (bindingKey: string) =>
    doc.importBatches
      .filter((b) => b.state === 'applied')
      .flatMap((b) => b.bindings)
      .find((b) => b.key === bindingKey)
  const bind = async (
    key: string,
    collection: ImportBatch['bindings'][number]['collection'],
    entityId: string,
    value: unknown,
  ) =>
    batch.bindings.push({
      key,
      collection,
      entityId,
      valueHash: await sha256(JSON.stringify(value)),
    })

  for (const row of analysis.baseline) {
    if (!selected.includes(row.key) || row.state !== 'unset') {
      continue
    }
    const segment = await segmentFor(row.cidr)
    if (row.field === 'gateway') {
      segment.gateway ??= row.observed[0] ?? null
    } else if (row.field === 'dns') {
      segment.dns = segment.dns.length ? segment.dns : row.observed.slice(0, 100)
    } else {
      for (const server of row.observed) {
        const scopeId = await identity('dhc', `${row.cidr}:${server}:baseline`)
        if (!doc.dhcpScopes.some((d) => d.id === scopeId)) {
          doc.dhcpScopes.push({
            ...newEntity('dhcpScopes', scopeId),
            segmentId: segment.id,
            serverUnknown: `DHCP ${server}（自動監査で観測）`.slice(0, 100),
            serverAddress: server,
            approval: 'approved',
          })
        }
      }
    }
    await bind(`${result.runId}:${row.key}`, 'segments', segment.id, row.observed)
  }

  for (const row of analysis.hosts) {
    if (!selected.includes(row.key) || row.class === 'client') {
      continue
    }
    const bindingKey = `${result.runId}:${row.key}:device`
    const known = prior(bindingKey)
    if (known) {
      if (!doc.devices.some((d) => d.id === known.entityId)) {
        throw new Error('採用先が削除されています。再照合してください')
      }
      batch.bindings.push(known)
      continue
    }
    if (row.class === 'known') {
      const device = doc.devices.find((d) => d.id === row.deviceId)!
      device.observation = 'observed'
      device.lastCheckedDate = today
      // A device registered by hand from its IP learns its MAC: the next run matches by MAC.
      const port = doc.ports.find(
        (p) =>
          p.deviceId === device.id &&
          !p.mac &&
          doc.ipAssignments.some((a) => a.portId === p.id && a.address === row.ip),
      )
      if (port && row.mac && !doc.ports.some((p) => macOf(p.mac) === row.mac)) {
        port.mac = row.mac
      }
      await bind(bindingKey, 'devices', device.id, row)
      continue
    }
    if (!row.cidr) {
      throw new Error(`観測IP ${row.ip} は調査範囲の外です。セグメントを確認してください`)
    }
    const segment = await segmentFor(row.cidr)
    const deviceId = await identity('dev', `${row.key}:device`)
    if (!doc.devices.some((d) => d.id === deviceId)) {
      doc.devices.push({
        ...newEntity('devices', deviceId),
        name: (row.hostname || `${row.vendor ?? row.label}（${row.mac ?? row.ip}）`).slice(0, 100),
        kind: options.kinds?.[row.key] ?? row.kind,
        manufacturer: row.vendor,
        siteId: options.siteId,
        approval: row.class === 'rogue' ? 'unapproved' : 'unknown',
        observation: 'observed',
        lastCheckedDate: today,
        notes:
          `自動監査 ${result.runId}：${row.why}。推定 ${row.label}（開いているポート ${row.openPorts.join(', ') || 'なし'}）。要確認`.slice(
            0,
            2000,
          ),
      })
      const portId = await identity('prt', `${row.key}:interface`)
      doc.ports.push({
        ...newEntity('ports', portId),
        deviceId,
        name: '観測IF（名称未確認）',
        mac: row.mac,
        segmentIds: [segment.id],
        observedAt: options.now,
      })
      doc.ipAssignments.push({
        ...newEntity('ipAssignments', await identity('ip', `${row.key}:address`)),
        portId,
        segmentId: segment.id,
        address: row.ip,
        mode: row.inPool === false ? 'static' : row.inPool ? 'dhcp' : 'unknown',
        observation: 'observed',
      })
    }
    await bind(bindingKey, 'devices', deviceId, row)
  }

  // Clients are always recorded as counts: that is the whole client inventory.
  for (const summary of analysis.clients) {
    const segment = await segmentFor(summary.cidr)
    const { cidr: _cidr, ...counts } = summary
    round.clients = [
      ...round.clients.filter((c) => !(c.runId === result.runId && c.segmentId === segment.id)),
      {
        segmentId: segment.id,
        runId: result.runId,
        observedDate: result.endedAt.slice(0, 10),
        ...counts,
      },
    ]
  }

  for (const key of selected) {
    const obs = result.observations.find((o) => o.id === key)
    const v = obs?.value ?? {}
    if (obs?.type === 'physicalCandidate') {
      const bindingKey = `${result.runId}:${obs.id}:link`
      const known = prior(bindingKey)
      if (known) {
        if (!doc.links.some((l) => l.id === known.entityId)) {
          throw new Error('採用先の接続が削除されています。再照合してください')
        }
        batch.bindings.push(known)
        continue
      }
      const mapping = options.links?.[obs.id]
      if (!mapping) {
        throw new Error('接続候補の両端の対応付けを選択してください（物理配線は推測で作りません）')
      }
      for (const end of [mapping.a, mapping.b]) {
        if (
          'deviceId' in end &&
          !doc.devices.some((d) => d.id === end.deviceId && d.siteId === options.siteId)
        ) {
          throw new Error('対応付けた機器がこの拠点にありません')
        }
      }
      // MAC tables can hide hubs: they never become a physical cable.
      const kind = v.linkKind === 'physical' ? 'physical' : 'logical'
      const same = doc.links.find(
        (l) => linkKey(l.kind, l.a, l.b) === linkKey(kind, mapping.a, mapping.b),
      )
      const linkId = same?.id ?? (await identity('lnk', `${obs.id}:link`))
      if (!same) {
        doc.links.push({
          ...newEntity('links', linkId),
          a: mapping.a,
          b: mapping.b,
          kind,
          certainty: 'estimated',
          notes:
            `${String(v.protocol).toUpperCase()} ${String(v.localDevice)} ${String(v.localPort)} ↔ ${String(v.remoteDevice)} ${String(v.remotePort ?? '-')}（${String(v.vendor)}のエクスポート）`.slice(
              0,
              2000,
            ),
        })
      }
      await bind(bindingKey, 'links', linkId, v)
    } else if (obs?.type === 'dhcpScope') {
      const bindingKey = `${result.runId}:${obs.id}:dhcpScope`
      const known = prior(bindingKey)
      if (known) {
        batch.bindings.push(known)
        continue
      }
      const cidr = `${String(v.scopeId)}/${maskBits(String(v.subnetMask))}`
      const target = doc.segments.find((s) => s.siteId === options.siteId && s.cidr === cidr)
      if (!target) {
        conflicts.push(`DHCPスコープ${cidr}に対応するセグメントがありません`)
        continue
      }
      if (doc.dhcpScopes.some((s) => s.segmentId === target.id && s.ranges.length)) {
        conflicts.push(`DHCPスコープ${cidr}は記録済みです。手入力値を上書きしません`)
        continue
      }
      const option = (n: number) =>
        ((v.options as { optionId: number; values: string[] }[]) ?? []).find(
          (o) => o.optionId === n,
        )?.values ?? []
      const scopeId = await identity('dhc', `${obs.id}:scope`)
      const server = String(v.server)
      doc.dhcpScopes.push({
        ...newEntity('dhcpScopes', scopeId),
        segmentId: target.id,
        serverUnknown: `DHCP ${server}（管理情報から取得）`.slice(0, 100),
        serverAddress: /^\d+\.\d+\.\d+\.\d+$/.test(server) ? server : null,
        ranges: [{ start: String(v.start), end: String(v.end) }],
        exclusions: (v.exclusions as { start: string; end: string }[]) ?? [],
        reservations: ((v.reservations as { address: string; clientId: string }[]) ?? [])
          .filter((r) => macOf(r.clientId))
          .map((r) => ({ address: r.address, mac: macOf(r.clientId)! })),
        lease: leaseOf(v.leaseSeconds),
        dns: option(6),
        gateway: option(3)[0] ?? null,
        approval: 'approved',
      })
      await bind(bindingKey, 'dhcpScopes', scopeId, v)
    }
  }

  for (const finding of result.findings.filter((f) => selected.includes(f.id))) {
    const bindingKey = `${result.runId}:${finding.id}:audit`
    const known = prior(bindingKey)
    if (known) {
      batch.bindings.push(known)
      continue
    }
    const audit = doc.auditResults.find(
      (a) =>
        a.roundId === round.id &&
        a.siteId === options.siteId &&
        a.itemNo === finding.itemNo &&
        a.scope === 'summary',
    )
    if (audit?.judgment !== 'unchecked') {
      conflicts.push(`No.${finding.itemNo}は判定済みのため下書きを書き込みませんでした`)
      continue
    }
    audit.finding = finding.reason
    audit.attempted = true
    audit.reason =
      finding.status === 'inconclusive'
        ? finding.reason
        : '自動監査の下書き。確認者による最終判定が必要です'
    audit.nextCheck = finding.nextCheck || '管理設定と現地確認で確定してください'
    audit.method = `自動監査 ${result.runId}`
    audit.evidenceIds = unique([...audit.evidenceIds, evidenceId])
    if (finding.status === 'finding') {
      const actionId = await identity('act', `${finding.id}:followup`)
      if (!doc.actionItems.some((a) => a.id === actionId)) {
        doc.actionItems.push({
          ...newEntity('actionItems', actionId),
          content: finding.reason,
          auditResultIds: [audit.id],
        })
      }
      audit.actionItemIds = unique([...audit.actionItemIds, actionId])
    }
    await bind(bindingKey, 'auditResults', audit.id, finding)
  }
  doc.importBatches = [...doc.importBatches.filter((b) => b.id !== importId), batch]
  const validation = validate(doc)
  if (validation.errors.length) {
    throw new Error(validation.errors.map((i) => `${i.path}: ${i.message}`).join('\n'))
  }
  return { doc, importId, selectionHash, conflicts }
}
