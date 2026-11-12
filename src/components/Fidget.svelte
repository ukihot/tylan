<script lang="ts">
  import { flip } from 'svelte/animate'
  import { fade, fly } from 'svelte/transition'
  import { fidget } from '../lib/fidget.svelte'

  /** Newest at the bottom; older lines are pushed up and off past this many. */
  const MAX_LINES = 4
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const motion = still ? 0 : 200
  const frames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
  let frame = $state(0)
  const busy = $derived(fidget.lines.some((l) => !l.done))
  $effect(() => {
    if (!busy) {
      return
    }
    const timer = setInterval(() => (frame = (frame + 1) % frames.length), 100)
    return () => clearInterval(timer)
  })
</script>

<div class="fidget" role="status" aria-live="polite">
  {#each fidget.lines.slice(-MAX_LINES) as line (line.key)}
    <p
      class:done={line.done}
      animate:flip={{ duration: motion }}
      in:fly={{ y: 12, duration: motion }}
      out:fade={{ duration: motion }}
    >
      <span>{line.text}</span>
      {#if line.detail}
        <span class="detail">{line.detail}</span>
      {/if}
      <b aria-hidden="true">{line.done ? '✔' : frames[frame]}</b>
    </p>
  {/each}
</div>

<style>
  .fidget {
    position: fixed;
    right: 16px;
    bottom: 12px;
    z-index: var(--z-toast);
    max-width: min(560px, calc(100% - 32px));
    color: var(--muted);
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.6;
    text-align: right;
    pointer-events: none;
  }
  p {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .detail {
    margin-left: 1ch;
  }
  b {
    display: inline-block;
    width: 2ch;
    font-weight: 400;
  }
  .done {
    opacity: 0.6;
  }
</style>
