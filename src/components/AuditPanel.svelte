<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import {
    type AuditProfile,
    createAuditClient,
    type Inventory,
    type RunState,
  } from '../lib/audit-client'
  import type { CollectionResult } from '../lib/collection-schema'
  import type { FileSession } from '../lib/file-session.svelte'
  import type { Folder } from '../lib/folder'
  import {
    candidates,
    type Endpoint,
    groupDevices,
    migrateV2,
    planImport,
  } from '../lib/import-plan'
  import { parseDocument, prepareExport } from '../lib/io'
  import { createId, nowJst } from '../lib/platform'
  import { compareRuns } from '../lib/run-diff'
  import type { Doc } from '../lib/schema'
  import type { Workspace } from '../lib/store.svelte'
  import Topology from './Topology.svelte'

  let {
    workspace,
    files,
    folder,
    visible = true,
  }: { workspace: Workspace; files: FileSession; folder: Folder; visible?: boolean } = $props()
  const client = untrack(() => createAuditClient(folder))
  const doc = $derived(workspace.doc)
  let profile = $state<AuditProfile>({
    mode: 'standard',
    duration: 300,
    cidrs: [],
    exclude: [],
    source: '',
    prefixLength: 24,
    ifIndex: 0,
    nicGuid: '',
    siteId: '',
    roundId: '',
    ports: [22, 53, 80, 135, 139, 443, 445, 515, 631, 3389, 5985, 5986, 8080, 8443, 9100],
    features: { arp: true, dns: true, dhcp: true, discovery: true, ports: true, ipv6Local: true },
  })
  const featureLabels = [
    ['discovery', 'IPv4機器探索'],
    ['ports', 'IPv4指定TCPポート監査'],
    ['arp', 'IPv4 ARP監査'],
    ['dns', 'IPv4 DNS監査'],
    ['dhcp', 'IPv4 DHCP監査'],
    ['ipv6Local', 'IPv6ローカル設定確認（送信なし）'],
  ] as const
  let inventory = $state<Inventory | null>(null)
  let profiles = $state<{ id: string; name: string; profile: AuditProfile }[]>([])
  let profileName = $state('現地標準')
  let ranges = $state('')
  let exclusions = $state('')
  let portText = $state(untrack(() => profile.ports.join(',')))
  let dhcpText = $state('')
  let dnsText = $state('')
  let gatewayText = $state('')
  let ratioText = $state('')
  let keepDnsNames = $state(false)
  let retentionDays = $state(90)
  let adServer = $state('')
  let adBase = $state('')
  let dhcpServers = $state('')
  let windowsTargets = $state('')
  let switchFile = $state<File | null>(null)
  type LinkDraft = { aDevice: string; aPort: string; bDevice: string; bPort: string }
  let linkDrafts = $state<Record<string, LinkDraft>>({})
  let segmentId = $state('')
  let checkedBy = $state('')
  /** The one foreground job, named so the screen can say what it is waiting for. */
  let busyLabel = $state('')
  const busy = $derived(busyLabel !== '')
  let now = $state(Date.now() / 1000)
  const ADOPT_STEPS = [
    '正本の保存を確認',
    '証跡の転送・封印',
    '採用計画の作成',
    '証跡・採用意図の準備',
    '証跡の再検証',
    '正本へ保存',
    '保存結果の照合',
  ]
  let adoptStep = $state(-1)
  let adoptFailed = $state(false)
  let message = $state('')
  let error = $state('')
  let missingTools = $state<string[]>([])
  let optionalTools = $state<string[]>([])
  let runId = $state('')
  let runState = $state<RunState | null>(null)
  let result = $state<CollectionResult | null>(null)
  let selected = $state<Record<string, boolean>>({})
  let mappings = $state<Record<string, string>>({})
  let preview = $state<Doc | null>(null)
  let past = $state<RunState[]>([])
  let previous = $state<CollectionResult | null>(null)
  let executionPlan = $state<{
    hash: string
    targets: string[]
    source: string
    routes: { prefix: string; ifIndex: number; nextHop: string; metric: number }[]
  } | null>(null)
  let plannedDocumentId = createId('doc')
  let polling = false
  const stateLabels: Record<string, string> = {
    queued: '待機中',
    running: '実行中',
    cancelling: '停止中',
    completed: '完了',
    partial: '部分完了',
    failed: '失敗',
    cancelled: '取消',
    interrupted: '中断',
    rejected: '受付拒否',
  }
  const collectorLabels: Record<string, string> = {
    completed: '完了',
    failed: '失敗',
    skipped: '未実施',
    timedOut: '期限で途中終了',
    cancelled: '取消で途中終了',
    truncated: '容量上限で打ち切り',
    partial: '一部のみ',
  }
  const active = $derived(
    runId !== '' &&
      !['completed', 'partial', 'failed', 'cancelled', 'interrupted', 'rejected'].includes(
        runState?.state ?? '',
      ),
  )
  const deviceRows = $derived(groupDevices(result?.observations ?? []))
  const linkObservations = $derived(
    result?.observations.filter((o) => o.type === 'physicalCandidate') ?? [],
  )
  const managementObservations = $derived(
    result?.observations.filter((o) => o.type === 'adComputer' || o.type === 'dhcpScope') ?? [],
  )
  const incomplete = $derived(result?.collectors.some((c) => c.state !== 'completed') ?? false)
  const diff = $derived(previous && result ? compareRuns(previous, result) : null)
  const siteDevices = $derived(doc.devices.filter((d) => d.siteId === profile.siteId))
  const ipv6Status = $derived.by(() => {
    const status = inventory?.ipv6
    if (!status) {
      return ''
    }
    if (status.state === 'completed') {
      const count = inventory!.addresses.filter((a) => a.family === 'IPv6').length
      return `IPv6設定を読取確認しました（アドレス${count}件・送信なし）`
    }
    if (status.state === 'skipped') {
      return 'IPv6ローカル設定確認はOFFです。IPv6設定未確認（IPv6経路なしとは判断しません）'
    }
    return `IPv6設定未確認：${status.reason ?? '取得失敗'}（IPv6経路なしとは判断しません）`
  })
  const selectedKeys = $derived(Object.keys(selected).filter((key) => selected[key]))
  const addressChoices = $derived(
    inventory?.addresses.filter(
      (a) =>
        a.family === 'IPv4' &&
        inventory?.adapters.some((n) => n.ifIndex === a.ifIndex && n.status === 'Up'),
    ) ?? [],
  )
  const split = (text: string) =>
    text
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  const errorText = (value: unknown) => (value instanceof Error ? value.message : String(value))
  type Step = { name: string; status: 'done' | 'current' | 'pending' | 'skipped' | 'failed' }
  const RUN_STEPS: Record<string, string> = {
    validating: '設定確認',
    observing: '通信観測',
    scanning: '機器探索・ポート',
    management: '管理情報',
    finalizing: '最終化',
  }
  const clock = (seconds: number) =>
    `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
  /** Stages actually reached are done; stages never reached by a finished run were skipped. */
  const runSteps = $derived.by((): Step[] => {
    const state = runState?.state
    const accepted = runState !== null && state !== 'rejected'
    const visited = runState?.stages ?? []
    const steps: Step[] = [
      { name: '受付', status: state === 'rejected' ? 'failed' : accepted ? 'done' : 'current' },
    ]
    for (const [key, name] of Object.entries(RUN_STEPS)) {
      const here = runState?.stage === key
      steps.push({
        name,
        status:
          active && accepted && here
            ? 'current'
            : !active && here && state !== 'completed' && state !== 'partial'
              ? 'failed'
              : visited.includes(key)
                ? 'done'
                : active || !accepted
                  ? 'pending'
                  : 'skipped',
      })
    }
    return steps
  })
  const stageName = $derived(runState ? (RUN_STEPS[runState.stage] ?? runState.stage) : '受付待ち')
  /** Counted work, a time window, or unknown length (an indeterminate bar). */
  const runMeter = $derived.by(() => {
    const progress = runState?.progress
    const label = `${stageName}の進捗`
    if (progress && 'total' in progress) {
      const unit = runState!.stage === 'scanning' ? 'バッチ' : '件'
      return {
        label,
        value: progress.done,
        max: progress.total,
        text: `${progress.done} / ${progress.total} ${unit}`,
      }
    }
    if (progress && 'endsAt' in progress) {
      const max = Math.max(1, Math.round(progress.endsAt - progress.startedAt))
      const value = Math.min(max, Math.max(0, now - progress.startedAt))
      return {
        label,
        value,
        max,
        text: `経過 ${clock(value)} / ${clock(max)}（残り約 ${clock(max - value)}）`,
      }
    }
    return {
      label,
      value: null,
      max: null,
      text: runState
        ? `${stageName}を処理中`
        : '収集器の受付を確認中（まだ実行中とは判定していません）',
    }
  })
  const adoptView = $derived(
    ADOPT_STEPS.map(
      (name, index): Step => ({
        name,
        status:
          index < adoptStep
            ? 'done'
            : index > adoptStep
              ? 'pending'
              : adoptFailed
                ? 'failed'
                : 'current',
      }),
    ),
  )
  /** What the floating chip says while the panel is off screen. */
  const jobLabel = $derived(
    files.auditBusy && adoptStep >= 0 && adoptStep < ADOPT_STEPS.length
      ? `取り込み：${ADOPT_STEPS[adoptStep]}`
      : active
        ? `${runState ? (stateLabels[runState.state] ?? runState.state) : '受付待ち'}：${stageName}`
        : busyLabel
          ? `${busyLabel}中`
          : '',
  )

  onMount(() => {
    profile.siteId = doc.sites[0]?.id ?? ''
    profile.roundId = doc.auditRounds.at(-1)?.id ?? ''
    segmentId = doc.segments.find((s) => s.siteId === profile.siteId)?.id ?? ''
    checkedBy = doc.project.updatedBy ?? ''
    plannedDocumentId = doc.documentId ?? plannedDocumentId
    if (client) {
      void initialize()
    }
    const timer = setInterval(() => {
      now = Date.now() / 1000
      if (active && !polling) {
        void poll()
      }
    }, 1000)
    return () => clearInterval(timer)
  })
  async function initialize() {
    try {
      const audit = (await folder.info()).audit
      missingTools = audit?.missing ?? []
      optionalTools = audit?.optional ?? []
      profiles = await client!.call('audit/profiles')
      past = await client!.call('audit/past')
      const runs = await client!.call<{ runId: string }[]>('audit/runs')
      if (runs.length) {
        runId = runs.at(-1)!.runId
        await poll()
      }
    } catch (e) {
      error = errorText(e)
    }
  }
  function applyProfile(value: AuditProfile) {
    profile = structuredClone(value)
    ranges = value.cidrs.join(', ')
    exclusions = value.exclude.join(', ')
    portText = value.ports.join(',')
    dhcpText = value.approvedDhcp?.join(', ') ?? ''
    dnsText = value.expectedDns?.join(', ') ?? ''
    gatewayText = value.expectedGateway?.join(', ') ?? ''
    ratioText = value.dnsFailureRatio == null ? '' : String(value.dnsFailureRatio)
    keepDnsNames = value.detailEvidence?.dnsNames ?? false
    retentionDays = value.detailEvidence?.retentionDays ?? 90
    adServer = value.management?.ad?.server ?? ''
    adBase = value.management?.ad?.searchBase ?? ''
    dhcpServers = value.management?.dhcpServers?.join(', ') ?? ''
    windowsTargets = value.management?.windows?.join(', ') ?? ''
  }
  function currentProfile(): AuditProfile {
    const { management: _management, detailEvidence: _detail, ...base } = $state.snapshot(profile)
    const management = {
      ...(adServer.trim() ? { ad: { server: adServer.trim(), searchBase: adBase.trim() } } : {}),
      ...(split(dhcpServers).length ? { dhcpServers: split(dhcpServers) } : {}),
      ...(split(windowsTargets).length ? { windows: split(windowsTargets) } : {}),
    }
    return {
      ...base,
      cidrs: split(ranges),
      exclude: split(exclusions),
      ports: split(portText).map(Number),
      approvedDhcp: dhcpText.trim() ? split(dhcpText) : null,
      expectedDns: dnsText.trim() ? split(dnsText) : null,
      expectedGateway: gatewayText.trim() ? split(gatewayText) : null,
      dnsFailureRatio: ratioText.trim() ? Number(ratioText) : null,
      ...(keepDnsNames ? { detailEvidence: { dnsNames: true, retentionDays } } : {}),
      ...(profile.mode === 'detail' && Object.keys(management).length ? { management } : {}),
      ...(doc.documentId ? { documentId: doc.documentId } : {}),
    }
  }
  function selectNic(key: string) {
    const choice = addressChoices.find((a) => `${a.ifIndex}:${a.address}` === key)
    const nic = inventory?.adapters.find((n) => n.ifIndex === choice?.ifIndex)
    if (!choice || !nic) {
      return
    }
    Object.assign(profile, {
      ifIndex: choice.ifIndex,
      source: choice.address,
      prefixLength: choice.prefixLength,
      nicGuid: nic.guid,
    })
    const bytes = choice.address.split('.').map(Number)
    const value = bytes.reduce((n, b) => (n << 8n) + BigInt(b), 0n)
    const hostBits = BigInt(32 - choice.prefixLength)
    const network = (value >> hostBits) << hostBits
    ranges =
      [24n, 16n, 8n, 0n].map((shift) => Number((network >> shift) & 255n)).join('.') +
      `/${choice.prefixLength}`
    delete profile.approvedPlanHash
  }
  async function action(label: string, work: () => Promise<void>) {
    if (busy) {
      return
    }
    busyLabel = label
    error = ''
    message = ''
    try {
      await work()
    } catch (e) {
      error = errorText(e)
    } finally {
      busyLabel = ''
    }
  }
  async function diagnose() {
    const reply = await client!.diagnose(profile.features.ipv6Local)
    if (!reply.inventory) {
      throw new Error('ホスト設定を取得できません')
    }
    inventory = reply.inventory
    message = 'ホスト設定を取得しました。送信元NIC・対象・除外を確認してください。'
  }
  function resetRun() {
    result = null
    preview = null
    selected = {}
    mappings = {}
    linkDrafts = {}
    runState = null
  }
  async function start() {
    resetRun()
    const started = await client!.start(currentProfile(), createId('run'))
    runId = started.runId
    message = '依頼済み・受付未確認。まだ実行中とは判定していません。'
    await poll()
  }
  async function importSwitch() {
    const text = await switchFile!.text()
    if (new TextEncoder().encode(text).byteLength > 1024 * 1024) {
      throw new Error('スイッチ情報は1MiB以下にしてください')
    }
    let switchExport: unknown
    try {
      switchExport = JSON.parse(text)
    } catch {
      throw new Error('スイッチ情報をJSONとして読めません')
    }
    resetRun()
    const started = await client!.start(
      { mode: 'offline', siteId: profile.siteId, switchExport } as AuditProfile,
      createId('run'),
    )
    runId = started.runId
    message = '取り込み依頼済み・受付未確認。'
    await poll()
  }
  const draft = (id: string): LinkDraft =>
    linkDrafts[id] ?? { aDevice: '', aPort: '', bDevice: '', bPort: '' }
  function setDraft(id: string, change: Partial<LinkDraft>) {
    linkDrafts[id] = { ...draft(id), ...change }
  }
  /** Only operator-chosen endpoints become links; an unmapped far end stays an unknown label. */
  function linkMappings() {
    const links: Record<string, { a: Endpoint; b: Endpoint }> = {}
    for (const obs of linkObservations) {
      const chosen = linkDrafts[obs.id]
      if (!selected[obs.id] || !chosen?.aDevice) {
        continue
      }
      links[obs.id] = {
        a: { deviceId: chosen.aDevice, portId: chosen.aPort || null },
        b: chosen.bDevice
          ? { deviceId: chosen.bDevice, portId: chosen.bPort || null }
          : { unknown: String(obs.value.remoteDevice).slice(0, 100) },
      }
    }
    return links
  }
  async function poll() {
    if (!client || !runId || polling) {
      return
    }
    polling = true
    try {
      const state = await client.state(runId)
      if (state.response.accepted === false) {
        const reason = state.response.error ?? '要求が拒否されました'
        // Refused requests never run: end the display instead of waiting for a run forever.
        runState = { runId, state: 'rejected', stage: '受付拒否', reason, sequence: 0 }
        throw new Error(reason)
      }
      runState = state.state
      if (runState?.runId) {
        runId = runState.runId
      }
      if (
        runState &&
        ['completed', 'partial', 'cancelled', 'interrupted'].includes(runState.state) &&
        !result
      ) {
        try {
          result = await client.result(runId)
          message = '収集結果を取得しました。正本には未採用です。'
        } catch (e) {
          if (runState.state === 'completed') {
            throw e
          }
        }
      }
    } catch (e) {
      error = errorText(e)
    } finally {
      polling = false
    }
  }
  async function openPast(id: string) {
    await client!.call('audit/open', 'POST', { runId: id })
    runId = id
    resetRun()
    await poll()
  }
  async function plan(hash: string, location: string) {
    if (!result || !selectedKeys.length) {
      throw new Error('採用する候補を選択してください')
    }
    return planImport(doc, $state.snapshot(result), {
      documentId: doc.documentId ?? plannedDocumentId,
      siteId: profile.siteId,
      segmentId,
      roundId: profile.roundId || null,
      selected: selectedKeys,
      mappings: $state.snapshot(mappings),
      links: linkMappings(),
      checkedBy: checkedBy || 'プレビュー',
      now: nowJst(),
      packageHash: hash,
      storageLocation: location,
    })
  }
  async function waitImport(id: string) {
    for (let n = 0; n < 260; n++) {
      const status = await client!.call<{ response: { accepted: boolean | null; error?: string } }>(
        `imports/${id}`,
      )
      if (status.response.accepted === false) {
        throw new Error(status.response.error ?? '証跡処理失敗')
      }
      if (status.response.accepted === true) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    throw new Error('採用準備の状態確認不能。正本を再照合してください')
  }
  async function adopt() {
    if (!checkedBy.trim()) {
      throw new Error('確認者を入力してください')
    }
    adoptStep = 0
    adoptFailed = false
    try {
      await adoptSteps()
      adoptStep = ADOPT_STEPS.length
    } catch (e) {
      adoptFailed = true
      throw e
    }
  }
  async function adoptSteps() {
    if (doc.schemaVersion === 1) {
      const migrated = migrateV2(doc, plannedDocumentId)
      if (!workspace.commit((draft) => Object.assign(draft, migrated))) {
        throw new Error('v2へ移行できません')
      }
    }
    const target = await files.beginImport()
    let importId = ''
    let commitAttempted = false
    try {
      adoptStep = 1
      const sealed = await client!.seal(runId)
      if (!sealed.package) {
        throw new Error('証跡を転送・検証できませんでした。正本の採用を中止しました')
      }
      adoptStep = 2
      const prepared = await plan(sealed.package.hash, sealed.package.path)
      importId = prepared.importId
      if (JSON.stringify(prepared.doc) === JSON.stringify(doc)) {
        message = '同じ結果は採用済みです。重複を作成しません。'
        return
      }
      const output = prepareExport(prepared.doc, nowJst(), checkedBy)
      adoptStep = 3
      await client!.call('imports/prepare', 'POST', {
        importId,
        path: target.path,
        expect: target.expect,
        siteId: profile.siteId,
        text: output.text,
      })
      await waitImport(importId)
      adoptStep = 4
      await client!.call(`imports/${importId}/verify`, 'POST')
      await waitImport(importId)
      adoptStep = 5
      commitAttempted = true
      const saved = await client!.call<{ text: string; lastModified: string }>(
        `imports/${importId}/commit`,
        'POST',
      )
      files.completeImport(parseDocument(saved.text), importId, saved.lastModified)
      message = `選択した結果を保存しました。監査判定は下書きです。${prepared.conflicts.join('。')}`
      preview = null
    } catch (e) {
      if (importId && commitAttempted) {
        adoptStep = 6
        try {
          const status = await client!.call<{ state: string; text: string; lastModified: string }>(
            `imports/${importId}/reconcile`,
          )
          if (status.state === 'applied') {
            files.completeImport(parseDocument(status.text), importId, status.lastModified)
            message = '正本を照合し、採用済みであることを確認しました。再取り込みは行っていません。'
            return
          }
        } catch {
          files.importUnknown()
        }
      }
      throw e
    } finally {
      files.endImport()
    }
  }
</script>

{#snippet stepper(label: string, steps: Step[])}
  <ol class="steps" aria-label={label}>
    {#each steps as step}
      <li class={step.status} aria-current={step.status === 'current' ? 'step' : undefined}>
        {step.name}
      </li>
    {/each}
  </ol>
{/snippet}
{#snippet meter(label: string, value: number | null, max: number | null, text: string)}
  <div class="meter">
    {#if value === null}
      <progress aria-label={label}></progress>
    {:else}
      <progress aria-label={label} {value} {max}></progress>
    {/if}
    <span>{text}</span>
  </div>
{/snippet}
{#if !visible}
  {#if jobLabel}
    <a class="job-chip" href="#/audit">
      <strong>現地監査</strong>
      <span>{jobLabel}</span>
      {#if active}
        {@render meter(runMeter.label, runMeter.value, runMeter.max, runMeter.text)}
      {:else}
        {@render meter(jobLabel, null, null, '')}
      {/if}
    </a>
  {/if}
{:else}
  <section class="panel audit-panel" aria-label="現地LAN自動監査">
    <div class="section-head">
      <div>
        <h2>現地LANを調べる</h2>
      </div>
    </div>
    <p>通信監査はIPv4のみ。観測した範囲・時間を記録し、未観測を問題なしにはしません。</p>
    <p class="muted">IPv6キャプチャ・能動探索は初期版では未対応です。</p>
    {#if !client}
      <p>監査用の起動プログラムが接続されていません。通常の台帳編集は利用できます。</p>
    {:else}
      {#if missingTools.length}
        <div role="alert" class="error">
          監査に必要なソフトがこのPCに見つかりません：{missingTools.join('、')}。導入してから
          tylan.cmd を起動し直してください。不足したままの収集は「失敗」「未実施」になります。
        </div>
      {/if}
      {#if optionalTools.length}
        <p class="muted">
          未導入（なしでも監査できます）：{optionalTools.join('、')}
          。通信観測（ARP/DNS/DHCP）は未実施として記録されます。
        </p>
      {/if}
      {#if error}
        <div role="alert" class="error">{error}</div>
      {/if}
      {#if message}
        <p role="status">{message}</p>
      {/if}
      {#if busyLabel}
        <div class="busy" aria-live="polite">
          {@render meter(busyLabel, null, null, `${busyLabel}中…`)}
        </div>
      {/if}
      <fieldset
        disabled={busy || active || files.auditBusy}
        oninput={(e) => {
          if ((e.target as HTMLInputElement).name !== 'routeApproval') {
            delete profile.approvedPlanHash
            executionPlan = null
          }
        }}
      >
        <legend>実行条件</legend>
        <div class="audit-options">
          <label>
            拠点<select bind:value={profile.siteId}>
              {#each doc.sites as site}
                <option value={site.id}>{site.name}</option>
              {/each}
            </select>
          </label>
          <label>
            監査回次<select bind:value={profile.roundId}>
              <option value="">機器収集のみ</option>
              {#each doc.auditRounds as round}
                <option value={round.id}>{round.name}</option>
              {/each}
            </select>
          </label>
          <label>
            監査モード<select bind:value={profile.mode}>
              <option value="standard">標準：オンリンクIPv4</option>
              <option value="passive">通信だけ観測</option>
              <option value="detail">詳細：経路承認が必要</option>
            </select>
          </label>
          <label>
            観測秒数<input type="number" min="5" max="1800" bind:value={profile.duration}>
          </label>
        </div>
        <button type="button" onclick={() => action('ホスト設定の取得', diagnose)}>
          ホスト設定を取得
        </button>
        {#if ipv6Status}
          <p>{ipv6Status}</p>
        {/if}
        <label>
          送信元NIC<select
            value={`${profile.ifIndex}:${profile.source}`}
            onchange={(e) => selectNic(e.currentTarget.value)}
          >
            <option value="0:">NICを選択</option>
            {#if profile.ifIndex && !inventory}
              <option value={`${profile.ifIndex}:${profile.source}`}>
                保存済みNIC{profile.source}
              </option>
            {/if}
            {#each addressChoices as address}
              <option value={`${address.ifIndex}:${address.address}`}>
                {inventory?.adapters.find((n) => n.ifIndex === address.ifIndex)
                  ?.name} /{address.address}
                /{address.prefixLength}
              </option>
            {/each}
          </select>
        </label>
        <div class="audit-options">
          <label>対象IPv4 CIDR<input bind:value={ranges} placeholder="192.168.10.0/24"></label>
          <label>
            除外IPv4・CIDR<input
              bind:value={exclusions}
              placeholder="192.168.10.10, 192.168.10.128/25"
            >
          </label>
          <label>TCPポート<input bind:value={portText}></label>
          <label>承認DHCP（空欄＝基準未設定）<input bind:value={dhcpText}></label>
          <label>想定DNS（空欄＝基準未設定）<input bind:value={dnsText}></label>
          <label>想定GW（空欄＝基準未設定）<input bind:value={gatewayText}></label>
          <label>
            DNS失敗率の閾値（0〜1、空欄＝統計のみ）<input
              bind:value={ratioText}
              inputmode="decimal"
            >
          </label>
        </div>
        <label class="inline">
          <input type="checkbox" bind:checked={keepDnsNames}>
          DNS問い合わせ名を証跡に残す（詳細証跡）
        </label>
        {#if keepDnsNames}
          <label>
            詳細証跡の保持日数<input type="number" min="1" max="3650" bind:value={retentionDays}>
          </label>
          <p class="warning">
            問い合わせ名は閲覧先を含み得ます。証跡フォルダの権限と保持期限を確認してください。期限後の削除は管理操作で行い、自動削除しません。
          </p>
        {/if}
        <div class="audit-features">
          {#each featureLabels as [feature, label]}
            <label>
              <input type="checkbox" bind:checked={profile.features[feature]}>
              {label}
            </label>
          {/each}
        </div>
        <p>標準は選択NICのオンリンクIPv4に限定します。経路不一致・変更時は能動監査を止めます。</p>
        {#if profile.mode === 'detail'}
          <p class="warning">
            詳細調査は実行計画の経路承認が必要です。変更すると承認は無効になります。
          </p>
          <div class="audit-options">
            <label>AD/DCサーバー（IPv4）<input bind:value={adServer}></label>
            <label>AD検索ベース（OU）<input bind:value={adBase}></label>
            <label>DHCPサーバー（IPv4・最大10）<input bind:value={dhcpServers}></label>
            <label>Windows端末（IPv4・最大50）<input bind:value={windowsTargets}></label>
          </div>
          <p class="muted">
            管理情報は読取のみ。WinRM・FWを有効化せず、資格情報を保存しません。宛先は経路承認の対象に含めます。
          </p>
          <button
            type="button"
            onclick={() =>
              action('経路と対象の確認', async () => {
                const request = await client.call<{ requestId: string }>('audit/plan', 'POST', {
                  profile: currentProfile(),
                })
                const reply = await client.response(request.requestId)
                executionPlan = reply.executionPlan ?? null
              })}
          >
            経路と対象を確認
          </button>
          {#if executionPlan}
            <div class="confirm-box">
              <p>
                送信元{executionPlan.source} / 対象{executionPlan.targets.length} / 計画{executionPlan.hash}
              </p>
              <ul>
                {#each executionPlan.routes as route}
                  <li>
                    {route.prefix} →{route.nextHop} / NIC{route.ifIndex} / metric{route.metric}
                  </li>
                {/each}
              </ul>
              <label>
                <input
                  type="checkbox"
                  name="routeApproval"
                  checked={profile.approvedPlanHash === executionPlan.hash}
                  onchange={(e) => {
                    profile.approvedPlanHash = e.currentTarget.checked
                      ? executionPlan?.hash
                      : undefined
                  }}
                >
                表示した対象・経路・次ホップでこの実行を承認
              </label>
            </div>
          {/if}
        {/if}
        <div class="audit-options">
          <label>プロファイル名<input bind:value={profileName}></label>
          <label>
            保存済みプロファイル<select
              onchange={(e) => {
                const saved = profiles.find((p) => p.id === e.currentTarget.value)
                if (saved) {
                  applyProfile(saved.profile)
                }
              }}
            >
              <option value="">選択</option>
              {#each profiles as saved}
                <option value={saved.id}>{saved.name}</option>
              {/each}
            </select>
          </label>
        </div>
        <button
          type="button"
          onclick={() =>
            action('プロファイルの保存', async () => {
              await client.call('audit/profiles', 'POST', {
                name: profileName,
                profile: currentProfile(),
              })
              profiles = await client.call('audit/profiles')
              message = 'プロファイルを保存しました'
            })}
        >
          プロファイルを保存
        </button>
        <button
          type="button"
          class="primary"
          disabled={!profile.siteId ||
            !profile.ifIndex ||
            (profile.mode === 'detail' && !profile.approvedPlanHash)}
          onclick={() => action('監査の開始依頼', start)}
        >
          現地監査を開始
        </button>
      </fieldset>
      <fieldset disabled={busy || active || files.auditBusy}>
        <legend>スイッチ情報のオフライン取り込み</legend>
        <p class="muted">
          tylan-switch-export
          v1形式（LLDP/CDP/MACテーブル）のJSONを読み込みます。ネットワークへ送信せず、資格情報は受け付けません。
        </p>
        <label>
          エクスポートJSON<input
            type="file"
            accept=".json,application/json"
            onchange={(e) => {
              switchFile = e.currentTarget.files?.[0] ?? null
            }}
          >
        </label>
        <button
          type="button"
          disabled={!switchFile || !profile.siteId}
          onclick={() => action('スイッチ情報の取り込み依頼', importSwitch)}
        >
          スイッチ情報を取り込む
        </button>
      </fieldset>
      {#if runId}
        <div class="confirm-box">
          <p role="status">
            {`実行 ${runId} / ${runState ? (stateLabels[runState.state] ?? runState.state) : '受付未確認'}${active ? ` / ${stageName}` : ''}`}
          </p>
          {@render stepper('実行の段階', runSteps)}
          {#if active}
            {@render meter(runMeter.label, runMeter.value, runMeter.max, runMeter.text)}
          {/if}
          {#if runState?.startedAt}
            <p class="muted">
              {`開始から ${clock(Math.max(0, now - runState.startedAt))}`}
            </p>
          {/if}
          {#if runState?.reason}
            <p>{runState.reason}</p>
          {/if}
          <button type="button" onclick={poll}>実行状態を再確認</button>
          <button
            type="button"
            disabled={!active}
            onclick={() =>
              action('停止の依頼', async () => {
                await client.cancel(runId)
                message = '停止を依頼しました。停止完了を確認しています。'
                await poll()
              })}
          >
            監査を中止
          </button>
        </div>
      {/if}
      {#if result}
        <p>観測期間{result.startedAt} ～{result.endedAt}。収集器ごとの成否を確認してください。</p>
        {#if incomplete}
          <p class="warning">
            部分完了：一部の収集器が完了していません。成功とは扱わず、未実施・失敗・打ち切りの範囲を確認してください。
          </p>
        {/if}
        <p class="muted">
          観測点{String(result.scope.observationPoint ?? '不明')} / フィルター{String(
            result.scope.captureFilter ?? 'なし',
          )}
          {#if result.scope.retainUntil}
            / 詳細証跡の保持期限{String(result.scope.retainUntil)}
          {/if}
        </p>
        <ul>
          {#each result.collectors as collector}
            <li>
              {String(collector.name)}
              ：{collectorLabels[String(collector.state)] ?? String(collector.state)}
              {String(collector.reason ?? '')}
              {#if collector.name === 'capture' && collector.state !== 'skipped'}
                {`（パケット ${collector.captured ?? '取得不能'} / ドロップ ${collector.dropped ?? '取得不能'} / 行 ${collector.rows ?? '-'} / 集計外 ${collector.omitted ?? 0}）`}
              {/if}
            </li>
          {/each}
        </ul>
        <div class="audit-options">
          <label>
            採用先セグメント<select bind:value={segmentId}>
              <option value="">選択</option>
              {#each doc.segments.filter((s) => s.siteId === profile.siteId) as segment}
                <option value={segment.id}>{segment.name} /{segment.cidr ?? 'CIDR未確認'}</option>
              {/each}
            </select>
          </label>
          <label>確認者<input bind:value={checkedBy}></label>
        </div>
        <h3>見つかった機器（{deviceRows.length}台）</h3>
        <p class="muted">
          収集結果はまだ台帳（JSON）に入っていません。チェックした機器だけを台帳へ追加します。既に台帳にある機器なら「照合先」でその機器を選ぶと、新しく作らずにその機器へ結び付けます。
        </p>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>台帳に追加</th>
                <th>IP / MAC</th>
                <th>見つけ方</th>
                <th>台帳の機器との照合</th>
              </tr>
            </thead>
            <tbody>
              {#each deviceRows as row (row.ids[0])}
                <tr>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${row.ip}を台帳に追加`}
                      checked={row.ids.every((id) => selected[id])}
                      onchange={(e) => {
                        for (const id of row.ids) {
                          selected[id] = e.currentTarget.checked
                        }
                      }}
                    >
                  </td>
                  <td>
                    {row.ip}
                    {row.ip === result.profile.source ? '（この調査用PC）' : ''}
                    <br>
                    {row.mac ?? 'MAC未取得'}
                    {#if row.hostname}
                      <br>
                      {row.hostname}
                    {/if}
                  </td>
                  <td>
                    {row.sources.join('・')}
                    （{row.count}
                    回）
                    <br>
                    {row.first === row.last ? row.first : `${row.first} ～ ${row.last}`}
                    {#if row.openPorts.length}
                      <br>
                      開いているポート：{row.openPorts.join(', ')}
                    {/if}
                  </td>
                  <td>
                    <select
                      aria-label={`${row.ip}の照合先`}
                      value={mappings[row.ids[0]!] ?? ''}
                      onchange={(e) => {
                        for (const id of row.ids) {
                          mappings[id] = e.currentTarget.value
                        }
                      }}
                    >
                      <option value="">照合先を選択（候補なしなら新規）</option>
                      <option value="new">新規機器として追加</option>
                      {#each candidates(doc, row.sample, profile.siteId) as candidate}
                        <option value={candidate.id}>{candidate.name}（一致は候補）</option>
                      {/each}
                    </select>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if linkObservations.length}
          <h3>接続候補（スイッチ情報） / 両端を対応付けた候補だけを推定として採用</h3>
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>採用</th>
                  <th>候補</th>
                  <th>接続元（機器・ポート）</th>
                  <th>接続先（機器・ポート）</th>
                </tr>
              </thead>
              <tbody>
                {#each linkObservations as obs}
                  {@const label = `${String(obs.value.localDevice)} ${String(obs.value.localPort)}`}
                  {@const chosen = draft(obs.id)}
                  <tr>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`${label}の接続候補を選択`}
                        bind:checked={selected[obs.id]}
                      >
                    </td>
                    <td>
                      {String(obs.value.protocol).toUpperCase()}
                      {label} →{String(obs.value.remoteDevice)}
                      {String(obs.value.remotePort ?? '')}
                      <br>
                      {obs.value.linkKind === 'physical'
                        ? '物理接続の推定'
                        : 'MACテーブル：論理接続のみ（配線の証明にしない）'}
                    </td>
                    <td>
                      <select
                        aria-label={`${label}の接続元機器`}
                        value={chosen.aDevice}
                        onchange={(e) =>
                          setDraft(obs.id, { aDevice: e.currentTarget.value, aPort: '' })}
                      >
                        <option value="">機器を選択</option>
                        {#each siteDevices as device}
                          <option value={device.id}>{device.name}</option>
                        {/each}
                      </select>
                      <select
                        aria-label={`${label}の接続元ポート`}
                        value={chosen.aPort}
                        onchange={(e) => setDraft(obs.id, { aPort: e.currentTarget.value })}
                      >
                        <option value="">ポート未確認</option>
                        {#each doc.ports.filter((p) => p.deviceId === chosen.aDevice) as port}
                          <option value={port.id}>{port.name}</option>
                        {/each}
                      </select>
                    </td>
                    <td>
                      <select
                        aria-label={`${label}の接続先機器`}
                        value={chosen.bDevice}
                        onchange={(e) =>
                          setDraft(obs.id, { bDevice: e.currentTarget.value, bPort: '' })}
                      >
                        <option value="">不明端点として記録</option>
                        {#each siteDevices as device}
                          <option value={device.id}>{device.name}</option>
                        {/each}
                      </select>
                      <select
                        aria-label={`${label}の接続先ポート`}
                        value={chosen.bPort}
                        onchange={(e) => setDraft(obs.id, { bPort: e.currentTarget.value })}
                      >
                        <option value="">ポート未確認</option>
                        {#each doc.ports.filter((p) => p.deviceId === chosen.bDevice) as port}
                          <option value={port.id}>{port.name}</option>
                        {/each}
                      </select>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
        {#if managementObservations.length}
          <h3>管理情報（AD・DHCPサーバー）</h3>
          {#each managementObservations as obs}
            <div class="audit-finding">
              <input
                type="checkbox"
                aria-label={`${String(obs.value.name ?? obs.value.scopeId)}を採用候補に選択`}
                bind:checked={selected[obs.id]}
              >
              {#if obs.type === 'adComputer'}
                <span>
                  AD：{String(obs.value.name)} /{String(obs.value.operatingSystem ?? 'OS不明')}
                  （AD登録は稼働・IPを保証しません）
                </span>
                <select
                  aria-label={`${String(obs.value.name)}の照合先`}
                  value={mappings[obs.id] ?? ''}
                  onchange={(e) => {
                    mappings[obs.id] = e.currentTarget.value
                  }}
                >
                  <option value="">照合先を選択</option>
                  <option value="new">新規機器として採用</option>
                  {#each siteDevices as device}
                    <option value={device.id}>{device.name}</option>
                  {/each}
                </select>
              {:else}
                <span>
                  DHCPスコープ：{String(obs.value.scopeId)}/{String(obs.value.subnetMask)} /{String(
                    obs.value.start,
                  )}
                  ～{String(obs.value.end)} / サーバー{String(obs.value.server)}
                  （記録済みのスコープは上書きしません）
                </span>
              {/if}
            </div>
          {/each}
        {/if}
        <h3>異常候補・追加確認</h3>
        {#each result.findings as finding}
          <label class="audit-finding">
            <input type="checkbox" bind:checked={selected[finding.id]}>
            No.{finding.itemNo} /{finding.status}
            ：{finding.reason}
            <small>次の確認：{finding.nextCheck}</small>
          </label>
        {/each}
        <p class="muted">
          選択した結果だけ採用します。初回はv2へ移行し、旧正本をarchiveへ保全します。監査判定は未確認の下書きとして扱います。
        </p>
        <button
          type="button"
          disabled={busy || !selectedKeys.length}
          onclick={() =>
            action('採用差分の作成', async () => {
              preview = (await plan('0'.repeat(64), '未採用プレビュー')).doc
            })}
        >
          論理マップ・採用差分を確認
        </button>
        <button
          type="button"
          class="primary"
          disabled={busy || !selectedKeys.length}
          onclick={() => action('選択した結果の取り込み', adopt)}
        >
          選択した結果を取り込む
        </button>
        {#if adoptStep >= 0}
          {@render stepper('取り込みの段階', adoptView)}
        {/if}
        {#if preview}
          <div class="audit-preview">
            <h3>未採用プレビュー / 物理配線は生成しません</h3>
            <Topology doc={preview} />
          </div>
        {/if}
      {/if}
      <details>
        <summary>保存済みの実行結果</summary>
        <button
          type="button"
          onclick={() =>
            action('実行一覧の更新', async () => {
              past = await client.call('audit/past')
            })}
        >
          実行一覧を更新
        </button>
        {#each past as old}
          <div>
            <span>{old.runId} /{old.state}</span>
            <button
              type="button"
              disabled={busy || active}
              onclick={() => action('実行結果の読込', () => openPast(old.runId))}
            >
              この実行を開く
            </button>
            <button
              type="button"
              disabled={!result || active || busy}
              onclick={() =>
                action('比較元の読込', async () => {
                  await client.call('audit/open', 'POST', { runId: old.runId })
                  previous = await client.result(old.runId)
                })}
            >
              比較元にする
            </button>
          </div>
        {/each}
      </details>
      {#if diff}
        <div class="confirm-box">
          <h3>前回との差分</h3>
          <p>
            {diff.conditions.length
              ? `実行条件・ツールに差があります（${diff.conditions.join(', ')}）。差分は条件の違いを含みます。`
              : '同じ実行条件'}
          </p>
          <p>
            {`追加 ${diff.added.length}件 / 変更 ${diff.changed.length}件 / 今回未観測 ${diff.unobserved.length}件`}
          </p>
          <h4>追加（今回初めて観測）</h4>
          <ul>
            {#each diff.added as device}
              <li>{device.ip} /{device.mac ?? 'MAC未取得'}</li>
            {/each}
          </ul>
          <h4>変更</h4>
          <ul>
            {#each diff.changed as change}
              <li>{change.ip} /{change.fields.join('・')}：{change.before} →{change.after}</li>
            {/each}
          </ul>
          <h4>今回未観測（撤去とは判断しません）</h4>
          <ul>
            {#each diff.unobserved as device}
              <li>{device.ip} /{device.mac ?? 'MAC未取得'}</li>
            {/each}
          </ul>
        </div>
      {/if}
    {/if}
  </section>
{/if}

<style>
  fieldset {
    margin: var(--space-md) 0;
    padding: var(--space-sm);
    border: 1px solid var(--line);
    border-radius: 0;
  }
  .audit-options {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
    gap: var(--space-sm);
    margin: var(--space-sm) 0;
  }
  label {
    display: grid;
    gap: var(--space-2xs);
    min-width: 0;
  }
  .audit-features {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-sm);
    margin: var(--space-md) 0;
  }
  label.inline,
  .audit-features label {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
    min-height: 32px;
  }
  .audit-finding {
    grid-template-columns: auto minmax(0, 1fr);
    padding: var(--space-sm) 0;
    border-bottom: 1px solid var(--line);
  }
  .audit-finding small {
    grid-column: 2;
  }
  .audit-preview {
    height: 650px;
    margin-top: var(--space-md);
  }
  button {
    margin: var(--space-2xs);
  }
  .steps {
    display: flex;
    flex-wrap: wrap;
    gap: 0;
    margin: var(--space-sm) 0;
    padding: 0;
    list-style: none;
    counter-reset: step;
  }
  .steps li {
    counter-increment: step;
    padding: var(--space-xs) var(--space-sm);
    border-bottom: 2px solid var(--line);
    color: var(--muted);
    font-size: 13px;
  }
  .steps li::before {
    content: counter(step) ". ";
  }
  .steps li.done {
    border-color: var(--success-line);
    color: var(--success-ink);
  }
  .steps li.done::before {
    content: "✓ ";
  }
  .steps li.current {
    border-color: var(--accent);
    background: var(--info-face);
    color: var(--info-ink);
    font-weight: 700;
  }
  .steps li.failed {
    border-color: var(--error-line);
    color: var(--error-ink);
  }
  .steps li.failed::before {
    content: "× ";
  }
  .steps li.skipped {
    border-style: dashed;
    text-decoration: line-through;
  }
  .meter {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2xs) var(--space-sm);
    font-variant-numeric: tabular-nums;
  }
  .meter progress {
    flex: 1 1 160px;
    min-width: 120px;
    max-width: 360px;
    height: 16px;
    accent-color: var(--accent);
  }
  .busy {
    margin: var(--space-xs) 0;
  }
  .job-chip {
    position: fixed;
    right: 16px;
    bottom: 16px;
    z-index: var(--z-toast);
    display: grid;
    gap: var(--space-2xs);
    width: min(360px, calc(100% - 32px));
    padding: var(--space-sm) var(--space-md);
    border: 2px solid var(--accent);
    border-radius: 0;
    background: var(--chrome);
    color: var(--ink);
    text-decoration: none;
  }
  .job-chip:hover {
    background: var(--control-hover);
  }
  .job-chip:active {
    background: var(--control-pressed);
  }
  .job-chip:focus-visible {
    outline: 2px solid var(--color-focus);
    outline-offset: 2px;
  }
  input[type="checkbox"] {
    width: 16px;
  }
</style>
