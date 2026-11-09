import { type CollectionResult, CollectionSchema } from './collection-schema'
import type { Folder } from './folder'

export type AuditReply = {
  accepted: boolean | null
  error?: string
  requestId?: string
  package?: { path: string; hash: string }
  inventory?: Inventory
  tools?: Record<string, string | null>
  proofJson?: string
  executionPlan?: {
    hash: string
    targets: string[]
    source: string
    routes: { prefix: string; ifIndex: number; nextHop: string; metric: number }[]
  }
}
export type Inventory = {
  adapters: {
    ifIndex: number
    guid: string
    name: string
    description: string
    mac: string
    status: string
    hardware: boolean
  }[]
  addresses: {
    ifIndex: number
    address: string
    prefixLength: number
    family: string
    state: string
  }[]
  routes: { prefix: string; ifIndex: number; nextHop: string; metric: number }[]
  ipv6?: { state: 'completed' | 'failed' | 'skipped'; reason: string | null }
}
export type RunState = {
  runId: string
  state: string
  stage: string
  reason?: string
  sequence: number
}
export type AuditProfile = {
  mode: 'standard' | 'passive' | 'detail' | 'offline'
  duration: number
  cidrs: string[]
  exclude: string[]
  source: string
  prefixLength: number
  ifIndex: number
  nicGuid: string
  ports: number[]
  features: Record<'arp' | 'dns' | 'dhcp' | 'ipv6Local' | 'discovery' | 'ports', boolean>
  siteId: string
  roundId: string
  documentId?: string
  approvedDhcp?: string[] | null
  expectedDns?: string[] | null
  approvedPlanHash?: string
  expectedGateway?: string[] | null
  dnsFailureRatio?: number | null
  detailEvidence?: { dnsNames: boolean; retentionDays: number }
  management?: {
    ad?: { server: string; searchBase: string }
    dhcpServers?: string[]
    windows?: string[]
  }
  switchExport?: unknown
}
export function createAuditClient(folder: Folder) {
  const endpoint = folder.audit
  if (!endpoint) {
    return null
  }
  const call = <T>(path: string, method = 'GET', body?: unknown) =>
    endpoint(method, path, body) as Promise<T>
  async function response(requestId: string, signal?: AbortSignal): Promise<AuditReply> {
    for (let attempt = 0; attempt < 260; attempt++) {
      if (signal?.aborted) {
        throw new Error('待機を中止しました。ジョブの停止は「監査を中止」で行ってください')
      }
      const reply = await call<AuditReply>(`audit/responses?id=${encodeURIComponent(requestId)}`)
      if (reply.accepted === false) {
        throw new Error(reply.error ?? '収集器が要求を拒否しました')
      }
      if (reply.accepted === true) {
        return reply
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error('受付・状態確認不能。新規実行せず、既存実行の状態を再確認してください')
  }
  return {
    call,
    response,
    start: (profile: AuditProfile, key: string) =>
      call<{ runId: string; requestId: string }>('audit/runs', 'POST', { profile, key }),
    state: (id: string) =>
      call<{ response: AuditReply; state: RunState | null }>(`audit/runs/${id}`),
    cancel: (id: string) => call<{ requestId: string }>(`audit/runs/${id}/cancel`, 'POST'),
    async result(id: string): Promise<CollectionResult> {
      return CollectionSchema.parse(await call(`audit/runs/${id}/result`))
    },
    async seal(id: string) {
      const reply = await call<{ requestId: string }>(`audit/runs/${id}/evidence`, 'POST')
      return response(reply.requestId)
    },
    async diagnose(includeIPv6: boolean) {
      const reply = await call<{ requestId: string }>('audit/diagnose', 'POST', { includeIPv6 })
      return response(reply.requestId)
    },
  }
}
