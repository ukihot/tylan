<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import AuditPanel from './components/AuditPanel.svelte'
  import EntityScreen from './components/EntityScreen.svelte'
  import ExportPanel from './components/ExportPanel.svelte'
  import FieldEditor from './components/FieldEditor.svelte'
  import Topology from './components/Topology.svelte'
  import { auditSummary } from './lib/audit-master'
  import { createFileSession } from './lib/file-session.svelte'
  import { type Folder, launcherFolder } from './lib/folder'
  import { nowJst } from './lib/platform'
  import { collectionLabels } from './lib/presentation'
  import { entityHref, screenCollections, screens } from './lib/routes'
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
    void files.connect().then(() => {
      copyFrom = files.jsonFiles[0] ?? ''
    })
    // Hidden tabs are throttled to about one timer per minute; the launcher waits 3 minutes.
    const ping = () => void files.ping()
    const timer = setInterval(ping, 10000)
    document.addEventListener('visibilitychange', ping)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', ping)
    }
  })
  let notice = $state('')
  let newName = $state(`network-${nowJst().slice(0, 4)}.json`)
  let copyFrom = $state('')
  let hash = $state(window.location.hash)
  let tab = $state<Collection>('sites')
  let projectDraft = $state<Doc['project'] | null>(null)
  let pending = $state<(() => void) | null>(null)
  let entityEditing = $state(false)
  let session = $state(0)
  let menuOpen = $state(false)
  const editing = $derived(entityEditing || projectDraft !== null)
  const route = $derived(hash.split('?')[0]!.replace(/^#\/?/, '').split('/'))
  const targetId = $derived(new URLSearchParams(hash.split('?')[1] ?? '').get('target') ?? '')
  const screen = $derived(screens.some(([id]) => id === route[0]) ? route[0]! : 'project')
  const choices = $derived(
    (screenCollections[screen as keyof typeof screenCollections] ?? []) as readonly Collection[],
  )
  const collection = $derived(
    (route[1] && choices.includes(route[1] as Collection)
      ? route[1]
      : choices.includes(tab)
        ? tab
        : choices[0]) as Collection,
  )
  const doc = $derived(workspace.doc)
  const summary = $derived(
    auditSummary(doc.auditResults.filter((r) => r.roundId === doc.auditRounds.at(-1)?.id)),
  )
  async function fileAction(action: () => Promise<boolean>, done: () => string) {
    notice = ''
    if (await action()) {
      projectDraft = null
      entityEditing = false
      session++
      notice = done()
      window.location.hash = '#/project'
    }
  }
  async function closeFile() {
    notice = ''
    if (files && (await files.close())) {
      copyFrom = files.jsonFiles[0] ?? ''
    }
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
      history.replaceState(null, '', hash || '#/project')
      notice = '取り込み処理中は画面を移動できません。完了または失敗の表示までお待ちください。'
      return
    }
    if (editing) {
      history.replaceState(null, '', hash || '#/project')
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
</script>
<svelte:window onhashchange={hashChanged} onbeforeunload={beforeUnload} onkeydown={keydown} />
<a class="skip-link" href="#work-area">作業領域へ移動</a>
<div class="app-shell">
  <header class="system-bar">
    <a href="#/project" class="brand" aria-label="tylan ホーム">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 2h6v6H9zM2 16h6v6H2zM16 16h6v6h-6zM12 8v5M5 16v-3h14v3" />
      </svg>
      <strong>tylan</strong>
      <span>ネットワーク調査・管理</span>
    </a>
    <span class="system-version">v0.1.0</span>
    <button
      class="menu-toggle"
      type="button"
      aria-expanded={menuOpen}
      aria-controls="main-menu"
      onclick={() => (menuOpen = !menuOpen)}
    >
      業務メニュー
    </button>
  </header>
  <aside class="sidebar" class:menu-open={menuOpen} id="main-menu">
    <h2 class="sidebar-title">業務メニュー</h2>
    <nav aria-label="メインナビゲーション">
      {#each screens as [id, label]}
        <a
          href={`#/${id}`}
          class:active={screen === id}
          aria-current={screen === id ? 'page' : undefined}
          onclick={() => (menuOpen = false)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            {#if id === 'topology'}
              <path d="M6 1h4v4H6zM1 11h4v4H1zM11 11h4v4h-4zM8 5v3M3 11V8h10v3" />
            {:else if id === 'devices'}
              <path d="M2 2h12v9H2zM8 11v3M5 14h6M4 5h8M4 8h5" />
            {:else if id === 'ports'}
              <path d="M1 4h14v8H1zM4 7v2M7 7v2M10 7v2M13 7v2" />
            {:else if id === 'network'}
              <path d="M2 4h12M2 8h12M2 12h12M5 2v4M11 6v4M6 10v4" />
            {:else if id === 'audit' || id === 'actions'}
              <path d="M3 1h10v14H3zM5 5l1 1 2-2M9 5h2M5 9l1 1 2-2M9 9h2M5 12h6" />
            {:else if id === 'export'}
              <path d="M8 1v9M5 7l3 3 3-3M2 10v5h12v-5" />
            {:else}
              <path d="M1 4V2h5l2 2h7v10H1zM1 6h14" />
            {/if}
          </svg>
          {label}
        </a>
      {/each}
    </nav>
    <div class="sidebar-foot">
      <strong>ローカル作業</strong>
      <p>確定した変更は working のJSONへ自動保存されます。</p>
      <small>FCIS / Svelte 5</small>
    </div>
  </aside>
  <main id="work-area" tabindex="-1">
    <header class="app-header">
      <div class="project-heading">
        <h1>{doc.project.name}</h1>
        <span class="project-revision">
          調査基準日{doc.project.surveyDate ?? '未設定'} / r{String(doc.project.revision).padStart(
            4,
            '0',
          )}
        </span>
      </div>
      <div class="header-actions">
        {#if files?.isOpen}
          <span class="file-name" title="編集中のファイル">{files.fileName}</span>
          <span
            role="status"
            class={`save-state ${files.status === 'saved' ? workspace.saveState : 'dirty'}`}
          >
            {editing ? `入力中（未確定） / ${files.label}` : files.label}
          </span>
          <button type="button" title="Ctrl+S" onclick={() => files.flush()}>今すぐ保存</button>
        {/if}
        <button
          type="button"
          disabled={!workspace.undoCount || editing || files?.auditBusy}
          onclick={() => workspace.undo()}
        >
          取り消す
        </button>
      </div>
    </header>
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
    {#if notice}
      <p role="status" class="notice">{notice}</p>
    {/if}
    {#if workspace.issues.length}
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
          編集と現地監査は、tylanのソースを置いた調査用ホストで起動用の tylan.cmd
          が保存・収集を受け持ちます。editor.html
          を直接開いた場合は、データが失われないよう編集を止めています。
        </p>
        <ol>
          <li>エクスプローラーで tylan のソースの launcher フォルダを開きます。</li>
          <li>tylan.cmd をダブルクリックします。編集画面が開きます。</li>
          <li>
            編集が終わったら編集画面を閉じるだけです（裏で動く起動プログラムは数分で自動終了します）。
          </li>
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
      <section class="panel file-manager">
        <h2>編集するJSONを選んでください</h2>
        <p class="directory-path">
          <span>作業フォルダ</span>
          <code>{files.root}\working</code>
        </p>
        <div class="start-actions">
          <fieldset class="start-card">
            <legend>続きを編集する</legend>
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
                    ? `${files.fileName} を作成しました（${copyFrom} を引き継ぎ）。監査の画面で今回の回次を追加してください。`
                    : `${files.fileName} を作成しました。拠点の登録から始めてください。`,
              )
            }}
          >
            <fieldset class="start-card">
              <legend>今回の監査用JSONを作る</legend>
              <label>ファイル名<input bind:value={newName} required maxlength="100"></label>
              <label>
                引き継ぐデータ<select bind:value={copyFrom}>
                  <option value="">なし（空の状態から）</option>
                  {#each files.jsonFiles as name}
                    <option value={name}>{name}（機器・配線・過去の監査）</option>
                  {/each}
                </select>
              </label>
              <button type="submit" class="primary">作成して編集を始める</button>
              <span>引き継ぎ元のファイルは変更しません。</span>
            </fieldset>
          </form>
        </div>
      </section>
    {:else}
      {#if folder}
        <!-- Stays mounted while the file is open: a running job is tracked from every screen. -->
        <AuditPanel {workspace} {files} {folder} visible={screen === 'audit'} />
      {/if}
      {#if screen === 'project'}
        <section class="panel project-panel">
          <div class="section-head">
            <div>
              <h2>プロジェクト管理</h2>
            </div>
            <button type="button" onclick={closeFile}>ファイルを閉じる</button>
          </div>
          <dl class="project-register">
            <dt>正本ファイル</dt>
            <dd>working\{files.fileName}</dd>
            <dt>調査基準日</dt>
            <dd>{doc.project.surveyDate ?? '未設定'}</dd>
            <dt>データ版</dt>
            <dd>r{String(doc.project.revision).padStart(4, '0')}</dd>
          </dl>
          <div class="stats">
            <div>
              <strong>{doc.sites.length}</strong>
              <span>拠点</span>
            </div>
            <div>
              <strong>{doc.devices.length}</strong>
              <span>機器</span>
            </div>
            <div>
              <strong>{doc.links.length}</strong>
              <span>接続</span>
            </div>
            <div>
              <strong>{summary.unchecked} /{summary.total}</strong>
              <span>最新回次の未確認 / 総括</span>
            </div>
            <div>
              <strong>{workspace.validation.warnings.length}</strong>
              <span>確認が必要な警告</span>
            </div>
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
              <button class="primary" type="submit">プロジェクトを確定</button>
              <button type="button" onclick={() => (projectDraft = null)}>キャンセル</button>
            </form>
          {:else}
            <button type="button" onclick={() => (projectDraft = structuredClone(doc.project))}>
              プロジェクト情報を編集
            </button>
          {/if}
        </section>
      {/if}
      {#if screen === 'topology'}
        {#if route[1] === 'layouts'}
          <EntityScreen
            {workspace}
            collection="layouts"
            selectedId={route[2]}
            {targetId}
            ondraftchange={(active) => {
              entityEditing = active
            }}
          />
        {:else}
          <Topology {doc} {workspace} />
        {/if}
      {:else if screen === 'export'}
        <ExportPanel {workspace} {files} />
      {:else if choices.length}
        <div
          class="subtabs"
          role="tablist"
          tabindex="-1"
          aria-label="データの種類"
          onkeydown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
              return
            }
            event.preventDefault()
            const tabs = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
            ]
            const index = tabs.indexOf(event.target as HTMLButtonElement)
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? tabs.length - 1
                  : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
            tabs[next]?.focus()
            tabs[next]?.click()
          }}
        >
          {#each choices as c}
            <button
              type="button"
              role="tab"
              id={`tab-${c}`}
              aria-controls={`panel-${c}`}
              aria-selected={collection === c}
              tabindex={collection === c ? 0 : -1}
              onclick={() => {
                tab = c
                window.location.hash = `#/${screen}/${c}`
              }}
            >
              {collectionLabels[c]}
            </button>
          {/each}
        </div>
        {#if screen === 'audit'}
          <div class="notice">
            最新回次の総括：問題なし{summary.ok} / 要対応{summary.ng} / 未確認{summary.unchecked} /
            対象外{summary.na}（分母{summary.total}、対象別{summary.targets}件）
          </div>
        {/if}
        {#key `${session}:${collection}:${route[2] ?? ''}`}
          <div role="tabpanel" id={`panel-${collection}`} aria-labelledby={`tab-${collection}`}>
            <EntityScreen
              {workspace}
              {collection}
              {targetId}
              selectedId={route[2]}
              ondraftchange={(active) => {
                entityEditing = active
              }}
            />
          </div>
        {/key}
      {/if}
    {/if}
    <footer class="page-footer">
      線は実通信・疎通を保証しません。確認時点の情報として扱ってください。
    </footer>
  </main>
</div>
