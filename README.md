# tylan

社内ネットワークの調査・台帳・構成図・監査ツール。編集と現地監査は調査用ホストのソース一式から起動し、公開した閲覧用HTMLだけを運用で共有フォルダに置きます。Svelte 5、Svelte Flow、Zodを使い、FCISで業務処理とブラウザー操作を分離しています。

## 開発

Node.js 22.12以上とBunを使用します。

```sh
bun install --frozen-lockfile
bunx playwright install chromium
bun run dev
```

`dev` は閲覧用雛形を生成してからViteを起動します。操作確認用の架空データは [examples/network.json](examples/network.json) を読み込んでください。8機器・9接続、不明端点、冗長配線、監査20項目と対象別結果を含みます。警告が残るのは意図した調査サンプルです。

## 整形・検証

```sh
bun run format        # Biomeで整形
bun run lint          # 整形・lint・import順の検査
bun run lint:fix      # 安全な自動修正
bun run check         # Svelte・TypeScriptの型検査
bun run test          # Vitest：Nodeと実Chromium
bun run test:watch    # TDD用の監視実行
bun run test:collector # Ruff・pytest（収集器。.venvに collector/requirements-dev.txt を導入）
bun run verify        # 上記検査＋ビルド＋file://閲覧HTML・PowerShell契約・監査E2Eテスト
```

収集器のテストは実LANへ送信しません。監査E2Eは `launcher/` のランチャーと実際の収集所有者を、固定の疑似収集結果で動かします（実行にはWindows PowerShellとPython 3.12が必要）。

Biome 2.6.5でSvelte・HTML全体の対応を有効にしています。この機能はBiome公式でも実験的扱いのため、型チェックとブラウザーテストを併用します。VS Code用の拡張推奨・保存時整形も設定済みです。

## 起動・操作（調査用ホスト）

ソース・編集・自動監査はすべて調査用ホストのローカルで行います。共有フォルダには公開した閲覧用HTMLだけを置きます。

```sh
bun run build
```

1. `launcher\tylan.cmd` をダブルクリックします。Windows標準のPowerShellが `dist\editor.html` を配信してファイル保存を受け持ち、Edgeで編集画面が開きます。作業データは `data\`（git管理外）に置きます。別の場所にする場合は `tylan.ps1 -Root <フォルダ>` で起動します。
2. `data\working\` のJSONを一覧から開くか、今回の監査用JSONを作ります（前回分の引き継ぎ可）。JSONを開くまで編集はできません。
3. 拠点・機器・配線・設定・監査を登録します。確定した変更は開いているJSONへ自動保存されます（Ctrl+Sで即時保存）。不明値は未確認のまま残せます。
4. 「検証・書き出し」で公開範囲を設定してプレビューを確認し、「閲覧用HTMLを公開」で `data\published\viewer.html` を更新します。旧版は自動で `data\archive\` へ移ります。
5. 運用手順として、`data\published\viewer.html` を共有フォルダの公開場所へコピーします（[受入手順](doc/acceptance.md#日常の更新)）。

保存の直前にファイルの更新日時を確認し、別の場所で変更されていれば自動保存を止めます。業務データをlocalStorage・IndexedDBへ保存しません。`editor.html` を直接開いた場合は編集を始めず、`tylan.cmd` からの起動を案内します。起動用スクリプトはPCの中からの接続だけを受け付け、起動ごとの合言葉がない要求を拒否し、編集画面を閉じると数分で終了します。

`data\` は正本JSON・証跡を含みます。バックアップの対象にし、`git clean -x` で消さないでください。ビルドは `dist/THIRD-PARTY-LICENSES.txt` も生成します（閲覧用HTMLに内包する依存のライセンス）。閲覧用雛形は `.build/viewer/` に置き、編集用HTMLへ内包します。

## 現地監査

監査画面の「現地LANを調べる」から、IPv4の機器探索・指定TCPポート・ARP/DNS/DHCP観測と自ホスト設定（IPv6は送信なしの設定読取のみ）を収集し、選択した結果を同じ正本JSONへ取り込みます。

調査用ホストに Python 3.12（`python.exe` がPATH上）・Nmap・Wireshark（TShark）・Npcap を用意します。監査画面を開くと起動用スクリプトがこれらを確認し、足りないものを画面上部に表示します（WindowsApps のStore用 `python.exe` は導入済みと扱いません）。アプリは未導入のソフトを自動でインストールしません。

1. `tylan.cmd` で起動し、今回のJSONを開いて「監査」画面へ移動します。不足ソフトの表示がないことを確認します。
2. 「ホスト設定を取得」で調査用NICと送信元IPv4を選びます。対象CIDR・除外・ポート・承認DHCP・想定DNS/GWを確認します（空欄の基準は「基準未設定」になり、問題なしの根拠に使いません）。詳細調査は「経路と対象を確認」で表示した経路を承認してから開始します。
3. 「現地監査を開始」。受付・実行中・部分完了・失敗を区別し、段階（受付→設定確認→通信観測→機器探索・ポート→管理情報→最終化）、観測の経過・残り時間、探索のバッチ数を表示します。他の画面へ移動しても右下に実行中の内容と進捗が残り、クリックで監査画面へ戻れます。「監査を中止」で収集プロセスを停止します。
4. 結果の候補を選び、採用先セグメント・確認者を入力して「選択した結果を取り込む」。証跡を `data\evidence\<拠点ID>\<runId>\<ハッシュ>\` へ転送・検証してから正本を保存します。監査判定は未確認の下書きのままで、確定は監査フォームで行います。取り込み中は画面移動・ファイルを閉じる操作を止めます。
5. 取り込みの「取り消す」は業務データを戻し、取り込み記録を取消済みとして残します。証跡は削除しません。

スイッチの隣接情報は、`tylan-switch-export` v1形式のJSON（`records` に `protocol`（`lldp`/`cdp`/`mac-table`）・`localDevice`・`localPort`・`remoteDevice`・`remotePort`）を「スイッチ情報を取り込む」で読み込みます。資格情報の項目を含むファイルは拒否します。接続は両端の機器を選んだ候補だけを「推定」として採用し、MACテーブルは論理接続として扱います。

DNS問い合わせ名は既定でハッシュだけを残します。名前を証跡に残す場合は保持日数を指定してください（期限後の削除は管理操作で行い、自動削除はしません）。収集中の結果は `%LOCALAPPDATA%\tylan\audit-runs\` に保持します。実LANでの確認項目は [受入手順](doc/acceptance.md#現地監査の受入現地ゲート) を参照してください。

## 設計・受入

- [要件定義](doc/requirements.md)
- [基本設計](doc/basic-design.md)
- [最新仕様の調査・FCIS・検証記録](doc/implementation.md)
- [共有への公開・復旧・受入手順](doc/acceptance.md)
- [現地LAN監査の自動収集・マッピング計画](doc/audit-automation.md)（実装・自動検証の対応表は12章。実LANの現地ゲートは未実施）

閲覧用HTMLのローカル `file://` 表示はChromiumとEdgeで自動検証済みです。共有フォルダ（UNC）上の閲覧用HTML、NTFS権限、社内Chrome、標準PCでの性能、ExcelのCSV確認は運用先での受入が必要です。
