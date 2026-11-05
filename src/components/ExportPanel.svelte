<script lang="ts">
  import viewerTemplate from 'virtual:viewer-template'
  import { documentCsv } from '../lib/csv'
  import { exportFilename, prepareExport } from '../lib/io'
  import { canWriteFiles, download, nowJst, saveAs } from '../lib/platform'
  import { labels } from '../lib/presentation'
  import { createViewer, toPublic } from '../lib/publish'
  import { entityHref } from '../lib/routes'
  import type { Workspace } from '../lib/store.svelte'

  let { workspace }: { workspace: Workspace } = $props()
  let updatedBy = $state('')
  let message = $state('')
  let error = $state('')
  let previewed = $state('')
  const doc = $derived(workspace.doc)
  const settings = $derived(doc.publishSettings)
  // The JSON file is edited directly; only the fallback (no file access) needs JSON download buttons.
  const directSave = canWriteFiles()
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
  function guard(action: () => void) {
    error = ''
    message = ''
    try {
      action()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }
  function json() {
    guard(() => {
      const now = nowJst()
      const out = prepareExport(doc, now, updatedBy || null)
      download(out.text, out.filename)
      workspace.exportJson(now, updatedBy || null)
      message =
        'JSONの書き出しを要求しました。共有上の正本への反映は未確認です。ダウンロード先と版を確認してください。'
    })
  }
  function pair() {
    guard(() => {
      const now = nowJst()
      const out = prepareExport(doc, now, updatedBy || null)
      const pub = toPublic(out.doc, settings, now)
      const html = createViewer(viewerTemplate, pub)
      download(out.text, out.filename)
      download(
        html,
        exportFilename('viewer', out.doc.project.revision, now, 'html'),
        'text/html;charset=utf-8',
      )
      workspace.exportJson(now, updatedBy || null)
      message =
        '同じ版のJSON・閲覧用HTMLの書き出しを要求しました。両方のダウンロードを確認してください。共有への反映は未確認です。'
    })
  }
  async function save(content: string, filename: string, type: string, what: string) {
    error = ''
    message = ''
    try {
      const result = await saveAs(content, filename, type)
      if (result === 'saved') {
        message = `${what}を保存しました。`
      } else if (result === 'downloaded') {
        message = `${what}のダウンロードを要求しました。保存先を確認してください。`
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }
  function viewer() {
    let html = ''
    guard(() => {
      html = createViewer(viewerTemplate, toPublic(doc, settings, nowJst()))
    })
    if (html) {
      void save(
        html,
        exportFilename('viewer', doc.project.revision, nowJst(), 'html'),
        'text/html;charset=utf-8',
        `閲覧用HTML（r${String(doc.project.revision).padStart(4, '0')}）`,
      )
    }
  }
  function csv(kind: 'assets' | 'ports' | 'audit' | 'actions') {
    let text = ''
    guard(() => {
      text = documentCsv(doc, kind)
    })
    if (text) {
      void save(
        text,
        exportFilename(kind, doc.project.revision, nowJst(), 'csv'),
        'text/csv;charset=utf-8',
        'CSV',
      )
    }
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
  {#if !directSave}
    <h3>正本JSON</h3>
    <label>更新者<input bind:value={updatedBy} maxlength="100" placeholder="未設定"></label>
    <button type="button" onclick={json}>JSONを書き出す</button>
    <p class="hint">
      版を1つ増やしてダウンロードを要求します。共有上の現行版と編集開始版を照合し、旧版をarchiveへ退避してください。
    </p>
  {/if}
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
    {#if !directSave}
      <button
        type="button"
        class="primary"
        disabled={!counts || !settings.siteIds.length || previewed !== settingsKey}
        onclick={pair}
      >
        JSON・閲覧用HTMLを同じ版で書き出す
      </button>
    {/if}
    <button
      type="button"
      class:primary={directSave}
      disabled={workspace.saveState === 'dirty' ||
        !counts ||
        !settings.siteIds.length ||
        previewed !== settingsKey}
      onclick={viewer}
    >
      {directSave ? '閲覧用HTMLを保存' : '現在版の閲覧用HTMLを書き出す'}
    </button>
  </div>
  <p class="hint">
    {directSave
      ? '保存先は共有フォルダの published を選んでください。閲覧用HTMLはJSONの保存済みの版で作り、以後の変更は自動では反映されません。'
      : '候補はダウンロード先にも残ります。社内規則に従って保管してください。JSONとHTMLは自動同期しません。'}
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
