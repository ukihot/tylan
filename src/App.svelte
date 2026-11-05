<script lang="ts">
  import EntityScreen from './components/EntityScreen.svelte'
  import ExportPanel from './components/ExportPanel.svelte'
  import FieldEditor from './components/FieldEditor.svelte'
  import Topology from './components/Topology.svelte'
  import { auditSummary } from './lib/audit-master'
  import { createFileSession } from './lib/file-session.svelte'
  import { canWriteFiles } from './lib/platform'
  import { collectionLabels } from './lib/presentation'
  import { entityHref, screenCollections, screens } from './lib/routes'
  import { type Collection, type Doc, MAX_BYTES, ProjectSchema } from './lib/schema'
  import { createWorkspace } from './lib/store.svelte'

  const workspace = createWorkspace()
  // Edge/Chrome: edit the JSON file directly. Other browsers fall back to load + download.
  const files = canWriteFiles() ? createFileSession(workspace) : null
  let notice = $state('')
  let hash = $state(window.location.hash)
  let tab = $state<Collection>('sites')
  let projectDraft = $state<Doc['project'] | null>(null)
  let pending = $state<(() => void) | null>(null)
  let fileError = $state('')
  let entityEditing = $state(false)
  let session = $state(0)
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
  const saveLabels = {
    clean: '書き出し済みの変更なし',
    dirty: '未書き出しの変更あり',
    exportRequested: '書き出しを要求済み（共有への反映は未確認）',
  }
  const summary = $derived(
    auditSummary(doc.auditResults.filter((r) => r.roundId === doc.auditRounds.at(-1)?.id)),
  )
  function destructive(action: () => void) {
    if (workspace.saveState === 'dirty' || editing) {
      pending = action
    } else {
      action()
    }
  }
  async function readFile(file?: File) {
    if (!file) {
      return
    }
    fileError = ''
    if (file.size > MAX_BYTES) {
      fileError = '10MiBを超えています。小さい正本JSONを選択してください'
      return
    }
    try {
      const text = await file.text()
      destructive(() => {
        if (workspace.load(text, file.size)) {
          window.location.hash = '#/project'
          projectDraft = null
          entityEditing = false
          session++
        }
      })
    } catch {
      fileError = 'ファイルを読み取れません。共有の接続とアクセス権を確認して再選択してください。'
    }
  }
  function freshStart(message: string) {
    projectDraft = null
    entityEditing = false
    session++
    notice = message
    window.location.hash = '#/project'
  }
  function newProject() {
    destructive(() => {
      workspace.reset()
      freshStart('新しい空のプロジェクトを作成しました。拠点の登録から始めてください。')
    })
  }
  async function fileAction(action: () => Promise<boolean>, done: () => string) {
    notice = ''
    if (await action()) {
      freshStart(done())
    }
  }
  async function closeFile() {
    if (files && (await files.close())) {
      notice = ''
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
    if (workspace.saveState === 'dirty' || editing || files?.status === 'saving') {
      event.preventDefault()
      event.returnValue = ''
    }
  }
  function hashChanged() {
    const next = window.location.hash
    if (next === hash) {
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
<div class="app-shell">
  <aside class="sidebar">
    <a href="#/project" class="brand">
      <span class="brand-mark">t.</span>
      <span>tylan<small>NETWORK WORKSPACE</small></span>
    </a>
    <p class="sidebar-label">ワークスペース</p>
    <nav aria-label="メインナビゲーション">
      {#each screens as [id, label], i}
        <a href={`#/${id}`} class:active={screen === id}>
          <span class="nav-number" aria-hidden="true">0{i + 1}</span>
          {label}
        </a>
      {/each}
    </nav>
    <div class="sidebar-foot">
      <span class="offline-dot"></span>
      オフラインで作業
      <p>データはメモリー上に保持。<br>書き出してから終了してください。</p>
      <small>v0.1.0 · FCIS / Svelte 5</small>
    </div>
  </aside>
  <main>
    <header class="app-header">
      <div>
        <p class="eyebrow">INTERNAL NETWORK SURVEY</p>
        <h1>{doc.project.name}</h1>
        <span class="muted">
          調査基準日{doc.project.surveyDate ?? '未設定'} · r{String(doc.project.revision).padStart(
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
            {editing ? `入力中（未確定） · ${files.label}` : files.label}
          </span>
          <button type="button" title="Ctrl+S" onclick={() => files.flush()}>今すぐ保存</button>
        {:else if !files}
          <span class={`save-state ${workspace.saveState}`}>
            {editing ? '入力中（未確定）' : saveLabels[workspace.saveState]}
          </span>
        {/if}
        <button
          type="button"
          disabled={!workspace.undoCount || editing}
          onclick={() => workspace.undo()}
        >
          取り消す
        </button>
      </div>
    </header>
    {#if pending}
      <div role="alertdialog" aria-label="未書き出し変更の確認" class="confirm-box">
        <p>入力中または未書き出しの変更があります。現在の作業を破棄して続行しますか。</p>
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
    {#if fileError}
      <p role="alert" class="error">{fileError}</p>
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
    {#if files && !files.isOpen}
      <section class="panel">
        <p class="eyebrow">START</p>
        <h2>監査用のJSONファイルを用意します</h2>
        <p class="muted">
          tylanはJSONファイルを直接編集します。確定した変更は自動でファイルへ保存されます。保存先は共有フォルダの
          working を選んでください。
        </p>
        <div class="start-actions">
          <button
            type="button"
            class="start-card primary"
            onclick={() =>
              fileAction(
                files.createBlank,
                () => `${files.fileName} を作成しました。拠点の登録から始めてください。`,
              )}
          >
            <strong>新しいJSONを作る</strong>
            <span>空の状態から始めます。</span>
          </button>
          <button type="button" class="start-card" onclick={() => files.pickCopySource()}>
            <strong>前回のJSONをもとに作る</strong>
            <span>
              機器・配線・過去の監査結果を引き継いだ別ファイルを作ります。元のファイルは変更しません。
            </span>
          </button>
          <button
            type="button"
            class="start-card"
            onclick={() => fileAction(files.open, () => `${files.fileName} を開きました。`)}
          >
            <strong>既存のJSONを開く</strong>
            <span>作成済みのファイルの続きを編集します。</span>
          </button>
        </div>
        {#if files.copySource}
          <div class="notice">
            <p>「{files.copySource}」をもとにします。新しいファイルの保存先を選んでください。</p>
            <button
              type="button"
              class="primary"
              onclick={() =>
                fileAction(
                  files.createFromCopy,
                  () =>
                    `${files.fileName} を作成しました。監査の画面で今回の回次を追加してください。`,
                )}
            >
              保存先を選んで作成
            </button>
            <button type="button" onclick={() => files.cancelCopy()}>やめる</button>
          </div>
        {/if}
      </section>
    {:else}
      {#if screen === 'project'}
        <section class="panel">
          <div class="section-head">
            <div>
              <p class="eyebrow">PROJECT OVERVIEW</p>
              <h2>調査から、構成図へ。</h2>
              <p class="muted">資産・配線・設定・監査をひとつの正本で管理します。</p>
            </div>
            {#if files}
              <button type="button" onclick={closeFile}>ファイルを閉じる</button>
            {:else}
              <button type="button" onclick={newProject}>新規プロジェクト</button>
            {/if}
          </div>
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
              <strong>{summary.unchecked}</strong>
              <span>最新回次の未確認 /{summary.total}総括</span>
            </div>
            <div>
              <strong>{workspace.validation.warnings.length}</strong>
              <span>確認が必要な警告</span>
            </div>
          </div>
          {#if !files}
            <section
              class="file-drop"
              aria-label="JSONファイル読み込み"
              ondragover={(e) => e.preventDefault()}
              ondrop={(e) => {
                e.preventDefault()
                void readFile(e.dataTransfer?.files[0])
              }}
            >
              <strong>正本JSONを読み込む</strong>
              <p>ファイルをここへドロップ、または選択してください（10MiB以下）。</p>
              <label class="file-label">
                JSONファイル<input
                  type="file"
                  accept=".json,application/json"
                  onchange={(e) => {
                    void readFile(e.currentTarget.files?.[0])
                    e.currentTarget.value = ''
                  }}
                >
              </label>
            </section>
          {/if}
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
        <ExportPanel {workspace} />
      {:else if choices.length}
        <div class="subtabs" role="tablist" aria-label="データの種類">
          {#each choices as c}
            <button
              type="button"
              role="tab"
              aria-selected={collection === c}
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
          <EntityScreen
            {workspace}
            {collection}
            {targetId}
            selectedId={route[2]}
            ondraftchange={(active) => {
              entityEditing = active
            }}
          />
        {/key}
      {/if}
    {/if}
    <footer class="page-footer">
      線は実通信・疎通を保証しません。確認時点の情報として扱ってください。
    </footer>
  </main>
</div>
