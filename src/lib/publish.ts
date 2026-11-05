import { z } from 'zod'
import { APP_VERSION, type Doc, entitySchemas as e, type PublishSettings } from './schema'
import { validate } from './validate'

const PublicDevice = e.devices
  .pick({
    id: true,
    name: true,
    kind: true,
    model: true,
    siteId: true,
    locationId: true,
    observation: true,
  })
  .extend({
    serial: e.devices.shape.serial.optional(),
    owner: e.devices.shape.owner.optional(),
    administrator: e.devices.shape.administrator.optional(),
    supportContact: e.devices.shape.supportContact.optional(),
    notes: e.devices.shape.notes.optional(),
  })
const PublicSite = e.sites
  .pick({ id: true, name: true })
  .extend({ contact: e.sites.shape.contact.optional(), notes: e.sites.shape.notes.optional() })
const PublicLocation = e.locations
  .pick({ id: true, name: true, siteId: true, floor: true, room: true, rack: true })
  .extend({
    contact: e.locations.shape.contact.optional(),
    notes: e.locations.shape.notes.optional(),
  })
const PublicLink = e.links
  .pick({ id: true, a: true, b: true, kind: true, certainty: true, speedMbps: true })
  .extend({ notes: e.links.shape.notes.optional() })
const PublicAudit = z
  .strictObject(e.auditResults.shape)
  .pick({
    id: true,
    roundId: true,
    siteId: true,
    itemNo: true,
    scope: true,
    targetRef: true,
    judgment: true,
    checkedDate: true,
  })
  .extend({
    finding: e.auditResults.shape.finding.optional(),
    problem: e.auditResults.shape.problem.optional(),
  })
export const PublicDocSchema = z
  .strictObject({
    format: z.literal('tylan-public'),
    schemaVersion: z.literal(1),
    project: z.strictObject({
      name: z.string().min(1).max(100),
      revision: z.number().int().nonnegative(),
      surveyDate: z.iso.date().nullable(),
      appVersion: z.literal(APP_VERSION),
      generatedAt: z.string().max(40),
    }),
    sites: z.array(PublicSite).max(50),
    locations: z.array(PublicLocation).max(5000),
    devices: z.array(PublicDevice).max(5000),
    ports: z
      .array(e.ports.pick({ id: true, deviceId: true, name: true, medium: true, status: true }))
      .max(50000),
    links: z.array(PublicLink).max(10000),
    ipAssignments: z
      .array(e.ipAssignments.pick({ id: true, portId: true, address: true }))
      .max(50000),
    auditRounds: z.array(e.auditRounds.pick({ id: true, name: true, siteIds: true })).max(500),
    auditResults: z.array(PublicAudit).max(25000),
    layouts: z.array(e.layouts).max(500),
    evidence: z.array(e.evidence).max(25000).optional(),
    actionItems: z.array(e.actionItems).max(25000).optional(),
  })
  .superRefine((d, ctx) => {
    const sets = Object.fromEntries(
      ['sites', 'locations', 'devices', 'ports', 'links', 'auditRounds', 'auditResults'].map(
        (key) => [key, new Set((d[key as 'devices'] as { id: string }[]).map((e) => e.id))],
      ),
    ) as Record<string, Set<string>>
    const check = (collection: string, id: string | null, path: string) => {
      if (id && !sets[collection]?.has(id)) {
        ctx.addIssue({ code: 'custom', path: [path], message: '公開データに参照先がありません' })
      }
    }
    for (const l of d.locations) {
      check('sites', l.siteId, 'locations')
    }
    for (const dev of d.devices) {
      check('sites', dev.siteId, 'devices')
      check('locations', dev.locationId, 'devices')
    }
    for (const p of d.ports) {
      check('devices', p.deviceId, 'ports')
    }
    for (const l of d.links) {
      for (const ep of [l.a, l.b]) {
        if ('deviceId' in ep) {
          check('devices', ep.deviceId, 'links')
          check('ports', ep.portId, 'links')
        }
      }
    }
    for (const a of d.ipAssignments) {
      check('ports', a.portId, 'ipAssignments')
    }
    for (const r of d.auditRounds) {
      for (const id of r.siteIds) {
        check('sites', id, 'auditRounds')
      }
    }
    for (const r of d.auditResults) {
      check('sites', r.siteId, 'auditResults')
      check('auditRounds', r.roundId, 'auditResults')
      if (r.targetRef) {
        check(
          ({ device: 'devices', port: 'ports', link: 'links' } as Record<string, string>)[
            r.targetRef.type
          ] ?? '',
          r.targetRef.id,
          'auditResults',
        )
      }
    }
    for (const l of d.layouts) {
      check('sites', l.siteId, 'layouts')
      for (const id of l.deviceIds) {
        check('devices', id, 'layouts')
      }
      for (const id of l.linkIds) {
        check('links', id, 'layouts')
      }
      for (const id of [...Object.keys(l.positions), ...l.hidden]) {
        check(
          id.startsWith('unknown:') ? 'links' : 'devices',
          id.startsWith('unknown:') ? id.split(':')[1]! : id,
          'layouts',
        )
      }
    }
    for (const a of d.actionItems ?? []) {
      for (const id of a.auditResultIds) {
        check('auditResults', id, 'actionItems')
      }
      if (a.targetRef) {
        check(
          ({ device: 'devices', port: 'ports', link: 'links' } as Record<string, string>)[
            a.targetRef.type
          ] ?? '',
          a.targetRef.id,
          'actionItems',
        )
      }
    }
  })
export type PublicDoc = z.infer<typeof PublicDocSchema>

export function toPublic(doc: Doc, settings: PublishSettings, generatedAt: string): PublicDoc {
  if (validate(doc).errors.length) {
    throw new Error('検証エラーを修正してから公開してください')
  }
  const sites = doc.sites.filter((s) => settings.siteIds.includes(s.id))
  const siteIds = new Set(sites.map((s) => s.id))
  const devices = doc.devices.filter((d) => siteIds.has(d.siteId))
  const deviceIds = new Set(devices.map((d) => d.id))
  const ports = doc.ports.filter((p) => deviceIds.has(p.deviceId))
  const portIds = new Set(ports.map((p) => p.id))
  const links = doc.links.filter(
    (l) =>
      [l.a, l.b].every((ep) => 'unknown' in ep || deviceIds.has(ep.deviceId)) &&
      [l.a, l.b].some((ep) => 'deviceId' in ep && deviceIds.has(ep.deviceId)),
  )
  const linkIds = new Set(links.map((l) => l.id))
  const allowedTarget = (ref: Doc['auditResults'][number]['targetRef']) =>
    !ref ||
    ({ device: deviceIds, port: portIds, link: linkIds } as Record<string, Set<string>>)[
      ref.type
    ]?.has(ref.id) === true
  const auditResults = doc.auditResults.filter(
    (r) => siteIds.has(r.siteId) && allowedTarget(r.targetRef),
  )
  const auditIds = new Set(auditResults.map((r) => r.id))
  const positionAllowed = (id: string) =>
    deviceIds.has(id) || (id.startsWith('unknown:') && linkIds.has(id.split(':')[1]!))
  const fields = settings.fields
  const pub = {
    format: 'tylan-public' as const,
    schemaVersion: 1 as const,
    project: {
      name: doc.project.name,
      revision: doc.project.revision,
      surveyDate: doc.project.surveyDate,
      appVersion: APP_VERSION,
      generatedAt,
    },
    sites: sites.map((s) => ({
      id: s.id,
      name: s.name,
      ...(fields.contacts ? { contact: s.contact } : {}),
      ...(fields.notes ? { notes: s.notes } : {}),
    })),
    locations: doc.locations
      .filter((l) => siteIds.has(l.siteId))
      .map((l) => ({
        id: l.id,
        name: l.name,
        siteId: l.siteId,
        floor: l.floor,
        room: l.room,
        rack: l.rack,
        ...(fields.contacts ? { contact: l.contact } : {}),
        ...(fields.notes ? { notes: l.notes } : {}),
      })),
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      kind: d.kind,
      model: d.model,
      siteId: d.siteId,
      locationId: d.locationId,
      observation: d.observation,
      ...(fields.serial ? { serial: d.serial } : {}),
      ...(fields.contacts
        ? { owner: d.owner, administrator: d.administrator, supportContact: d.supportContact }
        : {}),
      ...(fields.notes ? { notes: d.notes } : {}),
    })),
    ports: ports.map((p) => ({
      id: p.id,
      deviceId: p.deviceId,
      name: p.name,
      medium: p.medium,
      status: p.status,
    })),
    links: links.map((l) => ({
      id: l.id,
      a: { ...l.a },
      b: { ...l.b },
      kind: l.kind,
      certainty: l.certainty,
      speedMbps: l.speedMbps,
      ...(fields.notes ? { notes: l.notes } : {}),
    })),
    ipAssignments: doc.ipAssignments
      .filter((a) => portIds.has(a.portId))
      .map((a) => ({ id: a.id, portId: a.portId, address: a.address })),
    auditRounds: doc.auditRounds
      .filter((r) => r.siteIds.some((id) => siteIds.has(id)))
      .map((r) => ({ id: r.id, name: r.name, siteIds: r.siteIds.filter((id) => siteIds.has(id)) })),
    auditResults: auditResults.map((r) => ({
      id: r.id,
      roundId: r.roundId,
      siteId: r.siteId,
      itemNo: r.itemNo,
      scope: r.scope,
      targetRef: r.targetRef ? { ...r.targetRef } : null,
      judgment: r.judgment,
      checkedDate: r.checkedDate,
      ...(fields.notes ? { finding: r.finding, problem: r.problem } : {}),
    })),
    layouts: doc.layouts
      .filter((l) => siteIds.has(l.siteId))
      .map((l) => ({
        id: l.id,
        name: l.name,
        siteId: l.siteId,
        deviceIds: l.deviceIds.filter((id) => deviceIds.has(id)),
        linkIds: l.linkIds.filter((id) => linkIds.has(id)),
        positions: Object.fromEntries(
          Object.entries(l.positions)
            .filter(([id]) => positionAllowed(id))
            .map(([id, pos]) => [id, { ...pos }]),
        ),
        hidden: l.hidden.filter(positionAllowed),
        groupByLocation: l.groupByLocation,
        viewport: { ...l.viewport },
      })),
    ...(fields.evidence
      ? {
          evidence: doc.evidence
            .filter((e) => auditResults.some((r) => r.evidenceIds.includes(e.id)))
            .map((e) => ({ ...e })),
        }
      : {}),
    ...(fields.actionItems
      ? {
          actionItems: doc.actionItems
            .filter(
              (a) => a.auditResultIds.some((id) => auditIds.has(id)) && allowedTarget(a.targetRef),
            )
            .map((a) => ({
              ...a,
              auditResultIds: a.auditResultIds.filter((id) => auditIds.has(id)),
              targetRef: a.targetRef ? { ...a.targetRef } : null,
            })),
        }
      : {}),
  }
  return PublicDocSchema.parse(pub)
}
export function serializeForHtml(value: unknown) {
  return JSON.stringify(value).replace(
    /[<>&\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}
export function createViewer(template: string, input: PublicDoc) {
  const data = PublicDocSchema.parse(input)
  const parts = template.split('/*TYLAN_DATA*/')
  if (parts.length !== 2) {
    throw new Error('閲覧用雛形の目印が不正です。アプリを再ビルドしてください')
  }
  const html = parts[0] + serializeForHtml(data) + parts[1]
  readPublicData(html)
  return html
}
export function readPublicData(html: string): PublicDoc {
  const match = html.match(/<script\b(?=[^>]*\bid="tylan-data")[^>]*>([\s\S]*?)<\/script>/i)
  if (!match) {
    throw new Error('公開データが見つかりません')
  }
  return PublicDocSchema.parse(JSON.parse(match[1]!))
}
