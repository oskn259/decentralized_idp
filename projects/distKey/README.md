# distKey

ノード群を起動する前に一度だけ実行する、信頼されたディーラー。グループの Ed25519 署名鍵を t-of-n で Shamir 分割してノード i に `s_i` を渡し、ユーザーごとに独立した TOPRF 鍵を同じ方式で分割して配る。

ユーザーの h はブラウザがサインオン時に計算するのと同じ手順で導出し、ノード i には `h_i = H(h, i)` だけを保存する。グループ鍵全体・全シェア・パスワードを目にするのはこのコマンドだけで、パスワードはどこにも書き出さない。DKG（鍵の分散生成）はスコープ外。

ノードにユーザー登録 API がないため、ユーザー登録もここで行う。distKey がパスワードを受け取るのはそのため。

## ディレクトリ構成

FROST・TOPRF・Shamir の計算は [`../sdk`](../sdk)（`@decentralized-idp/sdk`）にあり、ここでは使うだけ。鍵ファイルの形式は [`../protocol`](../protocol/README.md#鍵ファイル) が定める。

- `domain/usecase/distribute-keys.ts`: グループ鍵とユーザーごとの TOPRF 鍵を分割し、h を導出する。入力（`UserSpec`）と出力（`DistributedKeys`）の型もここ
- `infra/output.ts`: 生成した鍵を `group.json` / `node-<id>.json` にして書き出す
- `main.ts`: CLI の引数解析と実行

## 使い方

```bash
distKey --out <dir> [--threshold 2] [--total 3] [--users <u>:<pw>:<sub>,...] [--force]
```

| オプション | 意味 |
|---|---|
| `--out <dir>` | 必須。出力先ディレクトリ |
| `--threshold` | 閾値 t（デフォルト `2`） |
| `--total` | ノード数 n（デフォルト `3`） |
| `--users` | カンマ区切りの `<username>:<password>:<sub>`。パスワードはコロンを含んでよい。省略時は alice（`usr_alice_12345`）と bob（`usr_bob_67890`） |
| `--force` | 既存の鍵ファイルを上書き |
| `--help` | 使い方を表示 |

`<dir>/group.json` と `<dir>/node-<id>.json`（id は 1..n）を書き出す。`group.json` は gateway が、`node-<id>.json` はノード `<id>` が読む。

`<dir>` に全ファイルがすでにある場合、何も書き込まず終了コード 0 で終わる（compose での再起動のたびに鍵がローテーションされないようにするため）。一部だけある場合は `--force` を付けない限り終了コード 1 で失敗する。

## 開発

```bash
npm ci --prefix ../..
npm run dev -- --out ./out
npm run qa-gate    # typecheck + build
```

```bash
# リポジトリルートで
docker build -f projects/distKey/Dockerfile -t idp-distkey .
docker run --rm -v "$(pwd)/secrets:/secrets" idp-distkey --out /secrets
```

コンテナは uid 1000 で実行されるため、マウントする出力先ディレクトリはその uid から書き込み可能でなければならない。
