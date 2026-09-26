# gateway

RP（relying party）とブラウザが直接話す相手であり、n台あるアイデンティティノードの手前に立つOAuth 2.0の認可サーバー。FROSTラウンドを中継し、各ノードの署名シェアを合算してグループ署名を組み立て、グループ公開鍵をJWKSとして公開し、ログインUIを配信する。

ユーザーに関する状態を一切持たない。セッションも、認可コードの保管も、リフレッシュトークンの保管もしない。認可コードはアサーションそのものであり、リフレッシュトークンはグループ署名されたJWTである。ゲートウェイはサインオンのシェアを読むこともできず（`h_i`を持たない）、単独で何かに署名することもできない（鍵シェアを持たない）。

読者はFROST（閾値Ed25519署名）とTOPRF（閾値OPRF）の基本、およびOAuthを知っているものとする。記号は `s_i` = ノード i の署名鍵シェア、`k_i` = ユーザーごとのTOPRF鍵シェア、`h_i` = ノード i がサインオンのシェアを暗号化する鍵。鍵ファイルではバイト列を hex、HTTP 上では base64url で表す。

## ディレクトリ構成

[`../sdk`](../sdk)（`@decentralized-idp/sdk`）はサンプル各コンポーネントが共有するプロトコルのTypeScript実装（計算、トークンのレイアウト、ノードAPIのスキーマ）。ここでは使うだけ。

- `domain/value/group.ts`: ゲートウェイが知るグループの情報（`issuer`、閾値、公開鍵、`kid`）。シェアは持たない
- `domain/infra/clock.ts`: 現在時刻の取得
- `domain/infra/node.ts`: ノードとの通信のインターフェース（`Node`）とその要求・応答の型
- `domain/usecase`: domainの外に提供する機能
  - `gateway.ts` の `openRounds`: 全ノードにFROSTラウンドを開かせ、閾値を満たすかを見る
  - `sign-on.ts` の `signOn`: サインオンの2ラウンドを中継する
  - `issue-tokens.ts` の `issueTokens`: クレデンシャルとDPoPプルーフからアクセストークンとリフレッシュトークンを組み立てる
- `infra`: `domain/infra` の実装
  - `group.ts` の `loadGroup`: `group.json`の読み込み
  - `node.ts`: ノードとHTTPで話す`HttpNode`と、起動時にノードを探す`discoverNodes`。`HttpNode`はsdkの`node-api`スキーマでエンコード・デコードし、形の崩れたノードの応答は拒否する
  - `clock.ts` の `systemClock`: 現在時刻
- `http`: [Hono](https://hono.dev) + `@hono/node-server` によるHTTP層
  - `server.ts`: Honoアプリの組み立て。メソッドとパスをここに並べ、各endpointを接続する
  - `endpoint/*.ts`: エンドポイント1本につき1ファイル。クエリ・ボディ・フォームのスキーマ（[Zod](https://zod.dev)）もここに置き、`server.ts` が `@hono/zod-validator` で接続する。base64url→bytesなどスキーマの部品はsdkの`node-api`から取る。`ui.ts` はログインページ（`LOGIN_DIST` の `index.html` と `assets/*`）の配信
  - `validate.ts`: 検証失敗を `400 { error: "invalid_request", error_description }` / `400 { error }` にするフック
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
| `NODE_URLS` | `http://localhost:4001,http://localhost:4002,http://localhost:4003` | カンマ区切りのノードのベースURL |
| `LOGIN_DIST` | `/app/ui` | ビルド済みログインUIのディレクトリ |
| `RP_ORIGIN` | `http://localhost:3001` | `/token`と`/jwks.json`へのクロスオリジンアクセスを許すorigin。デフォルトは [`../rp`](../rp) のもの |
| `DEMO_LOG` | 有効 | `0`でデモトレースを止める |
| `FORCE_COLOR` | 未設定 | 設定されていれば`0`以外で有色。未設定ならTTY判定に従う |

起動時、`NODE_URLS`の各エントリに`/health`を問い合わせて`nodeId`を確定する（どのURLがどのノードかは`NODE_URLS`自体には書かれていない）。返るグループ公開鍵が`group.json`と一致しなければ起動を止める。まだ起きていないノードは一定回数リトライする。

## HTTP API

RP から見ると RFC 6749 の認可コードフロー + RFC 9449 DPoP + RFC 9068 の JWT アクセストークン。`dpop_jkt` は RFC 9449 §10 の標準パラメータ。client 認証は `none`、PKCE は受け取って無視する（DPoP の鍵束縛が同じ役割を担う）。`../rp` は `openid-client` と `jose` だけで繋がる。

| メソッド | パス | 内容 |
|---|---|---|
| GET | `/health` | 稼働確認。ノードが閾値を満たしていれば200、下回れば503 |
| GET | `/.well-known/oauth-authorization-server` | OAuth のメタデータ（RFC 8414）。OpenID Connect ではないので id_token はない |
| GET | `/jwks.json` | グループ公開鍵（CORS: `RP_ORIGIN`） |
| GET | `/authorize` | 認可リクエストを受け、ログインページへ302 |
| POST | `/api/pasta/sign-on` | ログインページからのサインオンの中継 |
| POST | `/token` | 認可コードまたはリフレッシュトークンをアクセストークンに交換 |
| GET | `/`, `/login`, `/assets/*` | ログインUIの静的配信 |

```
GET /health
→ 200 { "status": "ok", "nodes": [{ "nodeId", "url", "healthy" }, ...] }
→ 503 { "status": "degraded", "nodes": [...] }   # 閾値に届く台数が健全でない

GET /authorize?client_id=...&redirect_uri=...&response_type=code&scope=...&dpop_jkt=<43文字>&state=...
→ 302 /login?step=login&c=<challenge>&client_id=...&redirect_uri=...&scope=...&state=...&dpop_jkt=...
→ 302 redirect_uri?error=invalid_request&error_description=<field>: <理由>&state=...   # redirect_uri が使えるとき（RFC 6749 §4.1.2.1）
→ 400 { "error": "invalid_request", "error_description": "<field>: <理由>" }        # redirect_uri が無い・不正なとき

POST /api/pasta/sign-on
{ "username", "blinded": "<base64url 32byte>", "sessionNonce": "<base64url>",
  "cnfJkt", "clientId", "scope", "nonce", "iat", "exp" }
→ { "commitments": [{ "nodeId", "D", "E" }], "shares": [{ "nodeId", "toprfPartial", "ct_i", "sub" }] }
→ 400 { "error": string }

POST /token   (application/x-www-form-urlencoded)
DPoP: <proof>
grant_type=authorization_code&code=<assertion>
grant_type=refresh_token&refresh_token=<jwt>
→ 200 { "access_token", "token_type": "DPoP", "expires_in", "refresh_token", "scope" }
→ 400 { "error", "error_description" }   # invalid_request | invalid_grant | invalid_dpop_proof
Cache-Control: no-store （成功・失敗とも）
```

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
[gateway] token     grant=authz  ← code(assertion) eyJhbGci + DPoP ✓ (node3 unreachable, excluded)  → 2×/commit ×2 → /sign → access_token eyJhbGciOiJFZERT (cnf.jkt=VmE7pTg_) + refresh_token
[gateway] discovery public only
[gateway] jwks      public only
[gateway] ✖ sign-on rejected: quorum 1 < 2 (node3 unreachable)
```

`(node3 unreachable, excluded)`は、そのラウンドが1台欠けたまま閾値を満たして進んだことを示す。

## 開発

```bash
npm test          # vitest（../sdk のビルド込み）
npm run typecheck
npm run qa-gate    # typecheck + build + カバレッジ付きテスト
```

テストは fake のノードに対して gateway 自身の振る舞い（ルーティング、拒否、除外と quorum、エラーコード）を見る。実ノードと本物の署名を通す確認は [`../e2e`](../e2e)。

```bash
# リポジトリルートで
docker build -f projects/gateway/Dockerfile -t idp-gateway .
docker run --rm -v "$(pwd)/secrets:/secrets:ro" \
  -e NODE_URLS=http://node1:4001,http://node2:4002,http://node3:4003 \
  -p 3000:3000 idp-gateway
```

ログインページ（`LOGIN_DIST`が指すディレクトリ）は、このDockerfileが [`../idpFront`](../idpFront) をViteでビルドして `/app/ui` に組み込む。
