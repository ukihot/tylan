<script lang="ts">
  import { getViewportForBounds, useSvelteFlow } from '@xyflow/svelte'
  import { toPng } from 'html-to-image'

  let {
    element,
    title,
    onsave,
    focusIds = [],
  }: {
    element: HTMLDivElement | undefined
    title: string
    onsave?: (viewport: { x: number; y: number; zoom: number }) => void
    focusIds?: string[]
  } = $props()
  const flow = useSvelteFlow()
  let error = $state('')
  let busy = $state(false)
  let imageScope = $state('all')
  async function png() {
    if (!element) {
      return
    }
    busy = true
    error = ''
    const previous = flow.getViewport()
    try {
      const bounds = flow.getNodesBounds(flow.getNodes())
      const width = element.clientWidth
      const height = element.clientHeight - 90
      if (imageScope === 'all') {
        await flow.setViewport(getViewportForBounds(bounds, width, height, 0.05, 2, 0.15))
      }
      const data = await toPng(element, {
        backgroundColor: '#f8fafc',
        pixelRatio: 2,
        skipFonts: true,
        filter: (node) => !node.classList?.contains('export-omit'),
      })
      const link = document.createElement('a')
      link.href = data
      link.download = `${title}.png`
      link.click()
    } catch (e) {
      error = `PNGを書き出せません。印刷も利用できます：${e instanceof Error ? e.message : e}`
    } finally {
      await flow.setViewport(previous)
      busy = false
    }
  }
</script>
<div class="graph-actions export-omit">
  {#if onsave}
    <button type="button" onclick={() => onsave?.(flow.getViewport())}>表示範囲を保存</button>
  {/if}
  <button type="button" onclick={() => flow.fitView({ padding: 0.18 })}>全体を表示</button>
  <button
    type="button"
    disabled={!focusIds.length}
    onclick={() => flow.fitView({ nodes: focusIds.map((id) => ({ id })), padding: 0.3 })}
  >
    検索結果へ移動
  </button>
  <label>
    画像の範囲<select bind:value={imageScope}>
      <option value="all">全体図</option>
      <option value="viewport">表示範囲</option>
    </select>
  </label>
  <button type="button" disabled={busy} onclick={png}>{busy ? '画像生成中…' : 'PNG出力'}</button>
  <button type="button" onclick={() => window.print()}>印刷</button>
  {#if error}
    <span role="alert">{error}</span>
  {/if}
</div>
