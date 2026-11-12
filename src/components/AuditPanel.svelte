<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import {
    type AuditProfile,
    createAuditClient,
    type Inventory,
    type RunState,
  } from '../lib/audit-client'
  import type { CollectionResult } from '../lib/collection-schema'
  import { fidget } from '../lib/fidget.svelte'
  import type { FileSession } from '../lib/file-session.svelte'
  import type { Folder } from '../lib/folder'
  import {
    analyze,
    baselineFor,
    type Endpoint,
    fieldLabels,
    type HostClass,
    type HostRow,
    planImport,
  } from '../lib/import-plan'
  import { parseDocument, prepareExport } from '../lib/io'
  import { createId, nowJst, todayName } from '../lib/platform'
  import { valueLabels } from '../lib/presentation'
  import { type EntityMap, entitySchemas, newEntity } from '../lib/schema'
  import type { Workspace } from '../lib/store.svelte'

  let {
    workspace,
    files,
    folder,
    view,
    siteId,
  }: {
    workspace: Workspace
    files: FileSession
    folder: Folder
    /** null: off screen, only the floating job chip shows */
    view: 'run' | 'diff' | null
    siteId: string
  } = $props()
  const client = untrack(() => createAuditClient(folder))
  const doc = $derived(workspace.doc)
  const round = $derived(doc.auditRounds.findLast((r) => r.siteIds.includes(siteId)))
  const baseline = $derived(baselineFor(doc, siteId))
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
    ports: [22, 53, 80, 135, 139, 443, 445, 515, 554, 631, 3389, 5985, 5986, 8080, 8443, 9100],
    features: { arp: true, dns: true, dhcp: true, discovery: true, ports: true, ipv6Local: true },
  })
  const featureLabels = [
    ['discovery', '機器探索'],
    ['ports', 'TCPポート確認'],
    ['arp', 'ARP観測'],
    ['dns', 'DNS観測'],
    ['dhcp', 'DHCP観測'],
    ['ipv6Local', 'IPv6設定の読取（送信なし）'],
  ] as const
  let inventory = $state<Inventory | null>(null)
  let siteName = $state('')
  let ranges = $state('')
  let exclusions = $state('')
  let portText = $state(untrack(() => profile.ports.join(',')))
  let ratioText = $state('')
  let keepDnsNames = $state(false)
  let retentionDays = $state(90)
  let adServer = $state('')
  let adBase = $state('')
  let dhcpServers = $state('')
  let switchFile = $state<File | null>(null)
  type LinkDraft = { aDevice: string; aPort: string; bDevice: string; bPort: string }
  let linkDrafts = $state<Record<string, LinkDraft>>({})
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
  let error = $state('')
  let missingTools = $state<string[]>([])
  let optionalTools = $state<string[]>([])
  let runId = $state('')
  let runState = $state<RunState | null>(null)
  let result = $state<CollectionResult | null>(null)
  let selected = $state<Record<string, boolean>>({})
  let kinds = $state<Record<string, EntityMap['devices']['kind']>>({})
  let past = $state<RunState[]>([])
  let executionPlan = $state<{
    hash: string
    targets: string[]
    source: string
    routes: { prefix: string; ifIndex: number; nextHop: string; metric: number }[]
  } | null>(null)
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
  const classLabels: Record<HostClass, string> = {
    rogue: '不審',
    unregistered: '未登録',
    candidate: '管理機器の候補',
    known: '台帳と一致',
    client: '利用端末',
  }
  const classOrder: HostClass[] = ['rogue', 'unregistered', 'candidate', 'known']
  const baselineLabels = {
    match: '基準どおり',
    unset: '基準未設定',
    differs: '基準と違う',
    unobserved: '観測なし',
  }
  const kindOptions = entitySchemas.devices.shape.kind.options
  const active = $derived(
    runId !== '' &&
      !['completed', 'partial', 'failed', 'cancelled', 'interrupted', 'rejected'].includes(
        runState?.state ?? '',
      ),
  )
  const analysis = $derived(result && siteId ? analyze(doc, result, siteId) : null)
  const managed = $derived(
    (analysis?.hosts ?? [])
      .filter((h) => h.class !== 'client')
      .toSorted((a, b) => classOrder.indexOf(a.class) - classOrder.indexOf(b.class)),
  )
  const linkObservations = $derived(
    result?.observations.filter((o) => o.type === 'physicalCandidate') ?? [],
  )
  const scopeObservations = $derived(
    result?.observations.filter((o) => o.type === 'dhcpScope') ?? [],
  )
  const incomplete = $derived(result?.collectors.some((c) => c.state !== 'completed') ?? false)
  const otherSite = $derived(
    !!result && typeof result.profile.siteId === 'string' && result.profile.siteId !== siteId,
  )
  const selectedKeys = $derived(Object.keys(selected).filter((key) => selected[key]))
  const siteDevices = $derived(doc.devices.filter((d) => d.siteId === siteId))
  const addressChoices = $derived(
    inventory?.addresses.filter(
      (a) =>
        a.family === 'IPv4' &&
        inventory?.adapters.some((n) => n.ifIndex === a.ifIndex && n.status === 'Up'),
    ) ?? [],
  )
  const nicName = $derived(
    inventory?.adapters.find((n) => n.ifIndex === profile.ifIndex)?.name ?? '',
  )
  const split = (text: string) =>
    text
      .split(/[\s,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
  const baselineText = (values: string[] | null) => values?.join(', ') ?? '未設定'
  const baselineLine = $derived(
    `GW ${baselineText(baseline.expectedGateway)} / DNS ${baselineText(baseline.expectedDns)} / DHCP ${baselineText(baseline.approvedDhcp)}`,
  )
  const runPlan = $derived(
    `${{ passive: '通信の観測だけ', detail: '詳細調査' }[profile.mode as string] ?? '標準'}・観測${Math.round(profile.duration / 60)}分（全体は最長15分）`,
  )
  const errorText = (value: unknown) => (value instanceof Error ? value.message : String(value))
  const RUN_STEPS: Record<string, string> = {
    validating: '設定確認',
    observing: '通信観測',
    scanning: '機器探索・ポート',
    management: '管理情報',
    finalizing: '最終化',
  }
  const clock = (seconds: number) =>
    `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
  const stageName = $derived(runState ? (RUN_STEPS[runState.stage] ?? runState.stage) : '受付待ち')
  /** Counted work or a time window; nothing when the length is unknown. */
  const runDetail = $derived.by(() => {
    const progress = runState?.progress
    if (progress && 'total' in progress) {
      return `${progress.done}/${progress.total} ${runState!.stage === 'scanning' ? 'バッチ' : '件'}`
    }
    if (progress && 'endsAt' in progress) {
      const max = Math.max(1, Math.round(progress.endsAt - progress.startedAt))
      const value = Math.min(max, Math.max(0, now - progress.startedAt))
      return `${clock(value)}/${clock(max)}`
    }
    return runState ? '' : '受付確認中'
  })
  // Progress lives only in the floating text at the right edge, on every step.
  $effect(() => {
    if (!runId) {
      return
    }
    if (active) {
      fidget.progress('run', `監査 ${stageName}`, runDetail)
    } else {
      const state = runState ? (stateLabels[runState.state] ?? runState.state) : '受付拒否'
      fidget.done('run', `監査 ${state}`)
    }
  })
  $effect(() => {
    if (adoptStep < 0) {
      return
    }
    if (adoptFailed) {
      fidget.done('adopt', `取り込み失敗 ${ADOPT_STEPS[adoptStep] ?? ''}`)
    } else if (adoptStep >= ADOPT_STEPS.length) {
      fidget.done('adopt', '取り込み完了')
    } else {
      fidget.progress(
        'adopt',
        `取り込み ${ADOPT_STEPS[adoptStep]}`,
        `${adoptStep + 1}/${ADOPT_STEPS.length}`,
      )
    }
  })

  onMount(() => {
    checkedBy = doc.project.updatedBy ?? ''
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
    let available = false
    try {
      const audit = (await folder.info()).audit
      available = !!audit?.available
      missingTools = audit?.missing ?? []
      optionalTools = audit?.optional ?? []
      past = await client!.call('audit/past')
      const runs = await client!.call<{ runId: string }[]>('audit/runs')
      if (runs.length) {
        runId = runs.at(-1)!.runId
        await poll()
      }
    } catch (e) {
      error = errorText(e)
    }
    // Find the NIC up front so the start button needs nothing else.
    if (available && !missingTools.length && !active) {
      await action('ホスト設定の取得', diagnose)
    }
  }
  function currentProfile(): AuditProfile {
    const { management: _m, detailEvidence: _d, ...base } = $state.snapshot(profile)
    const management = {
      ...(adServer.trim() ? { ad: { server: adServer.trim(), searchBase: adBase.trim() } } : {}),
      ...(split(dhcpServers).length ? { dhcpServers: split(dhcpServers) } : {}),
    }
    return {
      ...base,
      siteId,
      roundId: round?.id ?? '',
      cidrs: split(ranges),
      exclude: split(exclusions),
      ports: split(portText).map(Number),
      // The yardstick is the JSON's baseline, edited in step 2: never typed in twice.
      ...baselineFor(doc, siteId),
      dnsFailureRatio: ratioText.trim() ? Number(ratioText) : null,
      ...(keepDnsNames ? { detailEvidence: { dnsNames: true, retentionDays } } : {}),
      ...(profile.mode === 'detail' && Object.keys(management).length ? { management } : {}),
      documentId: doc.documentId,
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
    const value = choice.address.split('.').reduce((n, b) => (n << 8n) + BigInt(b), 0n)
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
    fidget.progress('busy', label)
    try {
      await work()
      fidget.done('busy', label)
    } catch (e) {
      error = errorText(e)
      fidget.done('busy', `${label} 失敗`)
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
    // The NIC that carries the default route is the LAN being audited.
    const best = inventory.routes
      .filter((r) => r.prefix === '0.0.0.0/0')
      .toSorted((a, b) => a.metric - b.metric)
      .find((r) => addressChoices.some((a) => a.ifIndex === r.ifIndex))
    const pick = addressChoices.find((a) => a.ifIndex === best?.ifIndex) ?? addressChoices[0]
    if (pick && !profile.ifIndex) {
      selectNic(`${pick.ifIndex}:${pick.address}`)
    }
  }
  /** A first audit needs a site and a round: made here so the start button is the only step. */
  function ensureContext() {
    let site = siteId || doc.sites[0]?.id
    if (!site) {
      if (!siteName.trim()) {
        throw new Error('拠点名を入力してください')
      }
      site = createId('sit')
      if (!workspace.upsert('sites', { ...newEntity('sites', site), name: siteName.trim() })) {
        throw new Error('拠点を登録できません')
      }
    }
    if (!doc.auditRounds.some((r) => r.siteIds.includes(site))) {
      const ok = workspace.startRound({
        ...newEntity('auditRounds', createId('rnd')),
        name: todayName(),
        siteIds: [site],
        startDate: nowJst().slice(0, 10),
      })
      if (!ok) {
        throw new Error('監査回次を作成できません')
      }
    }
  }
  function resetRun() {
    result = null
    selected = {}
    kinds = {}
    linkDrafts = {}
    runState = null
  }
  async function start() {
    ensureContext()
    resetRun()
    const started = await client!.start(currentProfile(), createId('run'))
    runId = started.runId
    fidget.say('依頼済み・受付未確認。まだ実行中とは判定していません。')
    await poll()
  }
  async function importSwitch() {
    ensureContext()
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
      { mode: 'offline', siteId, switchExport } as AuditProfile,
      createId('run'),
    )
    runId = started.runId
    fidget.say('取り込み依頼済み・受付未確認。')
    await poll()
  }
  /** Everything worth keeping is ticked up front; only clients are never offered. */
  function preselect(found: CollectionResult) {
    const a = analyze(doc, found, siteId)
    selected = Object.fromEntries([
      ...a.baseline.filter((b) => b.state === 'unset').map((b) => [b.key, true]),
      ...a.hosts.filter((h) => h.class !== 'client' && h.cidr).map((h) => [h.key, true]),
      ...found.findings.map((f) => [f.id, true]),
      ...found.observations.filter((o) => o.type === 'dhcpScope').map((o) => [o.id, true]),
    ])
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
          const found = await client.result(runId)
          preselect(found)
          result = found
          fidget.say('収集結果を取得しました。正本には未採用です。')
          if (view === 'run') {
            window.location.hash = '#/diff'
          }
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
    if (!result || !round) {
      throw new Error('監査回次がありません。①から監査を実行してください')
    }
    return planImport(doc, $state.snapshot(result), {
      siteId,
      roundId: round.id,
      selected: selectedKeys,
      kinds: $state.snapshot(kinds),
      links: linkMappings(),
      checkedBy,
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
        fidget.say('同じ結果は取り込み済みです。重複を作成しません。')
        return
      }
      const output = prepareExport(prepared.doc, nowJst(), checkedBy)
      adoptStep = 3
      await client!.call('imports/prepare', 'POST', {
        importId,
        path: target.path,
        expect: target.expect,
        siteId,
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
      fidget.say(`取り込みました。判定は下書きのままです。${prepared.conflicts.join('。')}`)
      window.location.hash = '#/judge'
    } catch (e) {
      if (importId && commitAttempted) {
        adoptStep = 6
        try {
          const status = await client!.call<{ state: string; text: string; lastModified: string }>(
            `imports/${importId}/reconcile`,
          )
          if (status.state === 'applied') {
            files.completeImport(parseDocument(status.text), importId, status.lastModified)
            fidget.say(
              '正本を照合し、取り込み済みであることを確認しました。再取り込みは行っていません。',
            )
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

{#snippet hostRow(row: HostRow)}
  <tr class={`host-${row.class}`}>
    <td>
      <input
        type="checkbox"
        aria-label={`${row.ip}を${row.class === 'known' ? '確認済みにする' : '台帳に追加'}`}
        disabled={!row.cidr}
        bind:checked={selected[row.key]}
      >
    </td>
    <td><span class={`tag tag-${row.class}`}>{classLabels[row.class]}</span></td>
    <td>
      <strong>{row.ip}</strong>
      <small class="cell-secondary">
        {row.mac ?? 'MAC未取得'}
        {row.hostname ? ` / ${row.hostname}` : ''}
      </small>
    </td>
    <td>
      {row.class === 'known'
        ? (doc.devices.find((d) => d.id === row.deviceId)?.name ?? '')
        : row.why}
      <small class="cell-secondary">
        推定：{row.label}
        {row.vendor ? `（${row.vendor}）` : ''}
        {row.openPorts.length ? ` / ${row.openPorts.join(', ')}` : ''}
      </small>
    </td>
    <td>
      {#if row.class === 'known'}
        確認日を記録
      {:else}
        <select
          aria-label={`${row.ip}の種別`}
          value={kinds[row.key] ?? row.kind}
          onchange={(e) => {
            kinds[row.key] = e.currentTarget.value as EntityMap['devices']['kind']
          }}
        >
          {#each kindOptions as kind}
            <option value={kind}>{valueLabels[kind]}</option>
          {/each}
        </select>
      {/if}
    </td>
  </tr>
{/snippet}

{#if view !== null}
  {#if error}
    <div role="alert" class="error">{error}</div>
  {/if}
{/if}

{#if view === 'run'}
  <section class="panel" aria-label="現地LAN自動監査">
    <h2>現地LANを調べる</h2>
    {#if !client}
      <p>監査用の起動プログラムが接続されていません。基準の編集・判定・公開は利用できます。</p>
    {:else}
      {#if missingTools.length}
        <div role="alert" class="error">
          監査に必要なソフトがこのPCに見つかりません：{missingTools.join('、')}。導入してから
          tylan.cmd を起動し直してください。
        </div>
      {/if}
      {#if optionalTools.length}
        <p class="muted">
          未導入（なしでも監査できます）：{optionalTools.join('、')}
          。通信観測（ARP/DNS/DHCP）は未実施として記録されます。
        </p>
      {/if}
      <div class="run-card">
        <dl class="run-summary">
          {#if !doc.sites.length}
            <dt><label for="site-name">拠点名</label></dt>
            <dd>
              <input id="site-name" bind:value={siteName} placeholder="例：本社" maxlength="100">
            </dd>
          {/if}
          <dt>調べる範囲</dt>
          <dd>
            {#if profile.ifIndex}
              {ranges || '未設定'}
              <small>（{nicName || 'NIC'} {profile.source} から）</small>
            {:else if busyLabel === 'ホスト設定の取得'}
              このPCのNICを確認中…
            {:else}
              NIC未選択（下の「実行条件を変える」で選んでください）
            {/if}
          </dd>
          <dt>方式・時間</dt>
          <dd>{runPlan}</dd>
          <dt>比べる基準</dt>
          <dd>
            {baselineLine}
            {#if !baseline.expectedGateway || !baseline.expectedDns || !baseline.approvedDhcp}
              <small>（未設定の基準は、結果を見て②でそのまま基準にできます）</small>
            {/if}
          </dd>
        </dl>
        <button
          type="button"
          class="primary start"
          disabled={busy ||
            active ||
            files.auditBusy ||
            !profile.ifIndex ||
            (!doc.sites.length && !siteName.trim()) ||
            (profile.mode === 'detail' && !profile.approvedPlanHash)}
          onclick={() => action('監査の開始依頼', start)}
        >
          監査を開始
        </button>
      </div>
      {#if runId}
        <div class="confirm-box">
          <p>
            {`実行 ${runId} / ${runState ? (stateLabels[runState.state] ?? runState.state) : '受付未確認'}${active ? ` / ${stageName}` : ''}`}
          </p>
          {#if runState?.startedAt}
            <p class="muted">{`開始から ${clock(Math.max(0, now - runState.startedAt))}`}</p>
          {/if}
          {#if runState?.reason}
            <p>{runState.reason}</p>
          {/if}
          <button type="button" onclick={poll}>状態を再確認</button>
          <button
            type="button"
            disabled={!active}
            onclick={() =>
              action('停止の依頼', async () => {
                await client.cancel(runId)
                fidget.say('停止を依頼しました。停止完了を確認しています。')
                await poll()
              })}
          >
            監査を中止
          </button>
          {#if result}
            <a class="button-link" href="#/diff">結果を確認する（②）</a>
          {/if}
        </div>
      {/if}
      <details>
        <summary>実行条件を変える</summary>
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
              調べるNIC<select
                value={`${profile.ifIndex}:${profile.source}`}
                onchange={(e) => selectNic(e.currentTarget.value)}
              >
                <option value="0:">NICを選択</option>
                {#each addressChoices as address}
                  <option value={`${address.ifIndex}:${address.address}`}>
                    {inventory?.adapters.find((n) => n.ifIndex === address.ifIndex)?.name} /
                    {address.address}/{address.prefixLength}
                  </option>
                {/each}
              </select>
            </label>
            <label>
              方式<select bind:value={profile.mode}>
                <option value="standard">標準：同じLAN内のIPv4</option>
                <option value="passive">通信の観測だけ（送信しない）</option>
                <option value="detail">詳細調査：経路の承認が必要</option>
              </select>
            </label>
            <label>
              観測秒数<input type="number" min="5" max="1800" bind:value={profile.duration}>
            </label>
            <label>調べる範囲（IPv4 CIDR）<input bind:value={ranges}></label>
            <label>
              除外するIP・CIDR<input
                bind:value={exclusions}
                placeholder="192.168.10.10, 192.168.10.128/25"
              >
            </label>
            <label>TCPポート<input bind:value={portText}></label>
            <label>
              DNS失敗率の閾値（0〜1、空欄＝統計のみ）<input
                bind:value={ratioText}
                inputmode="decimal"
              >
            </label>
          </div>
          <button type="button" onclick={() => action('ホスト設定の取得', diagnose)}>
            NICを取得し直す
          </button>
          <div class="audit-features">
            {#each featureLabels as [feature, label]}
              <label>
                <input type="checkbox" bind:checked={profile.features[feature]}>
                {label}
              </label>
            {/each}
          </div>
          <label class="inline">
            <input type="checkbox" bind:checked={keepDnsNames}>
            DNS問い合わせ名を証跡に残す
          </label>
          {#if keepDnsNames}
            <label>
              保持日数<input type="number" min="1" max="3650" bind:value={retentionDays}>
            </label>
            <p class="warning">
              問い合わせ名は閲覧先を含み得ます。期限後の削除は管理操作で行い、自動削除しません。
            </p>
          {/if}
          {#if profile.mode === 'detail'}
            <div class="audit-options">
              <label>AD/DCサーバー（IPv4）<input bind:value={adServer}></label>
              <label>AD検索ベース（OU）<input bind:value={adBase}></label>
              <label>DHCPサーバー（IPv4・最大10）<input bind:value={dhcpServers}></label>
            </div>
            <p class="muted">
              管理情報は読取のみで、資格情報を保存しません。AD登録コンピューターは台数だけ数えます。
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
                <label class="inline">
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
                  表示した対象・経路でこの実行を承認
                </label>
              </div>
            {/if}
          {/if}
        </fieldset>
      </details>
      <details>
        <summary>スイッチ情報（LLDP/CDP/MACテーブル）を取り込む</summary>
        <fieldset disabled={busy || active || files.auditBusy}>
          <legend>オフライン取り込み</legend>
          <p class="muted">
            tylan-switch-export
            v1形式のJSONを読み込みます。ネットワークへ送信せず、資格情報は受け付けません。
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
            disabled={!switchFile || !doc.sites.length}
            onclick={() => action('スイッチ情報の取り込み依頼', importSwitch)}
          >
            スイッチ情報を取り込む
          </button>
        </fieldset>
      </details>
      <details>
        <summary>過去の実行を開く（{past.length}件）</summary>
        {#each past as old}
          <div>
            <span>{old.runId} /{stateLabels[old.state] ?? old.state}</span>
            <button
              type="button"
              disabled={busy || active}
              onclick={() => action('実行結果の読込', () => openPast(old.runId))}
            >
              この実行を開く
            </button>
          </div>
        {:else}
          <p class="muted">保存済みの実行はありません。</p>
        {/each}
      </details>
    {/if}
  </section>
{/if}

{#if view === 'diff'}
  <section class="panel" aria-label="基準との差分">
    <h2>基準との差分</h2>
    {#if !result || !analysis}
      <p>
        まだ監査結果がありません。<a href="#/run">①実行</a>
        で監査するか、過去の実行を開いてください。下の台帳（基準）は今すぐ編集できます。
      </p>
    {:else}
      <p class="muted">
        実行{result.runId}
        ・{result.startedAt.slice(0, 16).replace('T', ' ')} ～
        {result.endedAt.slice(11, 16)}
        ・
        {#each result.collectors as collector, i}
          {i ? '、' : ''}
          {String(collector.name)}
          ：{collectorLabels[String(collector.state)] ?? String(collector.state)}
        {/each}
      </p>
      {#if incomplete}
        <p class="warning">
          一部の収集が完了していません。見えなかったことを「問題なし」の根拠にしないでください。
        </p>
      {/if}
      {#if otherSite}
        <p class="warning">
          この結果は別の拠点で実行したものです。拠点を切り替えて確認してください。
        </p>
      {/if}

      <h3>ネットワークの基準</h3>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>基準にする</th>
              <th>範囲</th>
              <th>項目</th>
              <th>基準</th>
              <th>今回の観測</th>
              <th>状態</th>
            </tr>
          </thead>
          <tbody>
            {#each analysis.baseline as row (row.key)}
              <tr>
                <td>
                  {#if row.state === 'unset'}
                    <input
                      type="checkbox"
                      aria-label={`${row.cidr}の${fieldLabels[row.field]}を基準にする`}
                      bind:checked={selected[row.key]}
                    >
                  {/if}
                </td>
                <td>{row.cidr}</td>
                <td>{fieldLabels[row.field]}</td>
                <td>{row.expected.join(', ') || '未設定'}</td>
                <td>{row.observed.join(', ') || '—'}</td>
                <td><span class={`tag tag-${row.state}`}>{baselineLabels[row.state]}</span></td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if !analysis.poolsKnown}
        <p class="muted">
          DHCPの配布範囲が基準にないため、固定IP機器の判定はしていません（台帳の「ネットワーク →
          DHCP」で範囲を登録すると判定します）。
        </p>
      {/if}

      <h3>管理機器</h3>
      <p class="muted">
        プリンター・NAS・カメラなど、台帳で1台ずつ管理する機器です。MACで照合するので、DHCPでIPが変わっても同じ機器として扱います。
      </p>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>採用</th>
              <th>区分</th>
              <th>IP / MAC</th>
              <th>理由・推定</th>
              <th>種別</th>
            </tr>
          </thead>
          <tbody>
            {#each managed as row (row.key)}
              {@render hostRow(row)}
            {:else}
              <tr>
                <td colspan="5" class="empty">管理機器らしいものは見つかりませんでした。</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if analysis.unseen.length}
        <p>
          今回見えなかった台帳の機器（撤去とは判断しません）：{analysis.unseen
            .map((d) => d.name)
            .join('、')}
        </p>
      {/if}

      <h3>利用端末（台数のみ）</h3>
      <p class="muted">
        社員PC・スマホはDHCPで毎日IPが変わるため、1台ずつは追いません。台数と内訳を回次に記録します。
      </p>
      {#each analysis.clients as summary}
        <dl class="client-summary">
          <dt>{summary.cidr}</dt>
          <dd>
            <strong>{summary.total}台</strong>（ランダムMAC{summary.randomMac}・169.254.x.x
            {summary.linkLocal}
            ）
            <small>{summary.vendors.map((v) => `${v.name} ${v.count}`).join(' / ')}</small>
          </dd>
        </dl>
      {:else}
        <p>利用端末は観測されませんでした。</p>
      {/each}
      {#if analysis.adComputers}
        <p>AD登録コンピューター：{analysis.adComputers}台（台帳には載せません）</p>
      {/if}

      {#if result.findings.length}
        <h3>自動判定の下書き</h3>
        {#each result.findings as finding}
          <label class="audit-finding">
            <input type="checkbox" bind:checked={selected[finding.id]}>
            No.{finding.itemNo}
            ：{finding.reason}
            <small>次の確認：{finding.nextCheck}</small>
          </label>
        {/each}
      {/if}

      {#if scopeObservations.length}
        <h3>DHCPサーバーの設定（管理情報）</h3>
        {#each scopeObservations as obs}
          <label class="audit-finding">
            <input type="checkbox" bind:checked={selected[obs.id]}>
            {String(obs.value.scopeId)}
            /{String(obs.value.subnetMask)}
            ：{String(obs.value.start)}
            ～{String(obs.value.end)}
            （サーバー{String(obs.value.server)}
            ）を基準にする
            <small>記録済みの配布範囲は上書きしません</small>
          </label>
        {/each}
      {/if}

      {#if linkObservations.length}
        <h3>接続候補（スイッチ情報）</h3>
        <p class="muted">両端の機器を選んだ候補だけを「推定」の接続として採用します。</p>
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
                    <small class="cell-secondary">
                      {obs.value.linkKind === 'physical'
                        ? '物理接続の推定'
                        : 'MACテーブル：論理接続のみ（配線の証明にしない）'}
                    </small>
                  </td>
                  {#each [
                    ['a', '接続元'],
                    ['b', '接続先'],
                  ] as const as [end, endLabel]}
                    {@const device = end === 'a' ? chosen.aDevice : chosen.bDevice}
                    <td>
                      <select
                        aria-label={`${label}の${endLabel}機器`}
                        value={device}
                        onchange={(e) =>
                          setDraft(
                            obs.id,
                            end === 'a'
                              ? { aDevice: e.currentTarget.value, aPort: '' }
                              : { bDevice: e.currentTarget.value, bPort: '' },
                          )}
                      >
                        <option value="">
                          {end === 'a' ? '機器を選択' : '不明端点として記録'}
                        </option>
                        {#each siteDevices as d}
                          <option value={d.id}>{d.name}</option>
                        {/each}
                      </select>
                      <select
                        aria-label={`${label}の${endLabel}ポート`}
                        value={end === 'a' ? chosen.aPort : chosen.bPort}
                        onchange={(e) =>
                          setDraft(
                            obs.id,
                            end === 'a'
                              ? { aPort: e.currentTarget.value }
                              : { bPort: e.currentTarget.value },
                          )}
                      >
                        <option value="">ポート未確認</option>
                        {#each doc.ports.filter((p) => p.deviceId === device) as port}
                          <option value={port.id}>{port.name}</option>
                        {/each}
                      </select>
                    </td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}

      <div class="adopt-bar">
        <label>確認者<input bind:value={checkedBy} maxlength="100"></label>
        <button
          type="button"
          class="primary"
          disabled={busy || files.auditBusy || otherSite || !checkedBy.trim()}
          onclick={() => action('取り込み', adopt)}
        >
          選んだ{selectedKeys.length}件と端末台数を取り込む
        </button>
        <span class="muted">証跡を封印してから保存します。判定は③で確定します。</span>
      </div>
    {/if}
  </section>
{/if}

<style>
  fieldset {
    margin: var(--space-md) 0;
    padding: var(--space-sm);
    border: 1px solid var(--line);
  }
  details {
    margin-top: var(--space-md);
  }
  summary {
    min-height: 32px;
    cursor: pointer;
    color: var(--link);
  }
  .run-card {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-lg);
    padding: var(--space-md);
    border: 1px solid var(--line);
    background: var(--paper-muted);
  }
  .run-summary {
    display: grid;
    flex: 1 1 420px;
    grid-template-columns: 112px minmax(0, 1fr);
    gap: var(--space-2xs) var(--space-sm);
    margin: 0;
  }
  .run-summary dt {
    color: var(--muted);
  }
  .run-summary dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .run-summary small,
  .client-summary small {
    display: block;
    color: var(--muted);
  }
  button.start {
    min-width: 200px;
    min-height: 56px;
    font-size: var(--text-lg);
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
    color: var(--muted);
  }
  .client-summary {
    display: grid;
    grid-template-columns: 160px minmax(0, 1fr);
    margin: var(--space-xs) 0;
  }
  .client-summary dd {
    margin: 0;
  }
  .tag {
    display: inline-block;
    padding: 0 var(--space-2xs);
    border: 1px solid var(--line);
    font-size: 12px;
    white-space: nowrap;
  }
  .tag-rogue,
  .tag-differs {
    border-color: var(--error-line);
    background: var(--error-face);
    color: var(--error-ink);
  }
  .tag-unregistered,
  .tag-unset {
    border-color: var(--warning-line);
    background: var(--warning-face);
    color: var(--warning-ink);
  }
  .tag-candidate {
    border-color: var(--info-line);
    background: var(--info-face);
    color: var(--info-ink);
  }
  .tag-known,
  .tag-match {
    border-color: var(--success-line);
    background: var(--success-face);
    color: var(--success-ink);
  }
  .adopt-bar {
    position: sticky;
    bottom: 0;
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: var(--space-sm);
    margin-top: var(--space-lg);
    padding: var(--space-sm);
    border-top: 2px solid var(--accent);
    background: var(--chrome);
  }
  .button-link {
    margin-left: var(--space-sm);
  }
  button {
    margin: var(--space-2xs);
  }
  input[type="checkbox"] {
    width: 16px;
  }
</style>
