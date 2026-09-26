# rp

RP（relying party）。**普通のOAuthクライアントライブラリだけ**で組み立てた実装で、`openid-client` v6（RFC 8414のディスカバリ、認可コードフロー、DPoP、`private_key_jwt` のクライアント認証）と `jose`（アクセストークンの検証）しか使わない。このリポジトリの `sdk` には依存せず、PASTAもFROSTもノードも一切知らない。それでも普通のOAuthクライアントとして動くという事実が、ゲートウェイが標準的なOAuth 2.0 + DPoPの認可サーバーであることを証明している。

## ファイル

- `src/main.ts`: 環境変数を読み、`CLIENT_KEY_FILE`（distKey が書く `client-<client_id>.json`）の秘密鍵を WebCrypto に取り込んで起動
- `src/http/server.ts`: `openid-client` でゲートウェイをディスカバリし、Hono のルート一式（`GET /`・`GET /login`・`GET /callback`・`POST /refresh`）とサインインのセッション表を持つ。セッションは最初 `state` をキーに置き、`/callback` で読んで消してから新しいidをキーに積み直す。どのキーも一度使われたら捨てる

## 流れ

1. `GET /login`: 新しい `state` とDPoP鍵ペア（EdDSA、`randomDPoPKeyPair` + `getDPoPHandle`）を作ってセッション表に控え、鍵のサムプリントを `dpop_jkt` としてクエリに乗せ、ゲートウェイの認可エンドポイントへ302（`buildAuthorizationUrl`）
2. ブラウザはゲートウェイが返すログインページに送られ、そこでの認証が認可コードになる
3. `GET /callback?code&state`: `state` をセッション表から引いて消費し、`authorizationCodeGrant` が `code` をDPoPプルーフと `client_assertion`（自分の鍵で署名した短命の JWT）付きでトークンエンドポイントへ送る。`client_assertion` は `openid-client` の `PrivateKeyJwt` が作る
4. 受け取ったアクセストークンを `jwtVerify` で検証し、`sub`・`scope`・`exp` を表示する
5. 表示ページの Refresh は `POST /refresh`。保存しておいたリフレッシュトークンとDPoPハンドルを `refreshTokenGrant` に渡し、同じ検証・表示を繰り返す

## HTTP API

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/` | Sign in リンクのページ |
| GET | `/login` | `state` とDPoP鍵を作り、ゲートウェイの認可エンドポイントへ302 |
| GET | `/callback?code&state` | 認可コードをトークンに交換し、クレームを表示。未知の `state` は400 |
| POST | `/refresh` | フォーム `session=<id>`。リフレッシュトークンで再取得し、クレームを表示。未知の `session` は400 |

## 環境変数

| 変数 | デフォルト | 意味 |
|---|---|---|
| `PORT` | `3001` | listenポート |
| `GATEWAY_URL` | `http://localhost:3000` | ブラウザから見たゲートウェイのURL。OAuthのissuerでありディスカバリの起点 |
| `RP_URL` | `http://localhost:<PORT>` | 自身の公開URL。`redirect_uri` は `<RP_URL>/callback` |
| `CLIENT_ID` | `demo_client` | OAuthの `client_id` |
| `SCOPE` | `profile` | OAuthの `scope` |

## 検証の分担

`state` の一致確認、DPoPプルーフの生成、レスポンスの `token_type` が `DPoP` であることの確認は `openid-client` がやる。`jwtVerify` は署名・`issuer`・`audience`・`typ: at+jwt` を見るが、`cnf.jkt` がこのセッションのDPoP鍵のサムプリントと一致するかまでは知らないので、それだけはrp自身が確かめる。

`GATEWAY_URL` が `http:` の場合はディスカバリに `allowInsecureRequests` を渡す。平文httpのissuerを許すのはこのデモのためだけで、本番では使わない。

## 開発

```bash
npm run typecheck
npm run qa-gate    # typecheck + build
```

テストは持たない。rp は普通の OAuth クライアントのサンプルであり、その振る舞いはブラウザから通す [`../e2e`](../e2e) で見る。

```bash
# リポジトリルートで
docker build -f projects/rp/Dockerfile -t idp-rp .
docker run --rm -e GATEWAY_URL=http://localhost:3000 -p 3001:3001 idp-rp
```

`compose.yaml` ではrpがゲートウェイのネットワーク名前空間を共有する（`network_mode: "service:gateway"`）ので、コンテナの中からも `http://localhost:3000` がゲートウェイを指す。
