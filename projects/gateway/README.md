# gateway

RP（relying party）とブラウザが直接話す相手であり、n台あるアイデンティティノードの手前に立つOAuth 2.0の認可サーバー。FROSTラウンドを中継し、各ノードの署名シェアを合算してグループ署名を組み立て、グループ公開鍵をJWKSとして公開し、ログインUIを配信する。

ユーザーに関する状態を一切持たない。セッションも、認可コードの保管も、リフレッシュトークンの保管もしない。認可コードはアサーションそのものであり、リフレッシュトークンはグループ署名されたJWTである。ゲートウェイはサインオンのシェアを読むこともできず（`h_i`を持たない）、単独で何かに署名することもできない（鍵シェアを持たない）。

読者はFROST（閾値Ed25519署名）とTOPRF（閾値OPRF）の基本、およびOAuthを知っているものとする。記号は `s_i` = ノード i の署名鍵シェア、`k_i` = ユーザーごとのTOPRF鍵シェア、`h_i` = ノード i がサインオンのシェアを暗号化する鍵。鍵ファイルではバイト列を hex、HTTP 上では base64url で表す。

## ディレクトリ構成

[`../sdk`](../sdk)（`@decentralized-idp/sdk`）はサンプル各コンポーネントが共有するプロトコルのTypeScript実装（計算、トークンのレイアウト、ノードAPIのスキーマ）。ここでは使うだけ。

- `domain/value/group.ts`: ゲートウェイが知るグループの情報（`issuer`、閾値、公開鍵、`kid`）。シェアは持たない
- `domain/value/client.ts`: 登録済みクライアント（`client_id` と Ed25519 公開鍵）
- `domain/infra/clock.ts`: 現在時刻の取得
- `domain/infra/node.ts`: ノードとの通信のインターフェース（`Node`）とその要求・応答の型
- `domain/usecase`: domainの外に提供する機能
  - `gateway.ts` の `openRounds`: 全ノードにFROSTラウンドを開かせ、閾値を満たすかを見る
  - `sign-on.ts` の `signOn`: サインオンの2ラウンドを中継する
  - `issue-tokens.ts` の `issueTokens`: クレデンシャルとDPoPプルーフからアクセストークンとリフレッシュトークンを組み立てる
  - `client-auth.ts` の `authenticateClient`: `private_key_jwt` のクライアント認証
  - `oauth-error.ts` の `OAuthError`: `/token` の拒否とそのエラーコード
  - `gateway.ts` の `Billing`: `/token` の料金（`PaymentTerms`）、クライアントごとのクレジット、決済器
- `infra`: `domain/infra` の実装
  - `group.ts` の `loadGroup`: `group.json`の読み込み
  - `clients.ts` の `loadClients`: `clients.json`の読み込み
  - `node.ts`: ノードとHTTPで話す`HttpNode`と、起動時にノードを探す`discoverNodes`。`HttpNode`はsdkの`node-api`スキーマでエンコード・デコードし、形の崩れたノードの応答は拒否する。`/sign`にはゲートウェイの`clientAssertion`を載せ、402なら支払って再送する`fetch`で呼ぶ
  - `identity.ts` の `loadIdentity`: `gateway.json`の読み込みと、ノード宛ての`clientAssertion`の署名
  - `credit-store.ts` の `FileCreditStore`: クレジット残高を`CREDITS_FILE`に保存する
  - `clock.ts` の `systemClock`: 現在時刻
- `http`: [Hono](https://hono.dev) + `@hono/node-server` によるHTTP層
  - `server.ts`: Honoアプリの組み立て。メソッドとパスをここに並べ、各endpointを接続する
  - `endpoint/*.ts`: エンドポイント1本につき1ファイル。クエリ・ボディ・フォームのスキーマ（[Zod](https://zod.dev)）もここに置き、`server.ts` が `@hono/zod-validator` で接続する。base64url→bytesなどスキーマの部品はsdkの`node-api`から取る。`ui.ts` はログインページ（`LOGIN_DIST` の `index.html` と `assets/*`）の配信
  - `validate.ts`: 検証失敗を `400 { error, error_description }`（OAuth）/ `400 { error }` にするフック
  - `demo-log.ts`: デモトレースの行出力器。文面は各endpointが組む

依存は常に下へ向かう（`tests/dependencies.test.ts` が検査する）。

| from | to |
|---|---|
| `main` | `http`, `http/{demo-log,validate}`, `infra`, `domain/usecase` |
| `http/server` | `http/endpoint`, `http/{demo-log,validate}`, `domain/usecase` |
| `http/endpoint` | `http/{demo-log,validate}`, `domain/usecase`, `domain/value` |
| `infra` | `domain/infra`, `domain/value` |
| `domain/usecase` | `domain/infra`, `domain/value` |
| `domain/infra`, `domain/value`, `http/{demo-log,validate}` | なし（sdkのみ） |

## 実行

```bash
npm ci --prefix ../..            # ワークスペース全体を一度に入れる
npm run build --prefix ../sdk
npm run dev    # tsxでsrc/main.tsを直接実行
```

### 環境変数

| 変数 | デフォルト | 意味 |
|---|---|---|
| `PORT` | `3000` | listenポート |
| `ISSUER` | `http://localhost:<PORT>` | ブラウザから見たゲートウェイのURL。全トークンの`iss`、メタデータの`issuer` |
| `GROUP_CONFIG` | `/secrets/group.json` | distKeyが書き出す`group.json`のパス |
| `CLIENTS_CONFIG` | `/secrets/clients.json` | distKeyが書き出す`clients.json`（登録済みクライアント）のパス |
| `GATEWAY_KEY_FILE` | `/secrets/gateway.json` | distKeyが書き出す`gateway.json`（ゲートウェイ自身の鍵とウォレット）のパス |
| `NETWORK` | `eip155:84532` | 支払いのチェーン（CAIP-2）。`eip155:84532`（Base Sepolia）か`eip155:8453`（Base） |
| `RPC_URL` | `https://sepolia.base.org` | 決済をチェーンに送るRPC |
| `PRICE_TOKEN` | `10000` | `/token` 1回の料金（USDCの最小単位。10000 = 0.01 USDC） |
| `CREDIT_BATCH` | `100` | 1回の支払いで買う`/token`の回数 |
| `CREDITS_FILE` | `/data/credits.json` | クライアントごとのクレジット残高の保存先 |
| `NODE_URLS` | `http://localhost:4001,http://localhost:4002,http://localhost:4003` | カンマ区切りのノードのベースURL |
| `LOGIN_DIST` | `/app/ui` | ビルド済みログインUIのディレクトリ |
| `RP_ORIGIN` | `http://localhost:3001` | `/token`と`/jwks.json`へのクロスオリジンアクセスを許すorigin。デフォルトは [`../rp`](../rp) のもの |
| `DEMO_LOG` | 有効 | `0`でデモトレースを止める |
| `FORCE_COLOR` | 未設定 | 設定されていれば`0`以外で有色。未設定ならTTY判定に従う |

起動時、`NODE_URLS`の各エントリに`/health`を問い合わせて`nodeId`を確定する（どのURLがどのノードかは`NODE_URLS`自体には書かれていない）。返るグループ公開鍵が`group.json`と一致しなければ起動を止める。まだ起きていないノードは一定回数リトライする。

## HTTP API

RP から見ると RFC 6749 の認可コードフロー + RFC 9449 DPoP + RFC 9068 の JWT アクセストークン。`dpop_jkt` は RFC 9449 §10 の標準パラメータ。client 認証は `private_key_jwt`（RFC 7523、[クライアント認証](#クライアント認証)）、PKCE は受け取って無視する（DPoP の鍵束縛が同じ役割を担う）。`../rp` は `openid-client` と `jose` だけで繋がる。

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/health` | 稼働確認。ノードが閾値を満たしていれば200、下回れば503 |
| GET | `/.well-known/oauth-authorization-server` | OAuth のメタデータ（RFC 8414）。OpenID Connect ではないので id_token はない |
| GET | `/jwks.json` | グループ公開鍵（CORS: `RP_ORIGIN`） |
| GET | `/authorize` | 認可リクエストを受け、ログインページへ302 |
| GET | `/api/pasta/nodes` | 閾値と、ブラウザから各ノードへ届く URL |
| POST | `/api/pasta/sign-on` | ログインページからのサインオンの中継 |
| POST | `/token` | 認可コードまたはリフレッシュトークンをアクセストークンに交換。有料（[支払い](#支払い)） |
| GET | `/`, `/login`, `/assets/*` | ログインUIの静的配信 |

```
GET /health
→ 200 { "status": "ok", "nodes": [{ "nodeId", "url", "healthy" }, ...] }
→ 503 { "status": "degraded", "nodes": [...] }   # 閾値に届く台数が健全でない

GET /authorize?client_id=...&redirect_uri=...&response_type=code&scope=...&dpop_jkt=<43文字>&state=...
→ 302 /login?step=login&c=<challenge>&client_id=...&redirect_uri=...&scope=...&state=...&dpop_jkt=...
→ 302 redirect_uri?error=invalid_request&error_description=<field>: <理由>&state=...   # redirect_uri が使えるとき（RFC 6749 §4.1.2.1）
→ 400 { "error": "invalid_request", "error_description": "<field>: <理由>" }        # redirect_uri が無い・不正なとき
→ 400 { "error": "unauthorized_client", "error_description": "unknown client_id <id>" }   # 未登録の client_id。redirect_uri は信用せずリダイレクトしない

GET /api/pasta/nodes
→ 200 { "threshold", "total", "nodes": [{ "nodeId", "url" }] }   # nodeId 昇順。url は各ノードの /health の publicUrl

POST /api/pasta/sign-on
{ "username", "blinded": "<base64url 32byte>", "sessionNonce": "<base64url>",
  "cnfJkt", "clientId", "scope", "nonce", "iat", "exp" }
→ { "commitments": [{ "nodeId", "D", "E" }], "shares": [{ "nodeId", "toprfPartial", "ct_i", "sub" }] }
→ 400 { "error": string }

POST /token   (application/x-www-form-urlencoded)
DPoP: <proof>
grant_type=authorization_code&code=<assertion>&client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer&client_assertion=<jwt>
grant_type=refresh_token&refresh_token=<jwt>&client_assertion_type=...&client_assertion=<jwt>
（client_id は任意。送るなら認証されたクライアントと一致すること）
→ 200 { "access_token", "token_type": "DPoP", "expires_in", "refresh_token", "scope" }
→ 400 { "error", "error_description" }   # invalid_request | invalid_client | invalid_grant | invalid_dpop_proof
→ 402 { "error": "payment_required", "error_description" }   # クレジット切れ。PAYMENT-REQUIRED ヘッダ付き
Cache-Control: no-store （成功・失敗とも）
PAYMENT-SIGNATURE: <x402 の支払い>   # 402 を受けた後の再送に添える。決済できれば応答に PAYMENT-RESPONSE
```

メタデータは `token_endpoint_auth_methods_supported: ["private_key_jwt"]`、`token_endpoint_auth_signing_alg_values_supported: ["EdDSA", "Ed25519"]` を返す。

## クライアント認証

`/token` はクライアントを `private_key_jwt`（RFC 7523 §2.2）で認証する。登録されたRPだけが、自分の `client_id` 宛てに発行された認可コードとリフレッシュトークンを交換できる。`client_assertion` について確かめるのは次のとおり。どれかが欠ければ `invalid_client`。

- `iss` が登録済みの `client_id` で、その鍵のEd25519署名（`alg` は `EdDSA` か `Ed25519`）
- `sub` = `iss`
- `aud` が `issuer` か `<issuer>/token`（文字列、またはどちらかを含む配列）
- `exp` が未来、`jti` がある（DPoPと同じく `jti` の再利用は追跡しない）

そのうえでクレデンシャルの `client_id` が認証されたクライアントと違えば `invalid_grant`。`/authorize` も未登録の `client_id` を拒否する。

クライアントは `CLIENTS_CONFIG` のファイルで事前登録する（distKeyが書き出す）。各クライアントのJWKSの最初の `kty: OKP, crv: Ed25519` 鍵を使い、無ければ起動を止める。

```json
{ "version": 1, "clients": [
  { "client_id": "demo_client",
    "jwks": { "keys": [{ "kty": "OKP", "crv": "Ed25519", "x": "<base64url 32byte>", "kid": "demo_client-key-1", "use": "sig", "alg": "EdDSA" }] } }
] }
```

## 支払い

x402 v2（`exact` スキーム、USDC）の前払いクレジット。規則は [`../protocol`](../protocol/README.md#支払い) のノードの `/sign` と同じで、ゲートウェイは受け取る側と払う側の両方に立つ。

- **RPに課金する**: `/token` はクライアント認証の後、そのクライアントの残高を見る。無ければ402。RPが `PAYMENT-SIGNATURE` を添えて再送すると、ゲートウェイは自分で検証してチェーンに送り（自分がファシリテーター。ガスは `wallet` から払う）、`CREDIT_BATCH` 回分を足す。トークンを発行できたときだけ1減らす。400で終わった要求は無料
- **ノードに払う**: `/sign` の呼び出しには `gateway.json` の鍵で署名した `clientAssertion`（`iss` = `sub` = `client_id`、`aud` = ノードの `publicUrl`、`exp` = 60秒後）を載せる。ノードが402を返せば、同じ `wallet` から支払って再送する。ノード側の単価と回数はノードの設定
- **損失はゲートウェイが負う**: `/sign` は全ノードが署名して初めてトークンになる。一部のノードに支払った（クレジットを使った）後で発行が失敗すれば、RPのクレジットは減らず、ノードに払った分はゲートウェイの持ち出しになる

`GATEWAY_KEY_FILE`（distKeyが書き出す）:

```json
{ "client_id": "gateway",
  "key": { "kty": "OKP", "crv": "Ed25519", "x": "<base64url>", "d": "<base64url>", "kid": "gateway-key-1" },
  "wallet": { "address": "0x…", "privateKey": "0x…" } }
```

ノードはこの公開鍵を `gateways.json` で知っている。`wallet` はRPからの支払いを受け取り、ノードへ払い、決済のガスを払うEVMアカウントで、USDCとガス用のETHが要る。

`CREDITS_FILE` は `{ "version": 1, "credits": { "<client_id>": <残り回数> } }`。変わるたびに丸ごと書き直す。

## 登録

登録はブラウザから各ノードの`/register`へ直接送られる。ゲートウェイはノードのURLを公開するだけで、シェアを一切目にしない。

## 検証範囲とラウンドの規則

ゲートウェイ自身が確かめるのは、提示されたクレデンシャル（アサーションまたはリフレッシュトークン）から `sub`・`client_id`・`scope`・`cnf.jkt` を検証せずに読むことと、DPoPプルーフの鍵が`cnf.jkt`と一致することだけ。有効期限・グループ署名・DPoPプルーフの再検証は各ノードが自分自身で行う。`sub` はノードが自分のユーザーレコードから決めるもので、全ノードが同じユーザー集合を持つため一致する。

ラウンド1は全ノードに対して開く。失敗したノードは、閾値を満たす台数が残っている限り除外して続行する。ラウンド2は全員一致でなければならない（Rとラグランジュ係数がラウンド1のコミットメント集合で固定されるため）。ラウンド2で1台でも失敗すればその要求は400で終わり、クライアントがやり直す。`/token`ではラウンド1の閾値不足もラウンド2の拒否も、クライアントには`invalid_grant`として現れる。`/token`は1回でラウンドを2つ使う（アクセストークン用とリフレッシュトークン用）。

### 3種のJWT

いずれもヘッダは `{ alg: "EdDSA", typ, kid: "pasta-group-key-1" }`、署名はグループ鍵。レイアウトは `@decentralized-idp/sdk/tokens` にあり、署名するノードと合成するゲートウェイが同じ関数で組む。

| | `typ` | ペイロード |
|---|---|---|
| アサーション（= 認可コード） | `JWT` | `iss, sub, aud=iss, client_id, scope, cnf.jkt, nonce=c, iat, exp（≤30秒）` |
| アクセストークン | `at+jwt` | `iss, sub, aud=client_id, scope, cnf.jkt, iat, exp（1時間）, jti` |
| リフレッシュトークン | `refresh+jwt` | `iss, sub, client_id, scope, cnf.jkt, iat, exp（30日）` |

## デモログ

`DEMO_LOG`が有効なとき、標準出力に1〜2行のトレースを出す。ワイヤに乗った値のみを先頭8文字に切って出す。

```
[gateway] ● up      t=2/3 issuer=http://localhost:3000   holds: group pubkey, kid=pasta-group-key-1   never: s_i, k_i, h_i, pw, sessions
[gateway] authorize client_id=demo_client nonce=3d9dbfed-7e01-4d89-80c9-75443191a34b state=st dpop_jkt=VmE7pTg_  → redirect /login
[gateway] sign-on   round=fb3792a0 user=alice nonce=c-1  ← A AkmcCzoP  jkt VmE7pTg_  (no pw)
                    round1 (D,E)×2 (node3 unreachable, excluded) → round2 ← B_i×2 ct_i×2 (no h_i, cannot decrypt) → relayed as-is
[gateway] pay       from=demo_client +100 credits (settled 0x3f5a9c)
[gateway] token     grant=authz client=demo_client  ← code(assertion) eyJhbGci + DPoP ✓ (node3 unreachable, excluded)  → 2×/commit ×2 → /sign → access_token eyJhbGciOiJFZERT (cnf.jkt=VmE7pTg_) + refresh_token credits=99
[gateway] discovery public only
[gateway] jwks      public only
[gateway] ✖ sign-on rejected: quorum 1 < 2 (node3 unreachable)
[gateway] ✖ token rejected: invalid_client: client_assertion: Invalid Ed25519 signature
[gateway] ✖ token rejected: payment_required: payment required
```

`credits=`はそのクライアントの残り回数。ノードへの支払いはログに出さない（ノード側が出す）。

`(node3 unreachable, excluded)`は、そのラウンドが1台欠けたまま閾値を満たして進んだことを示す。

## 開発

```bash
npm test          # vitest（../sdk のビルド込み）
npm run typecheck
npm run qa-gate    # typecheck + build + テスト
```

テストは、ノードが失敗や不正な応答を返したときの gateway の振る舞い（除外、quorum、OAuth のエラーコード）を fake ノードで見るもの、攻撃者側から見たクライアント認証（アサーション無し、未登録の鍵、他クライアントのコード、未登録の `client_id`）、支払い（クレジット切れ、1バッチ分だけ使えること、拒否された要求は無料、決済の失敗）、ノードから見た `/sign` の `clientAssertion`、依存方向の検査だけ。ユーザーから見た動作は [`../e2e`](../e2e)。

```bash
# リポジトリルートで
docker build -f projects/gateway/Dockerfile -t idp-gateway .
docker run --rm -v "$(pwd)/secrets:/secrets:ro" \
  -e NODE_URLS=http://node1:4001,http://node2:4002,http://node3:4003 \
  -p 3000:3000 idp-gateway
```

ログインページ（`LOGIN_DIST`が指すディレクトリ）は、このDockerfileが [`../idpFront`](../idpFront) をViteでビルドして `/app/ui` に組み込む。
