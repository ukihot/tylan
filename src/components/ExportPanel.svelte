<script lang="ts">
  import viewerTemplate from 'virtual:viewer-template'
  import { documentCsv } from '../lib/csv'
  import type { FileSession } from '../lib/file-session.svelte'
  import { exportFilename } from '../lib/io'
  import { nowJst, saveAs } from '../lib/platform'
  import { labels } from '../lib/presentation'
  import { createViewer, toPublic } from '../lib/publish'
  import { entityHref } from '../lib/routes'
  import type { Workspace } from '../lib/store.svelte'

  let { workspace, files }: { workspace: Workspace; files: FileSession } = $props()
  let message = $state('')
  let error = $state('')
  let previewed = $state('')
  const doc = $derived(workspace.doc)
  const settings = $derived(doc.publishSettings)
  // Autosave bumps the revision; that alone must not invalidate a reviewed preview.
  const settingsKey = $derived(JSON.stringify({ ...doc, project: null }))
  const counts = $derived.by(() => {
    try {
      const p = toPublic(doc, settings, nowJst())
      return {
        sites: p.sites.length,
        devices: p.devices.length,
        links: p.links.length,
        audit: p.auditResults.length,
      }
    } catch {
      return null
    }
  })
  async function run(action: () => Promise<string | null>) {
    error = ''
    message = ''
    try {
      message = (await action()) ?? ''
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }
  function viewer() {
    void run(async () => {
      const revision = `r${String(doc.project.revision).padStart(4, '0')}`
      const html = createViewer(viewerTemplate, toPublic(doc, settings, nowJst()))
      if (!(await files.publishViewer(html))) {
        throw new Error(files.message || '閲覧用HTMLを保存できませんでした')
      }
      return `閲覧用HTML（${revision}）を published\\viewer.html に保存しました。前の版は archive へ移しました。`
    })
  }
  function csv(kind: 'assets' | 'ports' | 'audit' | 'actions') {
    void run(async () => {
      const text = documentCsv(doc, kind)
      const name = exportFilename(kind, doc.project.revision, nowJst(), 'csv')
      return (await saveAs(text, name, 'text/csv;charset=utf-8'))
        ? `${name} を保存しました。`
        : null
    })
  }
</script>
<section class="panel">
  <p class="eyebrow">VALIDATION & PUBLISH</p>
  <h2>検証・書き出し</h2>
  <div class="stats">
    <div>
      <strong>{workspace.validation.errors.length}</strong>
      <span>エラー</span>
    </div>
    <div>
      <strong>{workspace.validation.warnings.length}</strong>
      <span>警告（書き出し可能）</span>
    </div>
    <div>
      <strong>{doc.project.baseRevision} →{doc.project.revision}</strong>
      <span>編集開始版 → 現在版</span>
    </div>
  </div>
  {#if !workspace.validation.errors.length}
    <p class="notice">データの構造・参照検証に通っています。警告は現地確認事項として残せます。</p>
  {/if}
  <ul class="issue-list">
    {#each [...workspace.validation.errors, ...workspace.validation.warnings] as issue}
      <li>
        <a href={entityHref(issue.entityId, issue.path)}>{issue.message}</a>
        <small>{issue.path}</small>
      </li>
    {/each}
  </ul>
  <h3>閲覧用HTMLの公開範囲</h3>
  <p>検索・図のフィルターとは独立した設定です。公開しない値はHTMLに含めません。</p>
  <fieldset>
    <legend>対象拠点</legend>
    {#each doc.sites as site}
      <label class="check">
        <input
          type="checkbox"
          checked={settings.siteIds.includes(site.id)}
          onchange={(e) =>
            workspace.commit((d) => {
              d.publishSettings.siteIds = e.currentTarget.checked
                ? [...d.publishSettings.siteIds, site.id]
                : d.publishSettings.siteIds.filter((id) => id !== site.id)
            })}
        >
        {site.name}
      </label>
    {/each}
  </fieldset>
  <p class="hint">標準：構成図、名称・種別・型番・IP・設置場所、監査番号・判定・確認日</p>
  <fieldset>
    <legend>追加で公開する項目（初期値はすべて除外）</legend>
    {#each ['serial', 'contacts', 'notes', 'evidence', 'actionItems'] as key}
      <label class="check">
        <input
          type="checkbox"
          checked={!!settings.fields[key as keyof typeof settings.fields]}
          onchange={(e) =>
            workspace.commit((d) => {
              d.publishSettings.fields[key as keyof typeof settings.fields] =
                e.currentTarget.checked
            })}
        >
        {labels[key]}
      </label>
    {/each}
  </fieldset>
  <button type="button" onclick={() => (previewed = settingsKey)}>公開プレビューを確認</button>
  {#if previewed === settingsKey && counts}
    <div class="notice">
      <strong>公開対象：</strong>
      {counts.sites}
      拠点 /{counts.devices}
      機器 /{counts.links}
      接続 /
      {counts.audit}
      監査結果
      <p>
        除外項目：{['serial', 'contacts', 'notes', 'evidence', 'actionItems']
          .filter((k) => !settings.fields[k as keyof typeof settings.fields])
          .map((k) => labels[k])
          .join('、') || 'なし'}
      </p>
      <p>選択拠点外の機器と、それに接続するリンク・監査は除外されます。</p>
    </div>
  {/if}
  <div class="toolbar">
    <button
      type="button"
      class="primary"
      disabled={workspace.saveState === 'dirty' ||
        !counts ||
        !settings.siteIds.length ||
        previewed !== settingsKey}
      onclick={viewer}
    >
      閲覧用HTMLを公開（published\viewer.html）
    </button>
  </div>
  <p class="hint">
    保存済みのJSONの版で作ります。前の viewer.html は archive
    へ移します。以後の変更は、もう一度公開するまで閲覧用HTMLに反映されません。
  </p>
  <h3>CSV</h3>
  <div class="toolbar">
    <button type="button" onclick={() => csv('assets')}>資産台帳CSV</button>
    <button type="button" onclick={() => csv('ports')}>ポートCSV</button>
    <button type="button" onclick={() => csv('audit')}>監査CSV</button>
    <button type="button" onclick={() => csv('actions')}>対応事項CSV</button>
  </div>
  {#if message}
    <p role="status" class="notice">{message}</p>
  {/if}
  {#if error}
    <p role="alert" class="error">{error}</p>
  {/if}
</section>
