# rp

RP（relying party）の最小実装。ユーザーをゲートウェイの `/authorize` へ送り、戻ってきた認可コード（＝アサーション）をDPoP鍵に束縛されたアクセストークンに交換し、そのクレームを表示する。第三者のサービスの立ち位置であり、[`../gateway`](../gateway) や [`../idpFront`](../idpFront) とは別のコンポーネント。

RPがパスワードを見ることはない。パスワードはブラウザの中のログインページ（`../idpFront`）でアサーションに変わり、RPに届くのはそのアサーションだけ。RPがノードと話すこともない。話す相手はゲートウェイの `/authorize`、`/token`、`/jwks.json` のみ。

ゲートウェイと違い、RPは状態を持つ。サインインごとにDPoP鍵ペアを作り、`state` をキーにメモリ上で覚えておく。

## ディレクトリ構成

[`../sdk`](../sdk)（`@decentralized-idp/sdk`）のDPoP・JWT・base64urlをここでは使うだけ。

- `src/main.ts`: 環境変数を読んで起動
- `src/http/server.ts`: [Hono](https://hono.dev) + `@hono/node-server` のルート一式と、サインインのセッション表
- `src/token.ts`: `POST /token` の呼び出し。フォームボディにクレデンシャル、ヘッダにその1回限りのDPoPプルーフ。`../idpFront/cli.ts` もRP役としてこれを使う
- `src/verify.ts`: アクセストークンの検証。ゲートウェイの `/jwks.json` から `kid` の合う鍵を取って署名を確かめ、`aud` が自分の `client_id` か、`cnf.jkt` がこのセッションのDPoP鍵かを見る

## 流れ

1. `GET /login`: `state` とDPoP鍵ペアを作って覚え、ゲートウェイの `/authorize` へ302。クエリには `dpop_jkt`（鍵のサムプリント）を乗せる。
2. ゲートウェイがログインページへ送り、ページがアサーションを組み立てて `redirect_uri?code=<assertion>&state=<state>` に戻る。
3. `GET /callback`: `state` を照合して忘れ、`code` を `/token` でトークンに交換し、アクセストークンを検証して `sub`・`scope`・`exp` を表示する。
4. 表示ページの Refresh ボタンは `POST /refresh`。覚えておいたリフレッシュトークンを新しいDPoPプルーフとともに `/token` へ送り、同じページを描く。

## 実行

```bash
npm ci --prefix ../..            # ワークスペース全体を一度に入れる
npm run build --prefix ../sdk
npm run dev    # tsxでsrc/main.tsを直接実行
```

ブラウザで `http://localhost:3001/` を開き、Sign in を押す。

### 環境変数

| 変数 | デフォルト | 意味 |
|---|---|---|
| `PORT` | `3001` | listenポート |
| `GATEWAY_URL` | `http://localhost:3000` | ブラウザから見たゲートウェイのURL。`/authorize` の宛先であり、DPoPプルーフの `htu` が指す issuer |
| `RP_URL` | `http://localhost:<PORT>` | 自身の公開URL。`redirect_uri` は `<RP_URL>/callback` |
| `CLIENT_ID` | `demo_client` | OAuthの `client_id` |
| `SCOPE` | `openid profile` | OAuthの `scope` |

## HTTP API

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/` | Sign in リンクのページ |
| GET | `/login` | `state` とDPoP鍵を作り、ゲートウェイの `/authorize` へ302 |
| GET | `/callback?code&state` | 認可コードをトークンに交換し、クレームを表示。未知の `state` は400。ゲートウェイの `/token` が返したエラーはそのステータスで表示 |
| POST | `/refresh` | フォーム `session=<id>`。リフレッシュトークンで再取得し、クレームを表示。未知の `session` は400 |

## 開発

```bash
npm test          # vitest（../sdk のビルド込み）
npm run typecheck
npm run qa-gate    # typecheck + build + カバレッジ付きテスト
```

`tests/http.test.ts` はゲートウェイなしでRPのルートだけを叩く。`tests/e2e.test.ts` と `tests/token.test.ts` は `../node` と `../gateway` を同一プロセスで実HTTPとして起こし、ログインページの `signOn` でアサーションを作る。

```bash
# リポジトリルートで
docker build -f projects/rp/Dockerfile -t idp-rp .
docker run --rm -e GATEWAY_URL=http://localhost:3000 -p 3001:3001 idp-rp
```
