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
  import { candidates, migrateV2, planImport } from '../lib/import-plan'
  import { parseDocument, prepareExport } from '../lib/io'
  import { createId, nowJst } from '../lib/platform'
  import type { Doc } from '../lib/schema'
  import type { Workspace } from '../lib/store.svelte'
  import Topology from './Topology.svelte'

  let { workspace, files, folder }: { workspace: Workspace; files: FileSession; folder: Folder } =
    $props()
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
  let segmentId = $state('')
  let checkedBy = $state('')
  let busy = $state(false)
  let message = $state('')
  let error = $state('')
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
  const active = $derived(
    runId !== '' &&
      !['completed', 'partial', 'failed', 'cancelled', 'interrupted'].includes(
        runState?.state ?? '',
      ),
  )
  const deviceObservations = $derived(
    result?.observations.filter((o) => o.type === 'device' || o.type === 'arp') ?? [],
  )
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
      if (runId && !polling) {
        void poll()
      }
    }, 1000)
    return () => clearInterval(timer)
  })
  async function initialize() {
    try {
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
  }
  function currentProfile(): AuditProfile {
    return {
      ...$state.snapshot(profile),
      cidrs: split(ranges),
      exclude: split(exclusions),
      ports: split(portText).map(Number),
      approvedDhcp: dhcpText.trim() ? split(dhcpText) : null,
      expectedDns: dnsText.trim() ? split(dnsText) : null,
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
  async function action(work: () => Promise<void>) {
    if (busy) {
      return
    }
    busy = true
    error = ''
    message = ''
    try {
      await work()
    } catch (e) {
      error = errorText(e)
    } finally {
      busy = false
    }
  }
  async function diagnose() {
    const reply = await client!.diagnose()
    if (!reply.inventory) {
      throw new Error('ホスト設定を取得できません')
    }
    inventory = reply.inventory
    message = 'ホスト設定を取得しました。送信元NIC・対象・除外を確認してください。'
  }
  async function start() {
    result = null
    preview = null
    selected = {}
    mappings = {}
    runState = null
    const started = await client!.start(currentProfile(), createId('run'))
    runId = started.runId
    message = '依頼済み・受付未確認。まだ実行中とは判定していません。'
    await poll()
  }
  async function poll() {
    if (!client || !runId || polling) {
      return
    }
    polling = true
    try {
      const state = await client.state(runId)
      if (state.response.accepted === false) {
        throw new Error(state.response.error ?? '要求が拒否されました')
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
    result = null
    preview = null
    selected = {}
    mappings = {}
    runState = null
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
      const sealed = await client!.seal(runId)
      if (!sealed.package) {
        throw new Error('証跡を転送・検証できませんでした。正本の採用を中止しました')
      }
      const prepared = await plan(sealed.package.hash, sealed.package.path)
      importId = prepared.importId
      if (JSON.stringify(prepared.doc) === JSON.stringify(doc)) {
        message = '同じ結果は採用済みです。重複を作成しません。'
        return
      }
      const output = prepareExport(prepared.doc, nowJst(), checkedBy)
      await client!.call('imports/prepare', 'POST', {
        importId,
        path: target.path,
        expect: target.expect,
        siteId: profile.siteId,
        text: output.text,
      })
      await waitImport(importId)
      await client!.call(`imports/${importId}/verify`, 'POST')
      await waitImport(importId)
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

<section class="panel audit-panel" aria-label="現地LAN自動監査">
  <div class="section-head">
    <div>
      <p class="eyebrow">ON-SITE AUDIT</p>
      <h2>現地LANを調べる</h2>
    </div>
  </div>
  <p>通信監査はIPv4のみ。観測した範囲・時間を記録し、未観測を問題なしにはしません。</p>
  <p class="muted">IPv6キャプチャ・能動探索は初期版では未対応です。</p>
  {#if !client}
    <p>監査用の起動プログラムが接続されていません。通常の台帳編集は利用できます。</p>
  {:else}
    {#if error}
      <div role="alert" class="error">{error}</div>
    {/if}
    {#if message}
      <p role="status">{message}</p>
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
      <button type="button" onclick={() => action(diagnose)}>ホスト設定を取得</button>
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
                ?.name} ·{address.address}/{address.prefixLength}
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
      </div>
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
        <button
          type="button"
          onclick={() =>
            action(async () => {
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
              送信元{executionPlan.source} · 対象{executionPlan.targets.length} · 計画{executionPlan.hash}
            </p>
            <ul>
              {#each executionPlan.routes as route}
                <li>{route.prefix} →{route.nextHop} / NIC{route.ifIndex} / metric{route.metric}</li>
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
          action(async () => {
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
        onclick={() => action(start)}
      >
        現地監査を開始
      </button>
    </fieldset>
    {#if runId}
      <div class="confirm-box">
        <p>実行{runId} ·{runState?.state ?? '受付未確認'} ·{runState?.stage ?? '起動確認中'}</p>
        {#if runState?.reason}
          <p>{runState.reason}</p>
        {/if}
        <button type="button" onclick={poll}>実行状態を再確認</button>
        <button
          type="button"
          disabled={!active}
          onclick={() =>
            action(async () => {
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
      <ul>
        {#each result.collectors as collector}
          <li>
            {String(collector.name)}：{String(collector.state)}
            {String(collector.reason ?? '')}
          </li>
        {/each}
      </ul>
      <div class="audit-options">
        <label>
          採用先セグメント<select bind:value={segmentId}>
            <option value="">選択</option>
            {#each doc.segments.filter((s) => s.siteId === profile.siteId) as segment}
              <option value={segment.id}>{segment.name} ·{segment.cidr ?? 'CIDR未確認'}</option>
            {/each}
          </select>
        </label>
        <label>確認者<input bind:value={checkedBy}></label>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>採用候補</th>
              <th>IP / MAC</th>
              <th>根拠</th>
              <th>既存機器との照合</th>
            </tr>
          </thead>
          <tbody>
            {#each deviceObservations as observation}
              <tr>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`${String(observation.value.ip)}を採用候補に選択`}
                    bind:checked={selected[observation.id]}
                  >
                </td>
                <td>
                  {String(observation.value.ip)}
                  <br>
                  {String(observation.value.mac ?? 'MAC未取得')}
                </td>
                <td>
                  {observation.source} ·{observation.observedAt}
                  <br>
                  {JSON.stringify(observation.value.ports ?? [])}
                </td>
                <td>
                  <select
                    aria-label={`${String(observation.value.ip)}の照合先`}
                    value={mappings[observation.id] ?? ''}
                    onchange={(e) => {
                      mappings[observation.id] = e.currentTarget.value
                    }}
                  >
                    <option value="">照合先を選択（候補なしなら新規）</option>
                    <option value="new">新規機器として採用</option>
                    {#each candidates(doc, observation, profile.siteId) as candidate}
                      <option value={candidate.id}>{candidate.name}（一致は候補）</option>
                    {/each}
                  </select>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <h3>異常候補・追加確認</h3>
      {#each result.findings as finding}
        <label class="audit-finding">
          <input type="checkbox" bind:checked={selected[finding.id]}>
          No.{finding.itemNo} ·{finding.status}
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
          action(async () => {
            preview = (await plan('0'.repeat(64), '未採用プレビュー')).doc
          })}
      >
        論理マップ・採用差分を確認
      </button>
      <button
        type="button"
        class="primary"
        disabled={busy || !selectedKeys.length}
        onclick={() => action(adopt)}
      >
        選択した結果を取り込む
      </button>
      {#if preview}
        <div class="audit-preview">
          <h3>未採用プレビュー · 物理配線は生成しません</h3>
          <Topology doc={preview} />
        </div>
      {/if}
    {/if}
    <details>
      <summary>保存済みの実行結果</summary>
      <button
        type="button"
        onclick={() =>
          action(async () => {
            past = await client.call('audit/past')
          })}
      >
        実行一覧を更新
      </button>
      {#each past as old}
        <div>
          <span>{old.runId} ·{old.state}</span>
          <button
            type="button"
            disabled={busy || active}
            onclick={() => action(() => openPast(old.runId))}
          >
            この実行を開く
          </button>
          <button
            type="button"
            disabled={!result || active || busy}
            onclick={() =>
              action(async () => {
                await client.call('audit/open', 'POST', { runId: old.runId })
                previous = await client.result(old.runId)
              })}
          >
            比較元にする
          </button>
        </div>
      {/each}
    </details>
    {#if previous && result}
      <div class="confirm-box">
        <h3>前回との差分</h3>
        <p>
          {JSON.stringify(previous.profile) === JSON.stringify(result.profile)
            ? '同じ実行条件'
            : '実行条件に差があります。未観測を撤去と判断しないでください。'}
        </p>
        <p>
          前回の機器観測{previous.observations.filter((o) => o.type === 'device')
            .length} 件／今回{deviceObservations.length} 件
        </p>
      </div>
    {/if}
  {/if}
</section>

<style>
  fieldset {
    border: 1px solid var(--border, #dce1e6);
    border-radius: 8px;
    padding: 16px;
    margin: 16px 0;
  }
  .audit-options {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px;
    margin: 12px 0;
  }
  label {
    display: grid;
    gap: 6px;
  }
  .audit-features {
    display: flex;
    flex-wrap: wrap;
    gap: 14px;
    margin: 16px 0;
  }
  .audit-features label {
    display: flex;
    align-items: center;
  }
  .audit-finding {
    padding: 10px;
    border-bottom: 1px solid #e1e5e8;
    grid-template-columns: auto 1fr;
  }
  .audit-finding small {
    grid-column: 2;
  }
  .audit-preview {
    height: 650px;
    margin-top: 20px;
  }
  .table-scroll {
    overflow: auto;
  }
  button {
    margin: 4px;
  }
  input[type="checkbox"] {
    width: auto;
  }
</style>
