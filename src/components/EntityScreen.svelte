<script lang="ts">
  import { onDestroy } from 'svelte'
  import { placementCount, removalReferences } from '../lib/commands'
  import { createId } from '../lib/platform'
  import { collectionLabels, draftFor, entityTitle, labels, valueLabels } from '../lib/presentation'
  import { entityHref } from '../lib/routes'
  import { type Collection, type EntityMap, entitySchemas, prefixes } from '../lib/schema'
  import type { Workspace } from '../lib/store.svelte'
  import FieldEditor from './FieldEditor.svelte'

  let {
    workspace,
    collection,
    selectedId = '',
    onchange = () => {},
    ondraftchange = () => {},
    targetId = '',
  }: {
    workspace: Workspace
    collection: Collection
    selectedId?: string
    onchange?: () => void
    ondraftchange?: (active: boolean) => void
    targetId?: string
  } = $props()
  let query = $state('')
  let sortAsc = $state(true)
  let selected = $state('')
  let draft = $state<EntityMap[Collection] | null>(null)
  let confirmDelete = $state(false)
  let siteFilter = $state('')
  let roundFilter = $state('')
  let scopeFilter = $state('')
  let deviceFilter = $state('')
  const title = $derived(collectionLabels[collection])
  const doc = $derived(workspace.doc)
  const records = $derived(
    doc[collection]
      .filter((e) => entityTitle(e, doc).toLowerCase().includes(query.toLowerCase()))
      .filter((e) => !siteFilter || !('siteId' in e) || e.siteId === siteFilter)
      .filter((e) => !roundFilter || !('roundId' in e) || e.roundId === roundFilter)
      .filter((e) => !scopeFilter || !('scope' in e) || e.scope === scopeFilter)
      .filter((e) => {
        const device = deviceFilter || targetId
        if (!device) {
          return true
        }
        if ('deviceId' in e) {
          return e.deviceId === device
        }
        if ('targetRef' in e) {
          return e.targetRef?.id === device
        }
        if ('a' in e) {
          return [e.a, e.b].some((ep) => 'deviceId' in ep && ep.deviceId === device)
        }
        return true
      })
      .toSorted(
        (a, b) => entityTitle(a, doc).localeCompare(entityTitle(b, doc), 'ja') * (sortAsc ? 1 : -1),
      ),
  )
  const current = $derived(doc[collection].find((e) => e.id === (selected || selectedId)))
  const refs = $derived(current ? removalReferences(doc, collection, current.id) : [])
  function add() {
    draft = draftFor(collection, createId(prefixes[collection]), doc)
    confirmDelete = false
    workspace.clearIssues()
    ondraftchange(true)
  }
  function editCurrent() {
    if (!current) {
      return
    }
    draft = structuredClone(current)
    workspace.clearIssues()
    ondraftchange(true)
  }
  function discardDraft() {
    draft = null
    workspace.clearIssues()
    ondraftchange(false)
  }
  onDestroy(() => ondraftchange(false))
  function save() {
    const value = $state.snapshot(draft) as EntityMap[typeof collection]
    const ok =
      collection === 'auditRounds' && !doc.auditRounds.some((r) => r.id === value.id)
        ? workspace.startRound(value as EntityMap['auditRounds'])
        : workspace.upsert(collection, value)
    if (ok) {
      selected = value.id
      draft = null
      ondraftchange(false)
      onchange()
    }
  }
  const display = (value: unknown): string => {
    if (value == null || value === '') {
      return '未確認・未設定'
    }
    if (typeof value === 'boolean') {
      return value ? 'はい' : 'いいえ'
    }
    if (Array.isArray(value)) {
      return value.length ? value.map(display).join(' / ') : 'なし'
    }
    if (typeof value === 'object') {
      return Object.entries(value)
        .map(([k, v]) => `${labels[k] ?? k}：${display(v)}`)
        .join(' / ')
    }
    const str = String(value)
    for (const list of Object.keys(prefixes) as Collection[]) {
      const entity = doc[list].find((e) => e.id === str)
      if (entity) {
        return entityTitle(entity, doc)
      }
    }
    return valueLabels[str] ?? str
  }
</script>

<section class="panel entity-panel">
  <div class="section-head">
    <div>
      <h2>{title}</h2>
    </div>
    <button type="button" class="primary" disabled={!!draft} onclick={add}>{title}を追加</button>
  </div>
  <div class="toolbar wrap">
    <label>検索<input type="search" bind:value={query} placeholder={`${title}を検索`}></label>
    <button type="button" class="quiet" onclick={() => (sortAsc = !sortAsc)}>
      名称順{sortAsc ? '↑' : '↓'}
    </button>
    <span>{records.length}件</span>
    {#if ['devices', 'locations', 'segments', 'wirelessNetworks', 'auditResults'].includes(
      collection,
    )}
      <label>
        一覧の拠点<select bind:value={siteFilter}>
          <option value="">すべて</option>
          {#each doc.sites as site}
            <option value={site.id}>{site.name}</option>
          {/each}
        </select>
      </label>
    {/if}
    {#if collection === 'auditResults'}
      <label>
        一覧の回次<select bind:value={roundFilter}>
          <option value="">すべて</option>
          {#each doc.auditRounds as round}
            <option value={round.id}>{round.name}</option>
          {/each}
        </select>
      </label>
      <label>
        総括・対象別<select bind:value={scopeFilter}>
          <option value="">すべて</option>
          <option value="summary">拠点総括</option>
          <option value="target">対象別</option>
        </select>
      </label>
    {/if}
    {#if collection === 'ports' || collection === 'links'}
      <label>
        一覧の機器<select bind:value={deviceFilter}>
          <option value="">すべて</option>
          {#each doc.devices as device}
            <option value={device.id}>{device.name}</option>
          {/each}
        </select>
      </label>
    {/if}
  </div>
  <div class="entity-layout">
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>名称・対象</th>
            {#if collection === 'devices'}
              <th>種別・型番</th>
              <th>IPアドレス</th>
            {/if}
            <th>状態・識別</th>
          </tr>
        </thead>
        <tbody>
          {#each records as record (record.id)}
            <tr class:selected={current?.id === record.id}>
              <td data-label="名称・対象">
                <button
                  disabled={!!draft}
                  type="button"
                  class="text-button"
                  onclick={() => {
                    selected = record.id
                    discardDraft()
                    confirmDelete = false
                    workspace.clearIssues()
                  }}
                >
                  {entityTitle(record, doc)}
                </button>
              </td>
              {#if collection === 'devices'}
                <td data-label="種別・型番">
                  {'kind' in record && record.kind ? (valueLabels[record.kind] ?? record.kind) : ''}
                  <small class="cell-secondary">
                    {'model' in record ? (record.model ?? '型番未確認') : ''}
                  </small>
                </td>
                <td class="cell-address" data-label="IPアドレス">
                  {doc.ipAssignments
                    .filter((a) =>
                      doc.ports.some((p) => p.id === a.portId && p.deviceId === record.id),
                    )
                    .map((a) => a.address)
                    .filter(Boolean)
                    .join(' / ') || '未確認'}
                </td>
              {/if}
              <td class="muted" data-label="状態・識別">
                {'judgment' in record
                  ? display(record.judgment)
                  : 'progress' in record
                    ? display(record.progress)
                    : 'observation' in record
                      ? display(record.observation)
                      : record.id}
              </td>
            </tr>
          {:else}
            <tr>
              <td colspan={collection === 'devices' ? 4 : 2} class="empty">
                まだ登録されていません。{title}を追加して調査を始めます。
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if draft}
      <form
        class="detail"
        onsubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <h3>{title}の{current?.id === draft.id ? '編集' : '新規登録'}</h3>
        <p class="hint">不明な値は「未確認・未設定」のまま記録できます。</p>
        {#if collection === 'auditRounds'}
          <p class="notice">新規回次は選択拠点ごとに20項目を未確認で作成します。</p>
        {/if}
        {#if workspace.issues.length}
          <div role="alert" class="error">
            {#each workspace.issues as issue}
              <p>{issue.message}（{issue.path}）</p>
            {/each}
          </div>
        {/if}
        <FieldEditor
          schema={entitySchemas[collection]}
          bind:value={draft}
          {doc}
          issues={workspace.issues}
          path={`${collection}.${doc[collection].some((e) => e.id === draft?.id) ? doc[collection].findIndex((e) => e.id === draft?.id) : doc[collection].length}`}
          root
        />
        <div class="sticky-actions">
          <button type="submit" class="primary">確定</button>
          <button type="button" onclick={discardDraft}>キャンセル</button>
        </div>
      </form>
    {:else if current}
      <aside class="detail">
        <div class="section-head">
          <h3>{entityTitle(current, doc)}</h3>
          <button type="button" onclick={editCurrent}>編集</button>
        </div>
        <dl>
          {#each Object.entries(current) as [key, value]}
            <dt>{labels[key] ?? key}</dt>
            <dd>{display(value)}</dd>
          {/each}
        </dl>
        {#if collection === 'devices'}
          <p>
            <a href={`#/ports/ports?target=${current.id}`}>関連ポート・接続へ</a>
            <a href={`#/audit/auditResults?target=${current.id}`}>関連する監査へ</a>
          </p>
          <button
            type="button"
            onclick={() =>
              workspace.commit((d) => {
                const device = d.devices.find((e) => e.id === current.id)!
                device.usage = 'retired'
              })}
          >
            使用終了（撤去済み）にする
          </button>
        {/if}
        {#if collection === 'auditResults'}
          {@const audit = current as EntityMap['auditResults']}
          {@const item = doc.auditTemplate.items.find((i) => i.no === audit.itemNo)}
          <h4>確認内容</h4>
          <p>{item?.content}</p>
          <p>{item?.method}</p>
          {@const previous = doc.auditResults
            .filter(
              (r) =>
                r.id !== audit.id &&
                r.roundId !== audit.roundId &&
                r.siteId === audit.siteId &&
                r.itemNo === audit.itemNo &&
                r.scope === audit.scope &&
                r.targetRef?.id === audit.targetRef?.id,
            )
            .at(-1)}
          <p class="notice">
            前回結果：{previous
              ? `${valueLabels[previous.judgment]} / ${previous.checkedDate ?? '確認日未設定'} / ${previous.finding ?? ''}`
              : '記録なし'}
          </p>
          <button
            type="button"
            onclick={() => {
              const action = draftFor('actionItems', createId('act'), doc)
              action.auditResultIds = [current.id]
              action.targetRef = audit.targetRef
              action.content = audit.problem ?? '確認・対応内容を記録してください'
              workspace.upsert('actionItems', action)
            }}
          >
            対応事項を作成
          </button>
        {/if}
        <div class="danger-zone">
          {#if refs.length}
            <p>参照が{refs.length}件あるため削除できません。</p>
            <ul>
              {#each refs as ref}
                <li>
                  <a href={entityHref(ref.entityId, ref.path)}>
                    {ref.entityId ? display(ref.entityId) : ref.path}（{ref.path}）
                  </a>
                </li>
              {/each}
            </ul>
          {:else if confirmDelete}
            <p>
              「{entityTitle(current, doc)}」を削除します。{collection === 'devices'
                ? `未参照の配下ポート${doc.ports.filter((p) => p.deviceId === current.id).length}件も削除します。`
                : ''}
              {placementCount(doc, current.id)
                ? `図の配置・非表示設定${placementCount(doc, current.id)}件も削除します。`
                : ''}
            </p>
            <button
              type="button"
              class="danger"
              onclick={() => {
                if (workspace.remove(collection, current.id)) {
                  selected = ''
                  confirmDelete = false
                }
              }}
            >
              削除を確定
            </button>
            <button type="button" onclick={() => (confirmDelete = false)}>中止</button>
          {:else}
            <button type="button" class="quiet danger" onclick={() => (confirmDelete = true)}>
              削除
            </button>
          {/if}
        </div>
      </aside>
    {/if}
  </div>
</section>
