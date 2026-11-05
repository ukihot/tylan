<script lang="ts">
  import EntityScreen from './components/EntityScreen.svelte'
  import ExportPanel from './components/ExportPanel.svelte'
  import FieldEditor from './components/FieldEditor.svelte'
  import Topology from './components/Topology.svelte'
  import { auditSummary } from './lib/audit-master'
  import { createFileSession } from './lib/file-session.svelte'
  import { canWriteFiles, nowJst } from './lib/platform'
  import { collectionLabels } from './lib/presentation'
  import { entityHref, screenCollections, screens } from './lib/routes'
  import { type Collection, type Doc, ProjectSchema } from './lib/schema'
  import { createWorkspace } from './lib/store.svelte'

  const workspace = createWorkspace()
  // Editing always happens inside a JSON file in the shared tylan\working folder: no file, no editing.
  const supported = canWriteFiles()
  const files = createFileSession(workspace)
  let notice = $state('')
  let newName = $state(`network-${nowJst().slice(0, 4)}.json`)
  let copyFrom = $state('')
  let hash = $state(window.location.hash)
  let tab = $state<Collection>('sites')
  let projectDraft = $state<Doc['project'] | null>(null)
  let pending = $state<(() => void) | null>(null)
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
  async function chooseFolder() {
    notice = ''
    if (await files.chooseFolder()) {
      copyFrom = files.jsonFiles[0] ?? ''
    }
  }
  async function closeFile() {
    notice = ''
    if (await files.close()) {
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
    if (files.isOpen && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void files.flush()
    }
  }
  function beforeUnload(event: BeforeUnloadEvent) {
    if (workspace.saveState === 'dirty' || editing || files.status === 'saving') {
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
      <p>変更は working のJSONへ<br>自動保存されます。</p>
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
        {#if files.isOpen}
          <span class="file-name" title="編集中のファイル">{files.fileName}</span>
          <span
            role="status"
            class={`save-state ${files.status === 'saved' ? workspace.saveState : 'dirty'}`}
          >
            {editing ? `入力中（未確定） · ${files.label}` : files.label}
          </span>
          <button type="button" title="Ctrl+S" onclick={() => files.flush()}>今すぐ保存</button>
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
    {#if files.message}
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
    {#if !supported}
      <section class="panel">
        <p class="eyebrow">START</p>
        <h2>この画面では編集を始められません</h2>
        <p>
          tylanは共有フォルダのJSONへ直接保存します。このブラウザーではその機能（File System Access
          API）が使えないため、データが失われないよう編集を止めています。
        </p>
        <ul>
          <li>Microsoft Edge か Google Chrome で editor.html を開いてください。</li>
          <li>
            Edgeでもこの表示になる場合は、社内ポリシーで制限されている可能性があります。情報システム担当へ相談してください。
          </li>
        </ul>
        <p class="hint">
          診断：セキュアコンテキスト{window.isSecureContext ? 'はい' : 'いいえ'} / フォルダ選択
          {'showDirectoryPicker' in window ? 'あり' : 'なし'}
        </p>
      </section>
    {:else if !files.hasFolder}
      <section class="panel">
        <p class="eyebrow">STEP 1 / 2</p>
        <h2>tylan フォルダを選んでください</h2>
        <p class="muted">
          editor.html が入っている tools フォルダの、ひとつ上のフォルダです。JSONはその中の working
          フォルダへ自動で保存されます。初回はEdgeがフォルダの編集を許可するか確認します。
        </p>
        <button type="button" class="primary" onclick={chooseFolder}>tylan フォルダを選ぶ</button>
      </section>
    {:else if !files.isOpen}
      <section class="panel">
        <p class="eyebrow">STEP 2 / 2 ·{files.folderName}\working</p>
        <h2>編集するJSONを選んでください</h2>
        <div class="start-actions">
          <div class="start-card">
            <strong>続きを編集する</strong>
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
          <form
            class="start-card"
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
            <strong>今回の監査用JSONを作る</strong>
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
          </form>
        </div>
        <button type="button" class="quiet" onclick={chooseFolder}>フォルダを選び直す</button>
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
            <button type="button" onclick={closeFile}>ファイルを閉じる</button>
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
