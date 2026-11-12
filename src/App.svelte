<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import AuditPanel from './components/AuditPanel.svelte'
  import EntityScreen from './components/EntityScreen.svelte'
  import ExportPanel from './components/ExportPanel.svelte'
  import Fidget from './components/Fidget.svelte'
  import FieldEditor from './components/FieldEditor.svelte'
  import JudgeStep from './components/JudgeStep.svelte'
  import Topology from './components/Topology.svelte'
  import { auditSummary } from './lib/audit-master'
  import { fidget } from './lib/fidget.svelte'
  import { createFileSession } from './lib/file-session.svelte'
  import { type Folder, launcherFolder } from './lib/folder'
  import { nowJst } from './lib/platform'
  import { collectionLabels } from './lib/presentation'
  import { entityHref, ledgerGroups, type Step, stepCollections, steps } from './lib/routes'
  import { type Collection, type Doc, ProjectSchema } from './lib/schema'
  import { createWorkspace } from './lib/store.svelte'

  // Tests pass an in-memory folder; in use it is the local data folder, reached through launcher\tylan.cmd.
  let props: { folder?: Folder | null } = $props()
  const workspace = createWorkspace()
  // Read once at start: the folder never changes during a session.
  const folder = untrack(() => (props.folder === undefined ? launcherFolder() : props.folder))
  // Editing always happens inside a JSON file in the data\working folder: no file, no editing.
  const files = folder ? createFileSession(workspace, folder) : null
  onMount(() => {
    if (!files) {
      return
    }
    void files.connect()
    // Hidden tabs are throttled to about one timer per minute; the launcher waits 3 minutes.
    const ping = () => void files.ping()
    const timer = setInterval(ping, 10000)
    document.addEventListener('visibilitychange', ping)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', ping)
    }
  })
  const thisYear = `network-${nowJst().slice(0, 4)}.json`
  let newName = $state(thisYear)
  let copyChoice = $state<string | null>(null)
  let hash = $state(window.location.hash)
  let siteChoice = $state('')
  let projectDraft = $state<Doc['project'] | null>(null)
  let pending = $state<(() => void) | null>(null)
  let entityEditing = $state(false)
  let session = $state(0)
  const editing = $derived(entityEditing || projectDraft !== null)
  const route = $derived(hash.split('?')[0]!.replace(/^#\/?/, '').split('/'))
  const targetId = $derived(new URLSearchParams(hash.split('?')[1] ?? '').get('target') ?? '')
  const step = $derived<Step>(steps.find(([id]) => id === route[0])?.[0] ?? 'run')
  const collection = $derived(
    (stepCollections[step] ?? []).includes(route[1] as Collection)
      ? (route[1] as Collection)
      : null,
  )
  const group = $derived(
    ledgerGroups.find(([, c]) => (c as readonly string[]).includes(collection ?? 'devices'))!,
  )
  const doc = $derived(workspace.doc)
  const siteId = $derived(
    doc.sites.some((s) => s.id === siteChoice) ? siteChoice : (doc.sites[0]?.id ?? ''),
  )
  const latestRound = $derived(doc.auditRounds.findLast((r) => r.siteIds.includes(siteId)))
  const summary = $derived(
    auditSummary(
      doc.auditResults.filter((r) => r.roundId === latestRound?.id && r.siteId === siteId),
    ),
  )
  const badges = $derived<Partial<Record<Step, string>>>({
    judge: latestRound ? `未確認${summary.unchecked}` : '',
    actions: String(doc.actionItems.filter((a) => a.progress !== 'done').length || ''),
    publish: workspace.validation.warnings.length
      ? `警告${workspace.validation.warnings.length}`
      : '',
  })
  /** Newest other file: a new year's audit starts from last year's ledger and baseline. */
  const previous = $derived(
    files?.jsonFiles
      .filter((n) => n !== thisYear)
      .toSorted()
      .at(-1) ?? null,
  )
  const copyFrom = $derived(copyChoice ?? previous ?? '')
  async function fileAction(action: () => Promise<boolean>, done: () => string) {
    if (await action()) {
      projectDraft = null
      entityEditing = false
      session++
      fidget.say(done())
      window.location.hash = '#/run'
    }
  }
  function startThisYear() {
    if (files?.jsonFiles.includes(thisYear)) {
      return fileAction(
        () => files.open(thisYear),
        () => `${thisYear} を開きました。`,
      )
    }
    return fileAction(
      () => files!.create(thisYear, previous),
      () =>
        previous
          ? `${thisYear} を作りました（${previous} の台帳・基準を引き継ぎ）。`
          : `${thisYear} を作りました。`,
    )
  }
  function saveProject() {
    if (!projectDraft) {
      return
    }
    const project = $state.snapshot(projectDraft)
    if (
      workspace.commit((d) => {
        d.project = project
      })
    ) {
      projectDraft = null
    }
  }
  function keydown(event: KeyboardEvent) {
    if (files?.isOpen && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void files.flush()
    }
  }
  function beforeUnload(event: BeforeUnloadEvent) {
    if (
      workspace.saveState === 'dirty' ||
      editing ||
      files?.status === 'saving' ||
      files?.auditBusy
    ) {
      event.preventDefault()
      event.returnValue = ''
    }
  }
  function hashChanged() {
    const next = window.location.hash
    if (next === hash) {
      return
    }
    if (files?.auditBusy) {
      // The import must finish or fail on this screen: leaving would hide its outcome.
      history.replaceState(null, '', hash || '#/run')
      fidget.say('取り込み処理中は画面を移動できません。完了または失敗の表示までお待ちください。')
      return
    }
    if (editing) {
      history.replaceState(null, '', hash || '#/run')
      pending = () => {
        entityEditing = false
        projectDraft = null
        session++
        window.location.hash = next
      }
    } else {
      hash = next
    }
  }
  const onDraft = (active: boolean) => {
    entityEditing = active
  }
</script>
<svelte:window onhashchange={hashChanged} onbeforeunload={beforeUnload} onkeydown={keydown} />
<a class="skip-link" href="#work-area">作業領域へ移動</a>
<Fidget />
<div class="app-shell">
  <header class="system-bar">
    <span class="brand">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 2h6v6H9zM2 16h6v6H2zM16 16h6v6h-6zM12 8v5M5 16v-3h14v3" />
      </svg>
      <strong>tylan</strong>
      <span>現地ネットワーク監査</span>
    </span>
    {#if files?.isOpen}
      <span class="file-name" title="編集中のファイル">{files.fileName}</span>
      {#if doc.sites.length > 1}
        <label class="site-switch">
          拠点<select bind:value={siteChoice}>
            {#each doc.sites as site}
              <option value={site.id}>{site.name}</option>
            {/each}
          </select>
        </label>
      {:else if doc.sites.length}
        <span class="site-name">{doc.sites[0]!.name}</span>
      {/if}
      <span class="header-actions">
        <span
          role="status"
          class={`save-state ${files.status === 'saved' ? workspace.saveState : 'dirty'}`}
        >
          {editing ? `入力中（未確定） / ${files.label}` : files.label}
        </span>
        <button type="button" title="Ctrl+S" onclick={() => files.flush()}>今すぐ保存</button>
        <button
          type="button"
          disabled={!workspace.undoCount || editing || files.auditBusy}
          onclick={() => workspace.undo()}
        >
          取り消す
        </button>
        <button type="button" disabled={files.auditBusy} onclick={() => files.close()}>
          ファイルを閉じる
        </button>
      </span>
    {/if}
  </header>
  {#if files?.isOpen}
    <nav class="step-bar" aria-label="監査の段階">
      {#each steps as [id, label, hint], i}
        <a href={`#/${id}`} aria-current={step === id ? 'step' : undefined}>
          <span class="step-no">{i + 1}</span>
          <span class="step-text">
            <strong>{label}</strong>
            <small>{hint}</small>
          </span>
          {#if badges[id]}
            <em>{badges[id]}</em>
          {/if}
        </a>
      {/each}
    </nav>
  {/if}
  <main id="work-area" tabindex="-1">
    {#if pending}
      <div role="alertdialog" aria-label="入力中の内容の確認" class="confirm-box">
        <p>入力中（未確定）の内容があります。破棄して移動しますか。</p>
        <button
          type="button"
          class="danger"
          onclick={() => {
            const action = pending
            pending = null
            action?.()
          }}
        >
          変更を破棄して続行
        </button>
        <button type="button" onclick={() => (pending = null)}>現在の作業を続ける</button>
      </div>
    {/if}
    {#if files?.message}
      <div role="alert" class="error">
        <p>{files.message}</p>
        {#if files.status === 'conflict'}
          <button
            type="button"
            onclick={() =>
              fileAction(files.reloadFromFile, () => 'ファイルの内容を読み込み直しました。')}
          >
            ファイルの内容を読み込み直す（この画面の変更は破棄）
          </button>
          <button type="button" class="danger" onclick={() => files.overwrite()}>
            この画面の内容で上書きする
          </button>
        {/if}
      </div>
    {/if}
    {#if workspace.issues.length && step !== 'judge'}
      <div role="alert" class="error">
        <strong>変更を確定できませんでした</strong>
        <ul>
          {#each workspace.issues as issue}
            <li>
              <a href={entityHref(issue.entityId, issue.path)}>{issue.message}</a>
              <small>{issue.path}</small>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
    {#if !files}
      <section class="panel startup-panel">
        <h2>launcher フォルダの tylan.cmd から起動してください</h2>
        <p>
          編集と現地監査は、tylanを置いた調査用PCで起動用の tylan.cmd
          が保存・収集を受け持ちます。editor.html
          を直接開いた場合は、データが失われないよう編集を止めています。
        </p>
        <ol>
          <li>エクスプローラーで tylan の launcher フォルダを開きます。</li>
          <li>tylan.cmd をダブルクリックします。編集画面が開きます。</li>
          <li>終わったら編集画面を閉じるだけです（裏の起動プログラムは数分で自動終了します）。</li>
        </ol>
        <div class="launch-command">
          <span>起動ファイル</span>
          <code>launcher\tylan.cmd</code>
        </div>
      </section>
    {:else if !files.connected}
      <section class="panel">
        <h2>作業フォルダに接続しています…</h2>
        {#if files.message}
          <button type="button" onclick={() => files.connect()}>もう一度接続する</button>
        {/if}
      </section>
    {:else if !files.isOpen}
      <section class="panel start-panel">
        <h2>監査を始める</h2>
        <p>1回の監査を1つのJSONに記録します。保存先は<code>{files.root}\working</code> です。</p>
        <button type="button" class="primary start" onclick={startThisYear}>
          {files.jsonFiles.includes(thisYear)
            ? `${thisYear} を開いて続ける`
            : `${thisYear} を作って始める`}
        </button>
        {#if !files.jsonFiles.includes(thisYear) && previous}
          <p class="muted">
            {previous} の管理機器・基準・過去の判定を引き継ぎます（元のファイルは変更しません）。
          </p>
        {/if}
        <details>
          <summary>別のファイルを開く・名前を決めて作る</summary>
          <div class="start-actions">
            <fieldset class="start-card">
              <legend>既存のファイルを開く</legend>
              <div class="file-list">
                {#each files.jsonFiles as name}
                  <button
                    type="button"
                    onclick={() =>
                      fileAction(
                        () => files.open(name),
                        () => `${name} を開きました。`,
                      )}
                  >
                    {name} を開く
                  </button>
                {:else}
                  <span>working にJSONはまだありません。</span>
                {/each}
              </div>
            </fieldset>
            <form
              class="new-file-form"
              onsubmit={(e) => {
                e.preventDefault()
                void fileAction(
                  () => files.create(newName, copyFrom || null),
                  () =>
                    copyFrom
                      ? `${files.fileName} を作りました（${copyFrom} を引き継ぎ）。`
                      : `${files.fileName} を作りました。`,
                )
              }}
            >
              <fieldset class="start-card">
                <legend>名前を決めて作る</legend>
                <label>ファイル名<input bind:value={newName} required maxlength="100"></label>
                <label>
                  引き継ぐデータ<select
                    value={copyFrom}
                    onchange={(e) => (copyChoice = e.currentTarget.value)}
                  >
                    <option value="">なし（空の状態から）</option>
                    {#each files.jsonFiles as name}
                      <option value={name}>{name}</option>
                    {/each}
                  </select>
                </label>
                <button type="submit">作成して始める</button>
              </fieldset>
            </form>
          </div>
        </details>
      </section>
    {:else}
      {#if folder}
        <!-- Stays mounted while the file is open: a running job is tracked from every step. -->
        <AuditPanel
          {workspace}
          {files}
          {folder}
          {siteId}
          view={step === 'run' || step === 'diff' ? step : null}
        />
      {/if}
      {#key `${session}:${step}:${collection ?? ''}:${route[2] ?? ''}`}
        {#if step === 'diff'}
          <section class="ledger" aria-label="台帳（基準）">
            <div class="section-head ledger-head">
              <h2>台帳（基準）</h2>
              <span>監査はこの内容と比べます。直すと次の実行から使われます。</span>
            </div>
            <nav class="subtabs" aria-label="台帳の種類">
              {#each ledgerGroups as [label, collections]}
                <a
                  href={`#/diff/${collections[0]}`}
                  aria-current={group[0] === label ? 'page' : undefined}
                >
                  {label}
                </a>
              {/each}
            </nav>
            {#if group[1].length > 1}
              <nav class="subtabs minor" aria-label={`${group[0]}の内訳`}>
                {#each group[1] as c}
                  <a
                    href={`#/diff/${c}`}
                    aria-current={(collection ?? 'devices') === c ? 'page' : undefined}
                  >
                    {collectionLabels[c]}
                  </a>
                {/each}
              </nav>
            {/if}
            {#if collection === 'layouts' && !route[2]}
              <Topology {doc} {workspace} />
            {:else}
              <EntityScreen
                {workspace}
                collection={collection ?? 'devices'}
                {targetId}
                selectedId={route[2] === 'edit' ? '' : route[2]}
                ondraftchange={onDraft}
              />
            {/if}
          </section>
        {:else if step === 'judge'}
          {#if collection}
            <p><a href="#/judge">← 20項目の判定に戻る</a></p>
            <nav class="subtabs" aria-label="判定の詳細">
              {#each stepCollections.judge ?? [] as c}
                <a href={`#/judge/${c}`} aria-current={collection === c ? 'page' : undefined}>
                  {collectionLabels[c]}
                </a>
              {/each}
            </nav>
            <EntityScreen
              {workspace}
              {collection}
              {targetId}
              selectedId={route[2]}
              ondraftchange={onDraft}
            />
          {:else}
            <JudgeStep {workspace} {siteId} ondraftchange={onDraft} />
            <p class="muted">
              <a href="#/judge/auditResults">対象別の結果</a>・<a href="#/judge/auditRounds">
                監査回次
              </a>
              ・<a href="#/judge/evidence">証跡</a>を個別に編集できます。
            </p>
          {/if}
        {:else if step === 'actions'}
          <EntityScreen
            {workspace}
            collection="actionItems"
            {targetId}
            selectedId={route[2]}
            ondraftchange={onDraft}
          />
        {:else if step === 'publish'}
          <section class="panel">
            <div class="section-head">
              <h2>閲覧用HTMLに出る見出し</h2>
              {#if !projectDraft}
                <button type="button" onclick={() => (projectDraft = structuredClone(doc.project))}>
                  編集
                </button>
              {/if}
            </div>
            {#if projectDraft}
              <form
                onsubmit={(e) => {
                  e.preventDefault()
                  saveProject()
                }}
              >
                <FieldEditor
                  schema={ProjectSchema.omit({
                    id: true,
                    revision: true,
                    baseRevision: true,
                    appVersion: true,
                    createdAt: true,
                    updatedAt: true,
                  })}
                  bind:value={projectDraft}
                  {doc}
                  root
                />
                <button class="primary" type="submit">確定</button>
                <button type="button" onclick={() => (projectDraft = null)}>キャンセル</button>
              </form>
            {:else}
              <dl class="project-register">
                <dt>名称</dt>
                <dd>{doc.project.name}</dd>
                <dt>調査基準日</dt>
                <dd>{doc.project.surveyDate ?? '未設定'}</dd>
                <dt>データ版</dt>
                <dd>r{String(doc.project.revision).padStart(4, '0')}</dd>
              </dl>
            {/if}
          </section>
          <ExportPanel {workspace} {files} />
        {/if}
      {/key}
    {/if}
    <footer class="page-footer">
      線は実通信・疎通を保証しません。確認時点の情報として扱ってください。
    </footer>
  </main>
</div>
