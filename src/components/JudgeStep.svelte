<script lang="ts">
  import { onDestroy } from 'svelte'
  import { auditSummary, judgmentLabels } from '../lib/audit-master'
  import { createId, nowJst } from '../lib/platform'
  import { type EntityMap, newEntity } from '../lib/schema'
  import type { Workspace } from '../lib/store.svelte'

  let {
    workspace,
    siteId,
    ondraftchange = () => {},
  }: { workspace: Workspace; siteId: string; ondraftchange?: (active: boolean) => void } = $props()
  type Result = EntityMap['auditResults']
  const doc = $derived(workspace.doc)
  const rounds = $derived(doc.auditRounds.filter((r) => r.siteIds.includes(siteId)))
  let roundChoice = $state('')
  const round = $derived(rounds.find((r) => r.id === roundChoice) ?? rounds.at(-1))
  const results = $derived(
    doc.auditResults.filter((a) => a.roundId === round?.id && a.siteId === siteId),
  )
  const rows = $derived(
    results.filter((a) => a.scope === 'summary').toSorted((a, b) => a.itemNo - b.itemNo),
  )
  const summary = $derived(auditSummary(results))
  const item = (no: number) => doc.auditTemplate.items.find((i) => i.no === no)
  const segmentName = (id: string) => doc.segments.find((s) => s.id === id)?.name ?? id
  /** The policy behind three items: clients are counted, only managed devices are named. */
  const hints: Record<number, string> = {
    6: '管理機器だけが対象です。利用端末（社員PC・スマホ）の所有者はAD・資産管理の範囲です。',
    22: '管理機器は台帳、利用端末は下の台数と内訳で把握します。',
    23: '管理機器のうち今回見えなかったものを確認します（②の「今回見えなかった機器」）。',
  }
  let open = $state('')
  let draft = $state<Result | null>(null)
  let checkedBy = $state('')
  let checkedDate = $state(nowJst().slice(0, 10))
  $effect.pre(() => {
    checkedBy ||= doc.project.updatedBy ?? ''
  })
  onDestroy(() => ondraftchange(false))
  function edit(row: Result) {
    open = row.id
    draft = structuredClone($state.snapshot(row))
    workspace.clearIssues()
    ondraftchange(true)
  }
  function close() {
    open = ''
    draft = null
    workspace.clearIssues()
    ondraftchange(false)
  }
  function save() {
    const value = $state.snapshot(draft) as Result
    if (value.judgment !== 'unchecked') {
      value.checkedBy = checkedBy.trim() || null
      value.checkedDate = checkedDate || null
    }
    const ok = workspace.commit((d) => {
      const index = d.auditResults.findIndex((a) => a.id === value.id)
      // 要対応 is tracked in step 4: its action item is made here instead of a second form.
      if (value.judgment === 'ng' && !value.actionItemIds.length && value.problem) {
        const actionId = createId('act')
        d.actionItems.push({
          ...newEntity('actionItems', actionId),
          content: value.problem,
          auditResultIds: [value.id],
        })
        value.actionItemIds = [actionId]
      }
      d.auditResults[index] = value
    })
    if (ok) {
      close()
    }
  }
  const text = (value: string | null) => value ?? ''
  const set = (key: 'finding' | 'problem' | 'reason' | 'nextCheck' | 'method', value: string) => {
    draft![key] = value.trim() ? value : null
  }
</script>

<section class="panel" aria-label="20項目の判定">
  <div class="section-head">
    <h2>20項目の判定</h2>
    {#if rounds.length > 1}
      <label>
        回次<select bind:value={roundChoice}>
          {#each rounds as r}
            <option value={r.id}>{r.name}</option>
          {/each}
        </select>
      </label>
    {/if}
  </div>
  {#if !round}
    <p>まだ監査回次がありません。<a href="#/run">①実行</a>で監査を始めると20項目が用意されます。</p>
  {:else}
    <div class="stats">
      <div>
        <strong>{summary.ng}</strong>
        <span>要対応</span>
      </div>
      <div>
        <strong>{summary.unchecked}</strong>
        <span>未確認</span>
      </div>
      <div>
        <strong>{summary.ok}</strong>
        <span>問題なし</span>
      </div>
      <div>
        <strong>{summary.na}</strong>
        <span>対象外</span>
      </div>
      <div>
        <strong>{summary.targets}</strong>
        <span>対象別の結果</span>
      </div>
    </div>
    <div class="judge-who">
      <label>確認者<input bind:value={checkedBy} maxlength="100"></label>
      <label>確認日<input type="date" bind:value={checkedDate}></label>
      <span class="muted">判定を確定すると、この確認者・確認日を記録します。</span>
    </div>
    {#if round.clients.length}
      <p class="muted">
        利用端末（台数のみ）：{round.clients
          .map((c) => `${segmentName(c.segmentId)} ${c.total}台（${c.observedDate}）`)
          .join(' / ')}
      </p>
    {/if}
    <div class="table-scroll">
      <table class="judge-table">
        <thead>
          <tr>
            <th>No.</th>
            <th>項目</th>
            <th>判定</th>
            <th>確認結果・現状</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.id)}
            {@const master = item(row.itemNo)}
            {@const targets = results.filter(
              (a) => a.scope === 'target' && a.itemNo === row.itemNo,
            ).length}
            <tr class:selected={open === row.id}>
              <td>{row.itemNo}</td>
              <td>
                {master?.title}
                <small class="cell-secondary">{master?.category}</small>
              </td>
              <td>
                <span class={`judgment judgment-${row.judgment}`}>
                  {judgmentLabels[row.judgment]}
                </span>
              </td>
              <td>
                {row.finding ?? (row.attempted ? row.reason : '')}
                {#if targets}
                  <small class="cell-secondary">対象別{targets}件</small>
                {/if}
              </td>
              <td>
                <button
                  type="button"
                  disabled={!!draft && open !== row.id}
                  onclick={() => edit(row)}
                >
                  判定する
                </button>
              </td>
            </tr>
            {#if open === row.id && draft}
              <tr class="editor-row">
                <td colspan="5">
                  <form
                    onsubmit={(e) => {
                      e.preventDefault()
                      save()
                    }}
                  >
                    <p class="muted">{master?.content}（{master?.method}）</p>
                    {#if hints[row.itemNo]}
                      <p class="notice">{hints[row.itemNo]}</p>
                    {/if}
                    <fieldset class="judgments">
                      <legend>判定</legend>
                      {#each ['ok', 'ng', 'unchecked', 'na'] as const as j}
                        <label class={`judgment judgment-${j}`}>
                          <input type="radio" name="judgment" value={j} bind:group={draft.judgment}>
                          {judgmentLabels[j]}
                        </label>
                      {/each}
                    </fieldset>
                    <label>
                      確認結果・現状{draft.judgment === 'ok' || draft.judgment === 'ng'
                        ? '（必須）'
                        : ''}
                      <textarea
                        rows="3"
                        value={text(draft.finding)}
                        oninput={(e) => set('finding', e.currentTarget.value)}
                      ></textarea>
                    </label>
                    {#if draft.judgment === 'ng'}
                      <label>
                        問題点（必須。対応事項として④に追加します）
                        <textarea
                          rows="2"
                          value={text(draft.problem)}
                          oninput={(e) => set('problem', e.currentTarget.value)}
                        ></textarea>
                      </label>
                    {/if}
                    {#if draft.judgment === 'unchecked'}
                      <label class="inline">
                        <input type="checkbox" bind:checked={draft.attempted}>
                        確認を試みた（理由と次の確認方法を残す）
                      </label>
                    {/if}
                    {#if draft.judgment === 'na' ||
                      (draft.judgment === 'unchecked' && draft.attempted)}
                      <label>
                        {draft.judgment === 'na'
                          ? '対象外の理由（必須）'
                          : '確認できなかった理由（必須）'}
                        <textarea
                          rows="2"
                          value={text(draft.reason)}
                          oninput={(e) => set('reason', e.currentTarget.value)}
                        ></textarea>
                      </label>
                    {/if}
                    {#if draft.judgment === 'unchecked' && draft.attempted}
                      <label>
                        次の確認方法（必須）
                        <textarea
                          rows="2"
                          value={text(draft.nextCheck)}
                          oninput={(e) => set('nextCheck', e.currentTarget.value)}
                        ></textarea>
                      </label>
                    {/if}
                    {#if workspace.issues.length}
                      <div role="alert" class="error">
                        {#each workspace.issues as issue}
                          <p>{issue.message}（{issue.path}）</p>
                        {/each}
                      </div>
                    {/if}
                    <button type="submit" class="primary">判定を確定</button>
                    <button type="button" onclick={close}>キャンセル</button>
                    <a href={`#/judge/auditResults/${row.id}`}>証跡・対象別結果も編集する</a>
                  </form>
                </td>
              </tr>
            {/if}
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</section>

<style>
  form label,
  .judge-who label {
    display: grid;
    gap: var(--space-2xs);
    margin: var(--space-xs) 0;
  }
  .judge-who {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: var(--space-sm);
    margin-bottom: var(--space-md);
  }
  label.inline {
    display: flex;
    align-items: center;
    gap: var(--space-xs);
  }
  .judgments {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-sm);
    border: 0;
    padding: 0;
  }
  .judgments label {
    display: flex;
    align-items: center;
    gap: var(--space-2xs);
    padding: var(--space-2xs) var(--space-sm);
  }
  .judgment {
    display: inline-block;
    padding: 0 var(--space-2xs);
    border: 1px solid var(--line);
    white-space: nowrap;
  }
  .judgment-ok {
    border-color: var(--success-line);
    background: var(--success-face);
    color: var(--success-ink);
  }
  .judgment-ng {
    border-color: var(--error-line);
    background: var(--error-face);
    color: var(--error-ink);
  }
  .judgment-unchecked {
    border-color: var(--warning-line);
    background: var(--warning-face);
    color: var(--warning-ink);
  }
  .judgment-na {
    background: var(--paper-muted);
    color: var(--muted);
  }
  .editor-row td {
    background: var(--surface);
  }
  .editor-row form {
    max-width: 880px;
  }
  textarea {
    width: 100%;
  }
</style>
