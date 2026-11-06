import { z } from 'zod'

function boundedJson(value: unknown, depth = 0, count = { value: 0 }): boolean {
  if (++count.value > 150000 || depth > 12) {
    return false
  }
  if (typeof value === 'string') {
    return value.length <= 10000
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }
  if (value === null || typeof value === 'boolean') {
    return true
  }
  if (Array.isArray(value)) {
    return value.length <= 100000 && value.every((v) => boundedJson(v, depth + 1, count))
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).every(
      ([key, v]) =>
        !['__proto__', 'prototype', 'constructor'].includes(key) &&
        key.length <= 100 &&
        boundedJson(v, depth + 1, count),
    )
  }
  return false
}
const jsonObject = z
  .record(z.string().max(100), z.unknown())
  .refine((v) => boundedJson(v), '過大または不正な観測値です')
export const ObservationSchema = z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  type: z.enum([
    'device',
    'arp',
    'dns',
    'dhcp',
    'hostConfiguration',
    'ipv6Configuration',
    'adComputer',
    'dhcpScope',
    'physicalCandidate',
  ]),
  source: z.string().min(1).max(100),
  segment: z.string().max(100),
  observedAt: z.iso.datetime({ offset: true }),
  value: jsonObject,
})
export const FindingSchema = z.strictObject({
  id: z.string().min(1).max(100),
  itemNo: z.number().int().min(1).max(23),
  status: z.enum(['finding', 'inconclusive', 'noFindingInScope', 'notApplicable']),
  reason: z.string().min(1).max(2000),
  nextCheck: z.string().max(2000),
  observationIds: z.array(z.string().max(100)).max(100000),
})
export const CollectionSchema = z
  .strictObject({
    format: z.literal('tylan-collection'),
    schemaVersion: z.literal(1),
    runId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
    profile: jsonObject,
    tools: jsonObject,
    scope: jsonObject,
    startedAt: z.iso.datetime({ offset: true }),
    endedAt: z.iso.datetime({ offset: true }),
    collectors: z.array(jsonObject).max(100),
    observations: z.array(ObservationSchema).max(100000),
    findings: z.array(FindingSchema).max(100000),
  })
  .superRefine((result, ctx) => {
    const ids = new Set<string>()
    for (const observation of result.observations) {
      if (ids.has(observation.id)) {
        ctx.addIssue({ code: 'custom', message: '観測IDが重複しています' })
      }
      ids.add(observation.id)
    }
  })
export type CollectionResult = z.infer<typeof CollectionSchema>
export type Observation = z.infer<typeof ObservationSchema>
export async function sha256(text: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}
