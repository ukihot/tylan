<script lang="ts">
  import { z } from 'zod'
  import { entityTitle, labels, unwrap, valueLabels } from '../lib/presentation'
  import { type Collection, type Doc, schemaSeed } from '../lib/schema'
  import type { Issue } from '../lib/validate'
  import FieldEditor from './FieldEditor.svelte'

  // Values are heterogeneous Zod-checked drafts; they never mutate the canonical document.
  let {
    schema,
    value = $bindable(),
    fieldKey = '',
    path = '',
    doc,
    root = false,
    targetType = '',
    issues = [],
  }: {
    schema: z.ZodType
    // biome-ignore lint/suspicious/noExplicitAny: Recursive bindings follow a runtime Zod schema; only validated drafts can cross the commit boundary.
    value: any
    fieldKey?: string
    path?: string
    doc: Doc
    root?: boolean
    targetType?: string
    issues?: Issue[]
  } = $props()
  const inner = $derived(unwrap(schema))
  const nullable = $derived(schema instanceof z.ZodNullable || schema instanceof z.ZodOptional)
  const label = $derived(labels[fieldKey] ?? fieldKey)
  const refCollection = $derived(
    (inner.meta()?.ref as Collection | undefined) ??
      (fieldKey === 'id' && targetType
        ? (
            {
              device: 'devices',
              link: 'links',
              port: 'ports',
              segment: 'segments',
              wirelessNetwork: 'wirelessNetworks',
            } as Record<string, Collection>
          )[targetType]
        : undefined),
  )
  let recordKey = $state('')
  function setNull(event: Event) {
    value = (event.currentTarget as HTMLInputElement).checked ? null : schemaSeed(inner)
  }
</script>

{#if nullable}
  <label class="null-toggle">
    <input type="checkbox" checked={value == null} onchange={setNull}>
    {label}
    ：未確認・未設定
  </label>
{/if}
{#if value != null}
  {#if inner instanceof z.ZodUnion}
    {@const options = inner.options as z.ZodType[]}
    {@const unknown = typeof value === 'object' && 'unknown' in value}
    <fieldset>
      <legend>{label}</legend>
      <label>
        端点の種類<select
          value={unknown ? '1' : '0'}
          onchange={(e) => (value = schemaSeed(options[Number(e.currentTarget.value)]!))}
        >
          <option value="0">既知の機器</option>
          <option value="1">接続先不明</option>
        </select>
      </label>
      <FieldEditor schema={options[unknown ? 1 : 0]!} bind:value {doc} {path} {issues} />
    </fieldset>
  {:else if inner instanceof z.ZodObject}
    <div class:form-grid={root} class:object-fields={!root}>
      {#each Object.entries(inner.shape) as [key, child] (key)}
        {#if !(root && key === 'id')}
          <div class="field" id={`field-${path ? `${path}.` : ''}${key}`}>
            <FieldEditor
              schema={child as z.ZodType}
              bind:value={value[key]}
              fieldKey={key}
              path={`${path ? `${path}.` : ''}${key}`}
              {doc}
              {issues}
              targetType={value.type ?? ''}
            />
          </div>
        {/if}
      {/each}
    </div>
  {:else if inner instanceof z.ZodArray}
    <fieldset>
      <legend>{label}</legend>
      {#each value as _, index (index)}
        <div class="array-row">
          <FieldEditor
            schema={inner.element as z.ZodType}
            bind:value={value[index]}
            {fieldKey}
            path={`${path}.${index}`}
            {doc}
            {issues}
          />
          <button
            type="button"
            class="quiet"
            aria-label={`${label} ${index + 1}を除去`}
            onclick={() => (value = value.filter((_: unknown, i: number) => i !== index))}
          >
            除去
          </button>
        </div>
      {/each}
      <button
        type="button"
        class="quiet"
        onclick={() => (value = [...value, schemaSeed(inner.element as z.ZodType)])}
      >
        {label}に追加
      </button>
    </fieldset>
  {:else if inner instanceof z.ZodRecord}
    <fieldset>
      <legend>{label}</legend>
      {#each Object.keys(value) as key (key)}
        <div>
          <strong>{doc.devices.find((d) => d.id === key)?.name ?? key}</strong>
          <FieldEditor
            schema={inner.valueType as z.ZodType}
            bind:value={value[key]}
            fieldKey={key}
            path={`${path}.${key}`}
            {doc}
            {issues}
          />
          <button
            type="button"
            onclick={() => {
              const next = { ...value }
              delete next[key]
              value = next
            }}
          >
            配置を除去
          </button>
        </div>
      {/each}
      <label>
        配置対象<select bind:value={recordKey}>
          <option value="">選択してください</option>
          {#each doc.devices as d}
            <option value={d.id}>{d.name}</option>
          {/each}
        </select>
      </label>
      <button
        type="button"
        disabled={!recordKey}
        onclick={() => (value = { ...value, [recordKey]: { x: 0, y: 0, pinned: false } })}
      >
        配置を追加
      </button>
    </fieldset>
  {:else if inner instanceof z.ZodBoolean}
    <label class="check">
      <input type="checkbox" bind:checked={value}>
      {label}
    </label>
  {:else if inner instanceof z.ZodEnum}
    <label>
      {label}
      <select bind:value>
        {#each inner.options as option}
          <option value={option}>{valueLabels[String(option)] ?? option}</option>
        {/each}
      </select>
    </label>
  {:else if refCollection}
    <label>
      {label}
      <select bind:value>
        <option value="">選択してください</option>
        {#each doc[refCollection] as entity}
          <option value={entity.id}>{entityTitle(entity, doc)}</option>
        {/each}
      </select>
    </label>
  {:else if inner instanceof z.ZodNumber}
    <label>
      {label}
      <input type="number" step="any" bind:value>
    </label>
  {:else if [
    'notes',
    'description',
    'finding',
    'problem',
    'reason',
    'nextCheck',
    'content',
    'purpose',
    'completionRecord',
    'recheckRecord',
    'isolationFinding',
    'radioFinding',
    'storageLocation',
    'method',
  ].includes(fieldKey)}
    <label>
      {label}
      <textarea rows="3" maxlength="2000" bind:value></textarea>
    </label>
    <small>パスワード・PSK・資格情報は記入しない</small>
  {:else}
    <label>
      {label}
      <input
        type={fieldKey.toLowerCase().endsWith('date') ? 'date' : 'text'}
        bind:value
        maxlength={fieldKey.endsWith('At') ? 40 : 100}
      >
    </label>
  {/if}
{/if}
{#each issues.filter((issue) => issue.path === path) as issue}
  <p class="field-error">{issue.message}</p>
{/each}
