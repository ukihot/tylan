# tylan

共有フォルダから直接開く、社内ネットワークの調査・台帳・構成図・監査ツール。Svelte 5、Svelte Flow、Zodを使い、FCISで業務処理とブラウザー操作を分離しています。

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
bun run verify        # 上記検査＋ビルド＋file://配布物テスト
```

Biome 2.6.5でSvelte・HTML全体の対応を有効にしています。この機能はBiome公式でも実験的扱いのため、型チェックとブラウザーテストを併用します。VS Code用の拡張推奨・保存時整形も設定済みです。

## 配布・操作

```sh
bun run build
```

1. `dist/editor.html` を共有フォルダの `tools/` に置き、Edgeで直接開きます。利用者側にNode.js・Bun・サーバーは不要です。
2. 開始画面で「新しいJSONを作る」「前回のJSONをもとに作る」「既存のJSONを開く」のいずれかを選びます。保存先は `working/` です。
3. 拠点・機器・配線・設定・監査を登録します。確定した変更は開いているJSONへ自動保存されます（Ctrl+Sで即時保存）。不明値は未確認のまま残せます。
4. 「検証・書き出し」で公開範囲を設定してプレビューを確認し、「閲覧用HTMLを保存」で `published/` に保存します。

保存の直前にファイルの更新日時を確認し、別の場所で変更されていれば自動保存を止めます。業務データをlocalStorage・IndexedDBへ保存しません。File System Access APIを使えないブラウザーでは、JSONの読込とダウンロードによる書き出しで動作します。

ビルドは `dist/SHA256SUMS.txt` と `dist/THIRD-PARTY-LICENSES.txt` も生成します。閲覧用雛形は `.build/viewer/` に置き、編集用HTMLへ内包します。

## 設計・受入

- [要件定義](doc/requirements.md)
- [基本設計](doc/basic-design.md)
- [最新仕様の調査・FCIS・検証記録](doc/implementation.md)
- [共有への公開・復旧・受入手順](doc/acceptance.md)

ローカルの `file://` はChromiumとEdgeで自動検証済みです。実際のUNC共有、NTFS権限、社内Chrome、標準PCでの性能、ExcelのCSV確認は配布先での受入が必要です。
