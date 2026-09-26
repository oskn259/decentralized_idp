# distKey

ノード群を起動する前に一度だけ実行する、信頼されたディーラー。グループの Ed25519 署名鍵を t-of-n で Shamir 分割してノード i に `s_i` を渡す。デモ用に、認証と支払いに要る身元も作る: RP と gateway の Ed25519 鍵対（`private_key_jwt` 用）と、RP・gateway・各ノードの EVM ウォレット（x402 用）。ウォレットは空で作られるので、使う前に入金する。本番ではこの部分は RP 登録と各運営者の準備に相当する。

グループ鍵全体と全シェアを目にするのはこのコマンドだけ。DKG（鍵の分散生成）はスコープ外。

ユーザー登録はここでは行わない。[`../idpFront`](../idpFront) のログインページがブラウザの中でユーザーごとの TOPRF 鍵を生成し、ノードごとのシェアを [`../node`](../node) の `/register` に直接送る。distKey はパスワードを一度も見ない。

## ディレクトリ構成

FROST・Shamir の計算は [`../sdk`](../sdk)（`@decentralized-idp/sdk`）にあり、ここでは使うだけ。鍵ファイルの形式は [`../protocol`](../protocol/README.md#鍵ファイル) が定める。

- `infra/output.ts`: 生成した鍵を `group.json` / `node-<id>.json` にして書き出す
- `main.ts`: CLI の引数解析と実行

## 使い方

```bash
distKey --out <dir> [--threshold 2] [--total 3] [--clients demo_client] [--force]
```

| オプション | 意味 |
|---|---|
| `--out <dir>` | 必須。出力先ディレクトリ |
| `--threshold` | 閾値 t（デフォルト `2`） |
| `--total` | ノード数 n（デフォルト `3`） |
| `--clients` | カンマ区切りの `client_id`（デフォルト `demo_client`）。`clients.json` と `client-<client_id>.json` を書く |
| `--force` | 既存の鍵ファイルを上書き |
| `--help` | 使い方を表示 |

`<dir>/group.json`、`<dir>/node-<id>.json`（id は 1..n、ウォレット入り）、`<dir>/clients.json`（RP の公開鍵）、`<dir>/client-<client_id>.json`（RP の秘密鍵とウォレット）、`<dir>/gateway.json`（gateway の秘密鍵とウォレット）、`<dir>/gateways.json`（gateway の公開鍵）を書き出す。`group.json`・`clients.json`・`gateway.json` は gateway が、`node-<id>.json`・`gateways.json` はノードが、`client-<client_id>.json` はその RP が読む。終わりに入金すべきアドレスを表示する。

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
