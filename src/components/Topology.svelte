<script lang="ts">
  import {
    Background,
    type Connection,
    ConnectionMode,
    Controls,
    MiniMap,
    type Node,
    SvelteFlow,
  } from '@xyflow/svelte'
  import '@xyflow/svelte/dist/style.css'
  import { type GraphDoc, toGraph } from '../lib/graph'
  import { autoLayout } from '../lib/layout'
  import { createId } from '../lib/platform'
  import { labels, valueLabels } from '../lib/presentation'
  import { entityHref } from '../lib/routes'
  import { type EntityMap, newEntity } from '../lib/schema'
  import type { Workspace } from '../lib/store.svelte'
  import DeviceNode from './DeviceNode.svelte'
  import GraphActions from './GraphActions.svelte'
  import GroupNode from './GroupNode.svelte'

  let {
    doc,
    workspace,
  }: {
    doc: GraphDoc & {
      project: { name: string; revision: number; surveyDate: string | null }
      auditRounds: { id: string; name: string }[]
    }
    workspace?: Workspace
  } = $props()
  let siteId = $state('')
  let layoutId = $state('')
  let roundId = $state('')
  let query = $state('')
  let kind = $state('')
  let judgment = $state('')
  let locationId = $state('')
  let observation = $state('')
  let segmentId = $state('')
  let wirelessId = $state('')
  let selectedId = $state('')
  let selectedEdge = $state('')
  let confirmLayout = $state(false)
  let root: HTMLDivElement | undefined = $state()
  const activeSite = $derived(
    doc.sites.some((s) => s.id === siteId) ? siteId : (doc.sites[0]?.id ?? ''),
  )
  const activeLayout = $derived(
    doc.layouts.find((l) => l.id === layoutId && l.siteId === activeSite) ??
      doc.layouts.find((l) => l.siteId === activeSite),
  )
  const graph = $derived(
    toGraph(doc, activeSite, {
      layoutId: activeLayout?.id,
      query,
      kind,
      judgment,
      locationId,
      observation,
      segmentId,
      wirelessId,
      roundId: roundId || doc.auditRounds.at(-1)?.id,
      selectedId,
    }),
  )
  let nodes = $derived(graph.nodes)
  let edges = $derived(graph.edges)
  const selectedDevice = $derived(doc.devices.find((d) => d.id === selectedId))
  const edge = $derived(doc.links.find((l) => l.id === selectedEdge))
  const moveCount = $derived(
    doc.devices.filter((d) => d.siteId === activeSite && !activeLayout?.positions[d.id]?.pinned)
      .length,
  )
  const nodeTypes = { device: DeviceNode, group: GroupNode }
  function updateLayout(change: (layout: EntityMap['layouts']) => void) {
    workspace?.commit((d) => {
      let layout = d.layouts.find((l) => l.id === activeLayout?.id)
      if (!layout) {
        layout = {
          ...newEntity('layouts', createId('lay')),
          name: '物理構成図',
          siteId: activeSite,
        }
        d.layouts.push(layout)
      }
      change(layout)
    })
  }
  function drag(changed: Node[]) {
    const absolute = (n: Node): { x: number; y: number } => {
      const parent = nodes.find((p) => p.id === n.parentId)
      const pos = parent ? absolute(parent) : { x: 0, y: 0 }
      return { x: n.position.x + pos.x, y: n.position.y + pos.y }
    }
    updateLayout((l) => {
      for (const n of changed.filter((n) => n.type === 'device')) {
        l.positions[n.id] = { ...absolute(n), pinned: l.positions[n.id]?.pinned ?? false }
      }
    })
  }
  function connect(c: Connection) {
    if (!workspace || !c.source.startsWith('dev_') || !c.target.startsWith('dev_')) {
      return
    }
    workspace.upsert('links', {
      ...newEntity('links', createId('lnk')),
      a: { deviceId: c.source, portId: c.sourceHandle === 'device' ? null : c.sourceHandle },
      b: { deviceId: c.target, portId: c.targetHandle === 'device' ? null : c.targetHandle },
      certainty: 'estimated',
    })
  }
  function renderValue(value: unknown): string {
    return value == null
      ? '未確認・未設定'
      : typeof value === 'object'
        ? JSON.stringify(value)
        : (valueLabels[String(value)] ?? String(value))
  }
</script>
<section class="panel topology-panel">
  <div class="section-head">
    <div>
      <p class="eyebrow">NETWORK MAP</p>
      <h2>トポロジー</h2>
    </div>
    <span>{graph.matchedCount}機器 ·{edges.length}接続</span>
  </div>
  <div class="toolbar wrap">
    <label>
      拠点<select
        value={activeSite}
        onchange={(e) => {
          siteId = e.currentTarget.value
          selectedId = ''
          layoutId = ''
          locationId = ''
          segmentId = ''
          wirelessId = ''
        }}
      >
        {#each doc.sites as s}
          <option value={s.id}>{s.name}</option>
        {/each}
      </select>
    </label>
    <label>
      図<select value={activeLayout?.id ?? ''} onchange={(e) => (layoutId = e.currentTarget.value)}>
        {#each doc.layouts.filter((l) => l.siteId === activeSite) as l}
          <option value={l.id}>{l.name}</option>
        {:else}
          <option value="">物理構成図</option>
        {/each}
      </select>
    </label>
    <label>
      機器検索<input type="search" bind:value={query} placeholder="名称・IP・型番・設置場所">
    </label>
    <label>
      種別<select bind:value={kind}>
        <option value="">すべて</option>
        {#each [...new Set(doc.devices.map((d) => d.kind))] as k}
          <option value={k}>{valueLabels[k]}</option>
        {/each}
      </select>
    </label>
    <label>
      監査判定<select bind:value={judgment}>
        <option value="">すべて</option>
        {#each ['ng', 'unchecked', 'ok', 'na', 'none'] as j}
          <option value={j}>{valueLabels[j] ?? '監査記録なし'}</option>
        {/each}
      </select>
    </label>
    <details class="advanced-filters">
      <summary>詳細フィルター（設置場所・確認状況・VLAN・SSID・回次）</summary>
      <div class="advanced-filter-fields">
        <label>
          設置場所<select bind:value={locationId}>
            <option value="">すべて</option>
            {#each doc.locations.filter((l) => l.siteId === activeSite) as l}
              <option value={l.id}>{l.name}</option>
            {/each}
          </select>
        </label>
        <label>
          確認状況<select bind:value={observation}>
            <option value="">すべて</option>
            {#each ['unknown', 'observed', 'notObserved'] as state}
              <option value={state}>{valueLabels[state]}</option>
            {/each}
          </select>
        </label>
        {#if doc.segments}
          <label>
            VLAN・セグメント<select bind:value={segmentId}>
              <option value="">すべて</option>
              {#each doc.segments.filter((s) => s.siteId === activeSite) as s}
                <option value={s.id}>{s.name} · VLAN{s.vlanId ?? '不明'}</option>
              {/each}
            </select>
          </label>
        {/if}
        {#if doc.wirelessNetworks}
          <label>
            SSID<select bind:value={wirelessId}>
              <option value="">すべて</option>
              {#each doc.wirelessNetworks.filter((w) => w.siteId === activeSite) as w}
                <option value={w.id}>{w.ssid}</option>
              {/each}
            </select>
          </label>
        {/if}
        <label>
          回次<select
            value={roundId || doc.auditRounds.at(-1)?.id || ''}
            onchange={(e) => (roundId = e.currentTarget.value)}
          >
            {#each doc.auditRounds as r}
              <option value={r.id}>{r.name}</option>
            {:else}
              <option value="">記録なし</option>
            {/each}
          </select>
        </label>
      </div>
    </details>
    {#if workspace}
      <button type="button" onclick={() => (confirmLayout = true)}>自動配置</button>
    {/if}
  </div>
  {#if confirmLayout}
    <div class="notice">
      固定されていない{moveCount}機器と不明端点を再配置します。取り消し可能です。<button
        type="button"
        onclick={() => {
          updateLayout((l) => (l.positions = autoLayout(doc, activeSite, l)))
          confirmLayout = false
        }}
      >
        配置を実行
      </button>
      <button type="button" onclick={() => (confirmLayout = false)}>中止</button>
    </div>
  {/if}
  <div class="map-layout">
    <div class="graph-export" bind:this={root}>
      <div class="map-caption">
        <strong>
          {activeLayout?.name ?? '物理構成図'}
          ·{doc.sites.find((s) => s.id === activeSite)?.name ?? '拠点未登録'}
        </strong>
        <small>
          {doc.project.name}
          · r{String(doc.project.revision).padStart(4, '0')}
          · 調査基準日{doc.project.surveyDate ?? '未設定'}
        </small>
      </div>
      <div class="flow-container">
        {#key `${activeSite}:${activeLayout?.id ?? ''}`}
          <SvelteFlow
            bind:nodes
            bind:edges
            {nodeTypes}
            nodesDraggable={!!workspace}
            nodesConnectable={!!workspace}
            deleteKey={null}
            connectionMode={ConnectionMode.Loose}
            minZoom={0.05}
            maxZoom={3}
            fitView={!activeLayout}
            initialViewport={activeLayout?.viewport ?? { x: 0, y: 0, zoom: 1 }}
            proOptions={{ hideAttribution: true }}
            onnodeclick={({ node }) => {
              selectedId = node.id
              selectedEdge = ''
            }}
            onedgeclick={({ edge }) => {
              selectedEdge = edge.id
              selectedId = ''
            }}
            onpaneclick={() => {
              selectedId = ''
              selectedEdge = ''
            }}
            onnodedragstop={({ nodes }) => drag(nodes)}
            onconnect={connect}
          >
            <Background />
            <MiniMap pannable zoomable />
            <Controls showLock={false} />
            <GraphActions
              element={root}
              title={`topology-r${doc.project.revision}`}
              focusIds={graph.matchedIds}
              onsave={workspace
                ? (viewport) =>
                    updateLayout((l) => {
                      l.viewport = viewport
                    })
                : undefined}
            />
          </SvelteFlow>
        {/key}
      </div>
      <div class="legend">
        <span>━ 物理</span>
        <span>┄ 無線</span>
        <span>╌ 論理</span>
        <span>? 推定・不明</span>
        <span class="badge ng">要対応</span>
        <span class="badge unchecked">未確認</span>
        <span class="badge ok">問題なし</span>
        <span class="badge na">対象外</span>
      </div>
    </div>
    {#if selectedDevice || edge}
      <aside class="detail map-detail">
        <h3>{selectedDevice?.name ?? '接続の詳細'}</h3>
        <dl>
          {#each Object.entries(selectedDevice ?? edge ?? {}) as [key, value]}
            <dt>{labels[key] ?? key}</dt>
            <dd>{renderValue(value)}</dd>
          {/each}
        </dl>
        {#if workspace}
          <a href={entityHref(selectedDevice?.id ?? edge?.id ?? null)}>台帳・詳細を開く</a>
        {/if}
        {#if selectedDevice && workspace}
          <button
            type="button"
            onclick={() =>
              updateLayout((l) => {
                const pos =
                  l.positions[selectedDevice.id] ??
                  autoLayout(doc, activeSite, l)[selectedDevice.id]!
                l.positions[selectedDevice.id] = { ...pos, pinned: !pos.pinned }
              })}
          >
            配置の固定を切り替え
          </button>
          <button
            type="button"
            onclick={() => {
              updateLayout((l) => l.hidden.push(selectedDevice.id))
              selectedId = ''
            }}
          >
            図から除外（台帳には保持）
          </button>
        {/if}
        <h4>関連する監査</h4>
        {#each doc.auditResults.filter(
          (r) =>
            r.targetRef?.id === (selectedDevice?.id ?? edge?.id) &&
            (!roundId || r.roundId === roundId),
        ) as r}
          <p>
            <span class={`badge ${r.judgment}`}>{valueLabels[r.judgment]}</span>
            No.{r.itemNo}
            ·{r.checkedDate ?? '未確認'}
          </p>
        {:else}
          <p class="muted">監査記録なし</p>
        {/each}
      </aside>
    {/if}
  </div>
  {#if !doc.sites.length}
    <p class="empty">開始・プロジェクトで拠点を登録してください。</p>
  {/if}
  {#if workspace}
    <details class="layout-settings">
      <summary>図の配置・ビューポート・除外対象を管理</summary>
      <a href="#/topology/layouts">図の配置を編集</a>
      <button type="button" onclick={() => updateLayout((l) => (l.hidden = []))}>
        除外した機器をすべて戻す
      </button>
    </details>
  {/if}
</section>
