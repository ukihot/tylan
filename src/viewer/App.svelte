<script lang="ts">
  import Topology from '../components/Topology.svelte'
  import { labels, valueLabels } from '../lib/presentation'
  import type { PublicDoc } from '../lib/publish'

  let { doc, error = '' }: { doc?: PublicDoc; error?: string } = $props()
  let query = $state('')
  let siteId = $state('')
  let roundId = $state('')
  const siteName = (id: string) => doc?.sites.find((s) => s.id === id)?.name ?? id
  function text(value: unknown): string {
    return value == null
      ? '未確認・未設定'
      : typeof value === 'object'
        ? JSON.stringify(value)
        : (valueLabels[String(value)] ?? String(value))
  }
</script>
{#if error || !doc}
  <section role="alert" class="error viewer-error">
    <h1>閲覧データを表示できません</h1>
    <p>{error || '公開データがありません。編集ツールから再生成してください。'}</p>
  </section>
{:else}
  <div class="viewer-shell">
    <div class="viewer-masthead">
      <strong>tylan</strong>
      <span>ネットワーク調査・管理</span>
      <span>閲覧専用</span>
    </div>
    <header>
      <div>
        <h1>{doc.project.name}</h1>
        <p class="muted">
          データ版 r{String(doc.project.revision).padStart(4, '0')}
          / 調査基準日{doc.project.surveyDate ?? '未設定'}
          <br>
          生成日時{doc.project.generatedAt} / アプリ{doc.project.appVersion}
        </p>
      </div>
    </header>
    <Topology {doc} />
    <section class="panel">
      <h2>公開資産台帳</h2>
      <label>
        資産検索<input type="search" bind:value={query} placeholder="名称・型番・IP・設置場所">
      </label>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>名称</th>
              <th>種別</th>
              <th>型番</th>
              <th>IP</th>
              <th>拠点・設置場所</th>
              <th>追加公開項目</th>
            </tr>
          </thead>
          <tbody>
            {#each doc.devices.filter(
              (d) =>
                JSON.stringify(d).toLowerCase().includes(query.toLowerCase()) ||
                doc?.ipAssignments.some(
                  (a) =>
                    a.address?.includes(query) &&
                    doc?.ports.some((p) => p.id === a.portId && p.deviceId === d.id),
                ) ||
                doc?.locations.some((l) => l.id === d.locationId && l.name.includes(query)),
            ) as d}
              <tr>
                <td data-label="名称">{d.name}</td>
                <td data-label="種別">{valueLabels[d.kind]}</td>
                <td data-label="型番">{d.model ?? '未確認'}</td>
                <td data-label="IP">
                  {doc.ipAssignments
                    .filter((a) => doc?.ports.some((p) => p.id === a.portId && p.deviceId === d.id))
                    .map((a) => a.address)
                    .filter(Boolean)
                    .join(' / ') || '未確認'}
                </td>
                <td data-label="拠点・設置場所">
                  {siteName(d.siteId)}
                  /{doc.locations.find((l) => l.id === d.locationId)?.name ?? '未確認'}
                </td>
                <td data-label="追加公開項目">
                  {#each Object.entries(d).filter(([key]) =>
                    ['serial', 'owner', 'administrator', 'supportContact', 'notes'].includes(key),
                  ) as [key, value]}
                    <p>{labels[key]}：{text(value)}</p>
                  {/each}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
    <section class="panel">
      <h2>公開監査結果</h2>
      <div class="toolbar">
        <label>
          監査の拠点<select bind:value={siteId}>
            <option value="">すべて</option>
            {#each doc.sites as s}
              <option value={s.id}>{s.name}</option>
            {/each}
          </select>
        </label>
        <label>
          監査の回次<select bind:value={roundId}>
            <option value="">すべて</option>
            {#each doc.auditRounds as r}
              <option value={r.id}>{r.name}</option>
            {/each}
          </select>
        </label>
      </div>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>No.</th>
              <th>拠点</th>
              <th>対象</th>
              <th>回次</th>
              <th>判定</th>
              <th>確認日</th>
            </tr>
          </thead>
          <tbody>
            {#each doc.auditResults.filter(
              (r) => (!siteId || r.siteId === siteId) && (!roundId || r.roundId === roundId),
            ) as r}
              <tr>
                <td data-label="No.">{r.itemNo}</td>
                <td data-label="拠点">{siteName(r.siteId)}</td>
                <td data-label="対象">
                  {r.targetRef
                    ? (doc.devices.find((d) => d.id === r.targetRef?.id)?.name ?? r.targetRef.id)
                    : '拠点総括'}
                </td>
                <td data-label="回次">{doc.auditRounds.find((a) => a.id === r.roundId)?.name}</td>
                <td data-label="判定">
                  <span class={`badge ${r.judgment}`}>{valueLabels[r.judgment]}</span>
                  {#if r.finding}
                    <p>{r.finding}</p>
                  {/if}
                  {#if r.problem}
                    <p>{r.problem}</p>
                  {/if}
                </td>
                <td data-label="確認日">{r.checkedDate ?? '未確認'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>
    {#if doc.evidence}
      <section class="panel">
        <h2>公開証跡参照</h2>
        {#each doc.evidence as e}
          <p>
            {e.description}
            /{e.referenceNumber ?? '管理番号未設定'} /{e.storageLocation ?? '保管先未設定'}
          </p>
        {/each}
      </section>
    {/if}
    {#if doc.actionItems}
      <section class="panel">
        <h2>公開対応事項</h2>
        {#each doc.actionItems as a}
          <p>
            {a.content}
            /{valueLabels[a.progress]} /{a.assignee ?? '担当未定'} /{a.dueDate ?? '期限未定'}
          </p>
        {/each}
      </section>
    {/if}
    <footer class="page-footer">
      このHTMLは生成時点のスナップショットです。正本更新後は再生成・再公開が必要です。線は実通信を保証しません。
    </footer>
  </div>
{/if}
