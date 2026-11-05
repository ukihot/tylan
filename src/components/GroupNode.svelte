<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte'

  let { data }: NodeProps = $props()
</script>
<span class="group-label">{String(data.label)}</span>
