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

## 自動監査の実装・TDD記録（2026-11-09）

[自動収集計画](audit-automation.md) の残作業を、テストを先に書いて失敗を確認してから実装した。AUTO条件との対応は同計画12章にまとめた。実LAN・実共有での確認（同12.2）は行っていない。

### RED → GREEN の記録

| 対象                   | 先に書いたテスト                                                  | 意図したRED（実装前の失敗）                                                                                             | GREENで行った実装                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| DNS判定の接続          | `collector/tests/test_dns.py`                                     | 問い合わせと応答の対応付け・期間末尾・自ホスト別集計が未実装。`findings_for` がDNSを評価しない                          | `dns_statistics`、閾値付き `evaluate_dns`、選択NICのDNS設定を使う `findings_for`                                                           |
| 機能OFFの扱い          | 同上                                                              | DHCP監査OFFでもキャプチャ成功を根拠に「応答未観測」と評価していた                                                       | OFFの機能は「未確認（対象外にしない）」として評価                                                                                          |
| DHCP配布内容           | `test_capture.py`                                                 | 配布GW/DNSの基準照合、relay・冗長の併記がない                                                                           | `evaluate_dhcp` に配布内容の比較と文脈を追加。配布値はIPv4として検証                                                                       |
| TSharkの集計・上限     | 同上                                                              | ドロップ件数・0件・権限不足・途中終了・打ち切り・解析失敗の区別がない。切断行で全体が失敗                               | `capture_stats`・`capture_outcome`・`finish_capture`、件数上限と完全行だけの解析、実行全体200MiB                                           |
| 詳細証跡・基準値       | `test_profile.py`                                                 | 保持日数のない詳細保存、想定GW、DNS失敗率の検証がない                                                                   | `detailEvidence`（保持日数必須）、`expectedGateway`、`dnsFailureRatio`                                                                     |
| IPv6読取               | `test_host_inventory.py`（実スクリプト、送信なし）                | `ipv6` の状態がなく、IPv6取得失敗でスクリプト全体が失敗し得た。runnerは常に「確認済み」で評価                           | `collect-host.ps1` でIPv6を独立した読取に分離、`ipv6_finding`                                                                              |
| スイッチ情報の取り込み | `test_profile.py`、`launcher-audit`                               | オフライン取り込みの実行種別がない                                                                                      | `mode: offline` と `offline_collection`。送信・子プロセスなしで実行結果として封印可能                                                      |
| 所有者の停止           | `test_owner.py`                                                   | 実行中runがあるとStopOwner後もleaseが再延長される。lease置換と読取が衝突すると所有者が異常終了する                      | `Lease`（停止・失効後は再延長しない）、読取失敗の再試行、`atomic_json` の置換再試行、`stopped` 記録                                        |
| 証跡の安全性           | `test_evidence.py`                                                | `stat()` がNTFSジャンクションを辿るため再解析ポイントを検出できない。コピー中断で `.part` が残る。欠損の復元なし        | `lstat` による検査（証跡ルート自身も対象）、失敗時の後始末、同一ハッシュだけを復元する `restore_package`                                   |
| PowerShell契約         | `tests/launcher-audit.test.ts`                                    | 読取中の書込で500、本文とstampを別に読む。未知runのprepareが通る。障害注入点がない。所有者停止を報告しない              | `Read-Canonical`、importIdとrun・選択・証跡の照合、`Fault-Point`、`stopped` 応答、lease書込の再試行                                        |
| 取り込み計画           | `src/lib/import-plan.test.ts`                                     | 接続候補・AD・DHCPスコープを取り込めない。Undo後の再採用で取消履歴を上書き。同一importIdの内容違いを通す                | 両端の明示対応付け、AD・スコープの採用、再採用の世代付きimportId、内容照合                                                                 |
| 前回比較               | `src/lib/run-diff.test.ts`                                        | 件数比較のみ                                                                                                            | `compareRuns`（追加・変更・今回未観測・条件差）                                                                                            |
| 画面                   | `AuditPanel.svelte.test.ts`、`App.svelte.test.ts` ほか            | 受付拒否後もフォームが固まりポーリングが続く。IPv6のON/OFFが診断APIへ届かない。取り込み中に画面移動・閉じる操作ができる | 受付拒否の状態、診断要求へのIPv6指定、部分完了・ドロップ表示、接続対応付け、差分表示、取り込み中のロック                                   |
| 診断APIの実経路        | `launcher-audit`（IPv6スイッチ）                                  | fixture動作時は固定値を返し、PowerShell→Python→収集スクリプトの経路を通らない                                           | fixtureに診断値がなければ、送信を伴わない実際のホスト読取を実行                                                                            |
| 非同期の可視化         | `test_jobs.py`、`AuditPanel.svelte.test.ts`、`App.svelte.test.ts` | 状態は段階名だけで、進捗・経過時間・到達した段階がない。監査画面を離れると実行中のジョブが見えない                      | 段階履歴・開始時刻・進捗（件数または時間枠）を状態ファイルへ記録。段階表示・`<progress>`・実行中ジョブ名・取り込みの段階・他画面の進捗表示 |
| 一連操作（P3）         | `tests/audit-e2e.test.ts`                                         | ―（下記のテスト側の修正のみ）                                                                                           | 配布物のランチャー・所有者・疑似収集器で、開始→結果→採用→Undo→再読込を確認                                                                 |

### テスト側の修正と、REDを伴わない回帰テスト

- テストの誤り：取り込み計画で選択が整列されることを考慮せず、束縛の順序を仮定していた。キーで探すよう修正（期待する性質は変えていない）。
- テストの競合：E2Eで「開く」の完了前に画面移動していた。開いた通知を待つよう修正。
- 並列実行：契約テストとE2Eがそれぞれ収集所有者を起動し、ユーザー単位のmutexで後者がbusyになった（仕様どおり）。配布物テストは `fileParallelism: false` で直列実行する。
- 画面の文言：BiomeのHTML整形（空白を無視する設定）が「ドロップ {値}」の空白を詰めるため、表示文字列を式で組み立てた。
- 実装前から成立していたため回帰テストとして追加：部分採用の重なり、等コスト経路の拒否、公開射影からの取り込み記録の除外、オフライン取り込みと証跡欠損→復元の契約テスト（Python側を先にTDDで実装）。

### `bun run verify` の実行結果（2026-11-09、Windows 11）

| 検査                                        | 結果                                      |
| ------------------------------------------- | ----------------------------------------- |
| Biome                                       | 73ファイル、エラー・警告なし              |
| Svelte / TypeScript                         | エラー・警告なし                          |
| Vitest Node / Chromium                      | 65テスト成功                              |
| Ruff（lint・format）/ pytest                | エラーなし / 50テスト成功（スキップなし） |
| 配布物・PowerShell契約・監査E2E（Chromium） | 21テスト成功（6・14・1）                  |

配布物テストは2回連続で成功した。pytestのWindowsゲート（Job Object、ジャンクション、実際のホスト読取、所有者のmutex）はこの端末で実行しており、他のOSではスキップされる。

### 未検証事項

TSharkの集計行・権限不足の文言は公開されている出力形式に基づく人工fixtureで、実機の出力では未確認。Nmap・TShark・Npcapの実行、送信NIC・VPN経路、UNC共有の置換・切断、AD・DHCPサーバーの読取は現地ゲートとして残す。

## 公開と配布の補足

`build/standalone.ts` がJSとCSSをHTMLへ内包し、実コードからCSPのSHA-256を計算する。起動時のJSON取得、外部import、動的チャンク、Webフォントは使わない。

公開データは新しいオブジェクトへ許可フィールドだけを詰める。標準公開にはネットワーク設定やSSIDを含めないため、それらを対象とした個別監査も除外する。機器・ポート・公開接続の対象別結果と拠点総括は公開する。シリアル・連絡先・自由記述・証跡・対応事項は個別に許可した場合だけ含む。生成後に埋め込みJSONを再解析し、公開用の厳格なスキーマで検証する。

閲覧側は更新用workspaceを生成しない。パン・ズーム・検索・PNG・印刷は可能だが、機器・配線・配置を確定する経路を持たない。
