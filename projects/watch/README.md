# watch

デモ用に、distKey が作った各ウォレット（RP、gateway、node1〜3）の USDC 残高をターミナルに並べ、数秒ごとに更新する。起動時からの増減（Δ）と、直前の更新で増えた行に `▲`、減った行に `▼` を付ける。x402 の決済が RP → gateway → ノードと流れる様子を、サインインや Refresh の操作と並べて見せるためのもの。

鍵ファイルからはウォレットのアドレスだけを読む。秘密鍵は使わない。

## 使い方

```bash
# リポジトリルートで
npm run build -w projects/watch
npm run watch                  # ./secrets を読む
npm run watch -- path/to/dir   # 別のディレクトリ
```

| 環境変数 | 意味 |
|---|---|
| `RPC_URL` | 残高を読む RPC（デフォルト `https://sepolia.base.org`） |
| `NETWORK` | CAIP-2 のネットワーク。USDC のアドレスは sdk の `USDC` から引く（デフォルト `eip155:84532`） |
| `INTERVAL` | 更新間隔の秒数（デフォルト `3`） |

RPC が失敗したときは直前の値を表示したまま警告を1行出し、次の更新で再試行する。

## 開発

```bash
npm run dev -- ../../secrets
npm run qa-gate    # typecheck + build
```
