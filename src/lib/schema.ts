import { z } from 'zod'
import { ipNumber, parseCidr } from './address'
import { AUDIT_MASTER } from './audit-master'

export const APP_VERSION = '0.1.0'
export const MAX_BYTES = 10 * 1024 * 1024
export const prefixes = {
  sites: 'sit',
  locations: 'loc',
  devices: 'dev',
  ports: 'prt',
  links: 'lnk',
  segments: 'seg',
  ipAssignments: 'ip',
  dhcpScopes: 'dhc',
  wirelessNetworks: 'wln',
  auditRounds: 'rnd',
  auditResults: 'aud',
  evidence: 'evd',
  actionItems: 'act',
  layouts: 'lay',
} as const
export type Collection = keyof typeof prefixes
const id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[a-zA-Z0-9]{16}$`), 'IDの種類・形式が不正です')
const ref = (collection: Collection) => id(prefixes[collection]).meta({ ref: collection })
const name = z.string().trim().min(1, '名称を入力してください').max(100)
const text = z.string().min(1).max(2000).nullable()
const short = z.string().min(1).max(100).nullable()
const date = z.iso.date().nullable()
const timestamp = z.iso
  .datetime({ offset: true, precision: 0 })
  .refine((v) => /\+09:00$/.test(v), '日本時間のISO日時を指定してください')
const ip = z.string().refine((v) => ipNumber(v) !== null, 'IPアドレスの形式が不正です')
const ips = z.array(ip).max(100)
const refs = (c: Collection) => z.array(ref(c)).max(25000)
const observation = z.enum(['unknown', 'observed', 'notObserved'])
const approval = z.enum(['unknown', 'approved', 'unapproved'])
const endpoint = z.union([
  z.strictObject({ deviceId: ref('devices'), portId: ref('ports').nullable() }),
  z.strictObject({ unknown: name }),
])
const target = z.strictObject({
  type: z.enum(['device', 'link', 'wirelessNetwork', 'segment', 'port']),
  id: z.string().regex(/^(dev|lnk|wln|seg|prt)_[a-zA-Z0-9]{16}$/),
})
const range = z.strictObject({ start: ip, end: ip })
const count = z.number().int().min(0).max(100000)
export const AuditItemSchema = z.strictObject({
  no: z.number().int().min(1).max(23),
  category: name,
  title: name,
  content: z.string().min(1).max(2000),
  method: z.string().min(1).max(2000),
})
export const entitySchemas = {
  sites: z.strictObject({ id: id('sit'), name, contact: short, notes: text }),
  locations: z.strictObject({
    id: id('loc'),
    siteId: ref('sites'),
    name,
    floor: short,
    room: short,
    rack: short,
    contact: short,
    notes: text,
  }),
  devices: z.strictObject({
    id: id('dev'),
    name,
    assetNumber: short,
    kind: z.enum([
      'unknown',
      'serviceAdapter',
      'switch',
      'ap',
      'repeater',
      'pc',
      'printer',
      'nas',
      'camera',
      'attendance',
      'iot',
      'other',
    ]),
    manufacturer: short,
    model: short,
    serial: short,
    siteId: ref('sites'),
    locationId: ref('locations').nullable(),
    owner: short,
    administrator: short,
    supportContact: short,
    manageable: z.enum(['unknown', 'yes', 'no']),
    approval,
    usage: z.enum(['unknown', 'active', 'unused', 'retired']),
    observation,
    lampStatus: short,
    lastCheckedDate: date,
    notes: text,
  }),
  ports: z.strictObject({
    id: id('prt'),
    deviceId: ref('devices'),
    name,
    kind: short,
    medium: z.enum(['unknown', 'copper', 'fiber', 'wireless']),
    speedMbps: z.number().positive().max(1e9).nullable(),
    adminStatus: z.enum(['unknown', 'enabled', 'disabled']),
    status: z.enum(['unknown', 'used', 'free']),
    purpose: text,
    mac: z
      .string()
      .regex(/^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i)
      .nullable(),
    segmentIds: refs('segments'),
    observedAt: timestamp.nullable(),
  }),
  links: z.strictObject({
    id: id('lnk'),
    a: endpoint,
    b: endpoint,
    kind: z.enum(['physical', 'wireless', 'logical']),
    cableId: short,
    speedMbps: z.number().positive().max(1e9).nullable(),
    segmentIds: refs('segments'),
    certainty: z.enum(['unknown', 'confirmed', 'estimated']),
    lastCheckedDate: date,
    notes: text,
  }),
  segments: z.strictObject({
    id: id('seg'),
    siteId: ref('sites'),
    name,
    cidr: z
      .string()
      .refine((v) => parseCidr(v) !== null, 'CIDRの形式が不正です')
      .nullable(),
    vlanId: z.number().int().min(1).max(4094).nullable(),
    gateway: ip.nullable(),
    dns: ips,
    purpose: text,
  }),
  ipAssignments: z.strictObject({
    id: id('ip'),
    portId: ref('ports'),
    segmentId: ref('segments'),
    address: ip.nullable(),
    prefixLength: z.number().int().min(0).max(128).nullable(),
    mode: z.enum(['unknown', 'static', 'dhcp']),
    observation,
  }),
  dhcpScopes: z.strictObject({
    id: id('dhc'),
    segmentId: ref('segments'),
    serverDeviceId: ref('devices').nullable(),
    serverUnknown: short,
    /** the approved server's IPv4 as seen on the wire (DHCP server identifier) */
    serverAddress: ip.nullable(),
    ranges: z.array(range).max(100),
    exclusions: z.array(range).max(100),
    reservations: z
      .array(
        z.strictObject({
          address: ip,
          mac: z.string().regex(/^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i),
        }),
      )
      .max(5000),
    lease: z
      .strictObject({
        value: z.number().positive().max(1e9),
        unit: z.enum(['minutes', 'hours', 'days']),
      })
      .nullable(),
    dns: ips,
    gateway: ip.nullable(),
    approval,
  }),
  wirelessNetworks: z.strictObject({
    id: id('wln'),
    siteId: ref('sites'),
    ssid: name,
    purpose: text,
    apDeviceIds: refs('devices'),
    segmentIds: refs('segments'),
    authentication: z.enum([
      'unknown',
      'open',
      'wpa2-aes',
      'wpa3',
      'wpa2-wpa3',
      'enterprise',
      'other',
    ]),
    passwordManagement: z.enum(['unknown', 'managed', 'unmanaged', 'na']),
    guestIsolation: z.enum(['unknown', 'enabled', 'disabled', 'na']),
    isolationFinding: text,
    radioFinding: text,
  }),
  auditRounds: z.strictObject({
    id: id('rnd'),
    name,
    siteIds: refs('sites').min(1),
    startDate: date,
    endDate: date,
    surveyor: short,
    /** DHCP clients are counted, never registered: their IPs change daily. One row per run and segment. */
    clients: z
      .array(
        z.strictObject({
          segmentId: ref('segments'),
          runId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
          observedDate: z.iso.date(),
          total: count,
          randomMac: count,
          linkLocal: count,
          vendors: z.array(z.strictObject({ name, count })).max(30),
        }),
      )
      .max(200),
  }),
  auditResults: z
    .strictObject({
      id: id('aud'),
      roundId: ref('auditRounds'),
      siteId: ref('sites'),
      itemNo: z.number().int().min(1).max(23),
      scope: z.enum(['summary', 'target']),
      targetRef: target.nullable(),
      judgment: z.enum(['unchecked', 'ok', 'ng', 'na']),
      finding: text,
      problem: text,
      checkedBy: short,
      checkedDate: date,
      attempted: z.boolean(),
      reason: text,
      nextCheck: text,
      method: text,
      recheckDate: date,
      evidenceIds: refs('evidence'),
      actionItemIds: refs('actionItems'),
    })
    .superRefine((v, ctx) => {
      const require = (key: keyof typeof v) => {
        if (!v[key] || (Array.isArray(v[key]) && v[key].length === 0)) {
          ctx.addIssue({ code: 'custom', path: [key], message: 'この判定では入力が必要です' })
        }
      }
      if (v.judgment !== 'unchecked') {
        require('checkedBy')
        require('checkedDate')
      }
      if (v.judgment === 'ok' || v.judgment === 'ng') {
        require('finding')
      }
      if (v.judgment === 'ng') {
        require('problem')
        require('actionItemIds')
      }
      if (v.judgment === 'na' || (v.judgment === 'unchecked' && v.attempted)) {
        require('reason')
      }
      if (v.judgment === 'unchecked' && v.attempted) {
        require('nextCheck')
      }
      if (v.scope === 'target' && !v.targetRef) {
        require('targetRef')
      }
      if (v.scope === 'summary' && v.targetRef) {
        ctx.addIssue({
          code: 'custom',
          path: ['targetRef'],
          message: '総括には対象を指定できません',
        })
      }
    }),
  evidence: z.strictObject({
    id: id('evd'),
    description: name,
    referenceNumber: short,
    storageLocation: text,
    acquiredDate: date,
    acquiredBy: short,
  }),
  actionItems: z
    .strictObject({
      id: id('act'),
      auditResultIds: refs('auditResults'),
      targetRef: target.nullable(),
      content: z.string().min(1).max(2000),
      priority: z.enum(['medium', 'high', 'low']),
      assignee: short,
      dueDate: date,
      progress: z.enum(['todo', 'inProgress', 'review', 'done', 'onHold']),
      completionRecord: text,
      recheckRecord: text,
    })
    .superRefine((v, ctx) => {
      if (v.progress === 'done' && !v.completionRecord) {
        ctx.addIssue({
          code: 'custom',
          path: ['completionRecord'],
          message: '完了記録を入力してください',
        })
      }
    }),
  layouts: z.strictObject({
    id: id('lay'),
    name,
    siteId: ref('sites'),
    deviceIds: refs('devices'),
    linkIds: refs('links'),
    positions: z
      .record(
        z.string().regex(/^(dev_[a-zA-Z0-9]{16}|unknown:lnk_[a-zA-Z0-9]{16}:[ab])$/),
        z.strictObject({
          x: z.number().finite().min(-1e7).max(1e7),
          y: z.number().finite().min(-1e7).max(1e7),
          pinned: z.boolean(),
        }),
      )
      .refine((v) => Object.keys(v).length <= 10000),
    hidden: z.array(z.string().max(100)).max(10000),
    groupByLocation: z.boolean(),
    viewport: z.strictObject({
      x: z.number().finite(),
      y: z.number().finite(),
      zoom: z.number().min(0.05).max(5),
    }),
  }),
}
export type EntityMap = { [K in Collection]: z.infer<(typeof entitySchemas)[K]> }
export const PublishSettingsSchema = z.strictObject({
  siteIds: refs('sites'),
  fields: z.strictObject({
    serial: z.boolean().optional(),
    contacts: z.boolean().optional(),
    notes: z.boolean().optional(),
    evidence: z.boolean().optional(),
    actionItems: z.boolean().optional(),
  }),
})
export const ProjectSchema = z.strictObject({
  id: id('prj'),
  name,
  description: text,
  revision: z.number().int().nonnegative(),
  baseRevision: z.number().int().nonnegative(),
  appVersion: name,
  createdAt: timestamp,
  updatedAt: timestamp,
  updatedBy: short,
  surveyDate: date,
})
export const ImportBatchSchema = z.strictObject({
  id: id('imp'),
  runId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  packageHash: z.string().regex(/^[a-f0-9]{64}$/),
  selectionHash: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['applied', 'reverted']),
  bindings: z
    .array(
      z.strictObject({
        key: z.string().min(1).max(250),
        collection: z.enum(Object.keys(prefixes) as [Collection, ...Collection[]]),
        entityId: z.string().regex(/^[a-z]+_[a-zA-Z0-9]{16}$/),
        valueHash: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(10000),
  evidenceIds: refs('evidence'),
  intentReference: text,
  checkedBy: name,
  appliedAt: timestamp,
})
export type ImportBatch = z.infer<typeof ImportBatchSchema>
export const DocSchema = z
  .strictObject({
    format: z.literal('tylan'),
    schemaVersion: z.literal(3),
    documentId: id('doc'),
    importBatches: z.array(ImportBatchSchema).max(5000),
    project: ProjectSchema,
    sites: z.array(entitySchemas.sites).max(50),
    locations: z.array(entitySchemas.locations).max(5000),
    devices: z.array(entitySchemas.devices).max(5000),
    ports: z.array(entitySchemas.ports).max(50000),
    links: z.array(entitySchemas.links).max(10000),
    segments: z.array(entitySchemas.segments).max(5000),
    ipAssignments: z.array(entitySchemas.ipAssignments).max(50000),
    dhcpScopes: z.array(entitySchemas.dhcpScopes).max(5000),
    wirelessNetworks: z.array(entitySchemas.wirelessNetworks).max(5000),
    auditTemplate: z.strictObject({ version: name, items: z.array(AuditItemSchema).length(20) }),
    auditRounds: z.array(entitySchemas.auditRounds).max(500),
    auditResults: z.array(entitySchemas.auditResults).max(25000),
    evidence: z.array(entitySchemas.evidence).max(25000),
    actionItems: z.array(entitySchemas.actionItems).max(25000),
    layouts: z.array(entitySchemas.layouts).max(500),
    publishSettings: PublishSettingsSchema,
  })
  .superRefine((doc, ctx) => {
    const ids = new Set<string>()
    for (const batch of doc.importBatches) {
      if (ids.has(batch.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['importBatches'],
          message: '取り込みIDが重複しています',
        })
      }
      ids.add(batch.id)
    }
  })
export type Doc = z.infer<typeof DocSchema>
export type PublishSettings = z.infer<typeof PublishSettingsSchema>

// Draft generation is intentionally separate from validation: missing fields in input are rejected.
export function schemaSeed(schema: z.ZodType): unknown {
  if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional) {
    return null
  }
  if (schema instanceof z.ZodObject) {
    return Object.fromEntries(
      Object.entries(schema.shape).map(([key, s]) => [key, schemaSeed(s as z.ZodType)]),
    )
  }
  if (schema instanceof z.ZodUnion) {
    return schemaSeed(schema.options[0] as z.ZodType)
  }
  if (schema instanceof z.ZodArray) {
    return []
  }
  if (schema instanceof z.ZodRecord) {
    return {}
  }
  if (schema instanceof z.ZodEnum) {
    return schema.options[0]
  }
  if (schema instanceof z.ZodBoolean) {
    return false
  }
  if (schema instanceof z.ZodNumber) {
    return 1
  }
  return ''
}
export function newEntity<K extends Collection>(collection: K, entityId: string): EntityMap[K] {
  const value = {
    ...(schemaSeed(entitySchemas[collection]) as object),
    id: entityId,
  } as EntityMap[K]
  if (collection === 'layouts') {
    Object.assign(value, { groupByLocation: true, viewport: { x: 0, y: 0, zoom: 1 } })
  }
  if (collection === 'dhcpScopes') {
    Object.assign(value, { serverUnknown: '配布元未確認' })
  }
  return value
}
export function emptyDoc(now: string, projectId: string): Doc {
  return {
    format: 'tylan',
    schemaVersion: 3,
    // Derived from the random project id: one per document, new again when a file is copied.
    documentId: `doc_${projectId.slice(4)}`,
    importBatches: [],
    project: {
      id: projectId,
      name: '新規プロジェクト',
      description: null,
      revision: 0,
      baseRevision: 0,
      appVersion: APP_VERSION,
      createdAt: now,
      updatedAt: now,
      updatedBy: null,
      surveyDate: now.slice(0, 10),
    },
    sites: [],
    locations: [],
    devices: [],
    ports: [],
    links: [],
    segments: [],
    ipAssignments: [],
    dhcpScopes: [],
    wirelessNetworks: [],
    auditTemplate: { version: '2026-11', items: structuredClone(AUDIT_MASTER) },
    auditRounds: [],
    auditResults: [],
    evidence: [],
    actionItems: [],
    layouts: [],
    publishSettings: { siteIds: [], fields: {} },
  }
}
