<script lang="ts">
  import { Handle, type NodeProps, Position, useStore } from '@xyflow/svelte'
  import type { DeviceData } from '../lib/graph'
  import { valueLabels } from '../lib/presentation'
  import DeviceIcon from './DeviceIcon.svelte'

  let { data, selected }: NodeProps = $props()
  const d = $derived(data as DeviceData)
  const flow = useStore()
</script>
<div
  class="device-node"
  class:compact={flow.viewport.zoom < 0.65}
  class:unknown-node={d.unknown}
  class:node-selected={selected}
>
  <div class="node-heading">
    <DeviceIcon kind={d.kind} />
    <div class="node-kind">
      {d.unknown ? '不明端点' : (valueLabels[d.kind] ?? d.kind)}
      {d.pinned ? ' / 固定' : ''}
    </div>
  </div>
  <strong>{d.label}</strong>
  {#if flow.viewport.zoom >= 0.55}
    <p>{d.ip}</p>
    <small>{d.location} ·{valueLabels[d.observation]}</small>
  {/if}
  <div class={`badge ${d.badge.judgment}`}>
    {d.badge.label}
    {d.badge.count > 1 ? ` · ${d.badge.count}件` : ''}
  </div>
  {#if d.hiddenConnections}
    <small>非表示の接続{d.hiddenConnections}件</small>
  {/if}
  <Handle id="device" type="source" position={Position.Right} style="top:20px" />
  {#each d.ports as port, i (port.id)}
    <Handle
      id={port.id}
      type="source"
      position={Position.Left}
      style={`top:${40 + i * 12}px`}
      title={port.name}
    />
  {/each}
</div>
