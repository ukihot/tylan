<script lang="ts">
  let { kind }: { kind: string } = $props()
</script>

<svg
  class="device-icon"
  viewBox="0 0 32 32"
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  stroke-linejoin="round"
  aria-hidden="true"
>
  {#if kind === 'switch' || kind === 'serviceAdapter'}
    <rect x="3" y="10" width="26" height="15" rx="2" />
    <path d="M3 15h26M7 19h3v3H7zM13 19h3v3h-3zM19 19h3v3h-3zM25 20h1" />
    {#if kind === 'serviceAdapter'}
      <path d="M16 3v7M11 6l5-3 5 3" />
    {:else}
      <path d="M7 6h18M10 3h12" />
    {/if}
  {:else if kind === 'ap' || kind === 'repeater'}
    <path d="M5 10a16 16 0 0 1 22 0M9 14a10 10 0 0 1 14 0M13 18a4 4 0 0 1 6 0" />
    <rect x="6" y="23" width="20" height="5" rx="2" />
    <path d="M16 21v2" />
  {:else if kind === 'nas'}
    <rect x="6" y="3" width="20" height="26" rx="2" />
    <path d="M10 8h12M10 14h12M10 20h12M10 25h3M19 25h3" />
  {:else if kind === 'printer'}
    <path d="M9 12V3h14v9M9 24H4V12h24v12h-5M9 19h14v10H9zM23 16h2" />
  {:else if kind === 'camera'}
    <path d="m4 7 23 5-3 11L2 17zM14 22v7M8 29h14M24 15l6 1-2 7-5-2" />
  {:else if kind === 'unknown'}
    <path d="m16 2 14 14-14 14L2 16zM12 12a4 4 0 1 1 6 3c-2 1-2 2-2 4M16 22v2" />
  {:else}
    <rect x="3" y="4" width="26" height="19" rx="2" />
    <path d="M3 19h26M16 23v5M9 28h14" />
  {/if}
</svg>
