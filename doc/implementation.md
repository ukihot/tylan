# 実装・検証記録

確認日：2026-11-05。基本設計0.2の実装判断を記録する。

## 最新仕様の調査

調査時のnpm公開版と公式情報を確認し、以下を固定した。

| 開発用パッケージ                    | 採用版        | 判断                                                                           |
| ----------------------------------- | ------------- | ------------------------------------------------------------------------------ |
| Vitest / @vitest/browser-playwright | 5.1.0 / 5.1.0 | 同版でそろえる。NodeテストとBrowser Modeを `test.projects` で分ける            |
| vitest-browser-svelte               | 3.1.0         | 実ブラウザーでSvelteを描画。`render` をawaitし、role・labelのlocatorで操作する |
| Playwright                          | 1.64.1        | Browser Modeとビルド後のfile://検証に共用                                      |
| Biome                               | 2.6.5         | TypeScript・Svelte・CSS・HTMLの整形、推奨lint、import整理                      |
| TypeScript / native alias           | 6.0.3 / 7.0.2 | svelte-checkが求める互換構成。`svelte-check --tsgo` を使う                     |

公式の参照元：

- [Vitest：Browser Mode](https://vitest.dev/guide/browser/)
- [Vitest：Component Testing](https://vitest.dev/guide/browser/component-testing)
- [Vitest：Test Projects](https://vitest.dev/guide/projects)
- [Vitest：5系への移行とNode.js要件](https://vitest.dev/guide/migration/)
- [Svelte：Testing](https://svelte.dev/docs/svelte/testing)
- [vitest-browser-svelte：提供元](https://github.com/vitest-community/vitest-browser-svelte)
- [Biome：Svelte等の言語対応と実験的機能](https://biomejs.dev/introduction/language-support/)

DOMエミュレーターは追加していない。UIテストは実Chromiumで行い、`expect.element` の再試行を使う。runesを含むテストは `.svelte.test.ts` とする。非推奨の `workspace` 設定や旧Browser contextパスは使わない。Vite 8では `codeSplitting: false` として単一バンドルを生成する。

## FCISの境界

| Functional Core（時計・DOM・乱数・ファイルへアクセスしない） | 責務                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| schema / address / validate                                  | 厳格な構造、IP、参照・業務ルール、警告                                          |
| commands                                                     | コピーした正本への更新、参照を確認した削除、監査回次の作成                      |
| audit-master                                                 | 20項目の原番号、4値判定の集計とバッジ                                           |
| io / csv / publish                                           | JSON出力計画、版・ファイル名、CSV、許可リストによる公開、HTMLへの安全な埋め込み |
| graph / layout                                               | 正本からnodes/edgesを導出、幅優先レイアウト、固定座標の維持                     |

Imperative Shellは `store.svelte.ts`、`platform.ts`、Svelteコンポーネント、エントリーポイント、ビルド処理に限定する。

- `createWorkspace()` ごとに状態を分離し、凍結した正本を `$state.raw` で差し替える。モジュール全体で共有する可変singletonは持たない。
- 表・集計・図は `$derived`。フォームは独立した下書きを `$bindable` で編集する。データを同期するための `$effect` は使わない。
- `commands` が検証済みの新しい正本を返した場合だけShellが採用する。図の接続・座標もこの経路を通す。
- Undoは10世代。書き出し後にUndoしても版を巻き戻さず、次の出力版を単調増加させる。
- 監査と対応事項の相互参照は1回の確定で更新する。対応完了で監査判定を変えない。
- 入力中、確定済み未書き出し、書き出し要求済みを区別する。画面移動時は入力中の下書きを保持して確認を求める。

Zodのdefaultで欠落した入力を補完しない。下書きの初期値生成と、読み込む正本の厳格検証は別関数にしている。フォームの再帰的な値bindingにのみ、理由を付けた局所的なanyを使用する。Coreの入出力は型で表す。

## テスト駆動の進め方と結果

最初に検証・監査・参照削除・往復・公開・CSV・図のテストを書き、未実装で失敗することを確認して実装した。次に、日時の不正日、監査と対応事項の参照、親グループの寸法、空白後のCSV式などの振る舞いをテストで追加し、6件の失敗を修正した。

`bun run verify` の実行結果：

| 検査                      | 結果             |
| ------------------------- | ---------------- |
| Biome                     | エラー・警告なし |
| Svelte / TypeScript       | エラー・警告なし |
| Vitest Node               | 27テスト成功     |
| Vitest Browser / Chromium | 4テスト成功      |
| 配布HTML                  | 4テスト成功      |

配布物の確認はViteサーバーを使わず、Playwrightのoffline contextで実行した。インラインスクリプトのCSPハッシュ、HTTP(S)要求なし、JSON明示読込、PNG、同じ版のJSON・HTML要求、XSS文字列のテキスト表示、非公開シリアルの除外、日本語・空白を含むローカルパスを検証した。ブラウザー版とスクリーンショットは `.build/` に記録する。

- Chromium：156.0.8078.4
- Microsoft Edge：158.0.4370.1

実際の共有と権限、社内標準Chrome、性能目標、ExcelでのCSV表示は未検証。ローカルのテスト成功を、これらの受入完了として扱わない。

## 次期拡張の計画（2026-11-06）

[現地LAN監査の自動収集・マッピング計画](audit-automation.md) を追加した。既存のPowerShellランチャー、FCIS、厳格な正本スキーマ、4値監査、証跡参照、自動保存・公開境界を調査し、PythonからNmap・TShark・PowerShellを統合する構成を定義した。ツール仕様は同計画内の公式資料を参照した。

この変更は文書のみ。収集器・ジョブAPI・取り込み画面は未実装であり、実LANの探索・キャプチャ、調査ホストの依存診断、収集用ツールの版固定・互換性検証は行っていない。上記の現行版テスト結果を自動監査機能の検証結果として扱わない。

## 公開と配布の補足

`build/standalone.ts` がJSとCSSをHTMLへ内包し、実コードからCSPのSHA-256を計算する。起動時のJSON取得、外部import、動的チャンク、Webフォントは使わない。

公開データは新しいオブジェクトへ許可フィールドだけを詰める。標準公開にはネットワーク設定やSSIDを含めないため、それらを対象とした個別監査も除外する。機器・ポート・公開接続の対象別結果と拠点総括は公開する。シリアル・連絡先・自由記述・証跡・対応事項は個別に許可した場合だけ含む。生成後に埋め込みJSONを再解析し、公開用の厳格なスキーマで検証する。

閲覧側は更新用workspaceを生成しない。パン・ズーム・検索・PNG・印刷は可能だが、機器・配線・配置を確定する経路を持たない。
