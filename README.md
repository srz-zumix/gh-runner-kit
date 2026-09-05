# gh-runner-kit

`gh-runner-kit` は `gh-team-kit` をベースにした GitHub CLI 拡張の雛形です。

コマンドの詳細実装はまだ含めず、`gh` 拡張として必要な Go/Cobra ベースの最小構成と、開発用のワークフロー・設定ファイルを取り込んでいます。

## 開発

```sh
go mod tidy
go build ./...
go test ./...
```

## インストール

```sh
gh extension install .
```

## 現在の構成

- `main.go`: エントリーポイント
- `cmd/root.go`: ルートコマンド
- `cmd/runner.go`: 将来の runner 系コマンドを追加するためのプレースホルダー
- `version/version.go`: リリース用バージョン定義
- `.github/workflows/*`: ビルド・リリース・Lint 用ワークフロー
