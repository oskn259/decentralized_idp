# protocol

コンポーネント間で合意しなければならないことの全て。ノードの HTTP API のボディ（JSON Schema）、スキーマでは表せない規則（この文書）、そして固定入力に対する期待値（テストベクタ）から成る。コードは含まず、特定の言語にも依存しない。

## 目的と位置づけ

ここが規範であり、[`../sdk`](../sdk)（`@decentralized-idp/sdk`）はその TypeScript による実装の一つである。node・gateway・idpFront・rp・distKey はその sdk を使うサンプル実装である。独立した実装は、このディレクトリだけを読んで書けることを目指す。ただし現時点で独立した実装による検証は行われていない。

対象はノードの HTTP API と、その上で動く暗号計算・トークンの形・時間の規則・鍵ファイルの形。ゲートウェイがブラウザと RP に向けて公開する OAuth のエンドポイントは [`../gateway`](../gateway) の README にあり、この仕様の対象外。

読者は FROST（閾値 Ed25519 署名）、TOPRF（閾値 OPRF）、OAuth 2.0、DPoP の基本を知っているものとする。記号は `s_i` = ノード i の署名鍵シェア、`Y` = グループ公開鍵、`k_i` = ユーザーごとの TOPRF 鍵シェア、`h` = パスワードから導かれるマスター鍵、`h_i` = ノード i がシェアを暗号化する鍵、`‖` = バイト列の連結、`L` = Ed25519 の素数位数部分群の位数。

```
schema/node-api/*.json   ノード HTTP API の各ボディの JSON Schema（draft 2020-12）
vectors/*.json           テストベクタ
scripts/check.mjs        上記が JSON として読め、スキーマが draft 2020-12 を宣言していることの確認（npm run qa-gate）
```

## 符号化の規則

| 対象 | 表現 |
|---|---|
| バイト列（HTTP 上） | base64url（RFC 4648 §5）、パディングなし |
| バイト列（鍵ファイル） | 小文字 hex |
| スカラー（Z_L の元、HTTP 上と鍵ファイル） | 64 桁の小文字 hex、ビッグエンディアン、ゼロ埋め |
| Ed25519 の点 | RFC 8032 の 32 バイト圧縮表現 |
| ristretto255 の点 | RFC 9496 の 32 バイト正準表現 |
| 整数（`nodeId`、`iat`、`exp` など） | JSON の整数 |

base64url のデコーダは、アルファベット外の文字（`=`、`+`、`/` を含む）と、長さが 4 で割って 1 余る文字列（どんなバイト列からも生じない）を拒否する。

スカラーのビッグエンディアン hex は、Ed25519 の署名や下記のハッシュ値の解釈で使うリトルエンディアンのバイト表現とは向きが逆である。ワイヤ上のスカラー（`/sign` 応答の `at`・`rt`）は `^[0-9a-f]{64}$` に一致しなければならず、それ以外は拒否する。

`nodeId` は 1 以上 255 以下の整数。Shamir の評価点であり（0 は秘密そのもの）、FROST のハッシュ入力では 1 バイトで表す。

時刻はすべて UNIX 時間（秒）の整数。

## ノード HTTP API

すべてのボディは JSON。バイト列は base64url、スカラーは 64 桁 hex。

| メソッド | パス | 内容 | リクエスト | レスポンス |
|---|---|---|---|---|
| GET | `/health` | 稼働確認とグループ公開鍵 | なし | [`health.response.json`](schema/node-api/health.response.json) |
| POST | `/commit` | FROST ラウンド 1 を開く | [`commit.request.json`](schema/node-api/commit.request.json) | [`commit.response.json`](schema/node-api/commit.response.json) |
| POST | `/sign-on` | TOPRF 評価と、認証アサーションへの FROST ラウンド 2 | [`sign-on.request.json`](schema/node-api/sign-on.request.json) | [`sign-on.response.json`](schema/node-api/sign-on.response.json) |
| POST | `/sign` | アクセストークンとリフレッシュトークンへの FROST ラウンド 2 | [`sign.request.json`](schema/node-api/sign.request.json) | [`sign.response.json`](schema/node-api/sign.response.json) |

スキーマが表せない制約:

- `groupPublicKey`、`D`、`E`、`blinded`、`toprfPartial` はデコードして 32 バイトでなければならない。`blinded` と `toprfPartial` は ristretto255 の正準表現、その他は Ed25519 の点
- `sessionNonce` は 1 バイト以上のクライアント乱数。sdk のブラウザ実装は 16 バイトを使う
- `/sign-on` の `nonce` は、値がないときはメンバーごと省く。`null` は拒否する（署名対象のペイロードに `nonce` を含めるか否かが変わるため）
- `/sign-on` の `scope` は空文字列でもよい
- `/sign` は `grant` が `authorization_code` なら `assertion`、`refresh_token` なら `refreshToken` が空でない文字列であることを要求し、もう一方は読まない
- `/sign` の `roundId` と `refreshRoundId` は異なるラウンドでなければならない（1 組のナンスで 2 つのメッセージに署名すると `s_i` が漏れる）
- `/sign-on` 応答の `sub` は、ノード自身のユーザーレコードから取る。リクエストには含まれない
- `/sign` 応答の `at`・`rt` は平文の署名シェア `z_i`。`/sign-on` の `z_i` は `ct_i` の中にあり、`h_i` を持つ者しか読めない

200 以外の応答のボディは `{ "error": string }`。

| ステータス | 意味 |
|---|---|
| 400 | ボディが不正（`body.<field> <理由>` の形。例 `body.request.blinded must decode to 32 bytes, got 31`）、または処理の拒否（未知のユーザー、期限切れ、署名不一致、ラウンドが見つからない等） |
| 404 | 未知のパスまたはメソッド |
| 500 | 想定外のエラー |

## JWT の正規化

すべての署名者が同じバイト列を作らないと署名シェアは合算できない。ヘッダとペイロードは以下の決定的 JSON で直列化する。

- オブジェクトのキーは、すべての階層で、UTF-16 コード単位の昇順（キーが ASCII なら バイト順と同じ）に並べる
- 値が「未定義」（メンバーが存在しない状態）のメンバーは出力しない。`null` は `null` として出力する
- 空白を入れない
- 配列は順序を保つ
- 文字列と数値は JSON の標準表現。この仕様で扱う数値はすべて整数

署名入力は `base64url(header) "." base64url(payload)` の ASCII バイト列。JWT はその後ろに `"." base64url(signature)` を付けたもの。`alg` は常に `EdDSA`（純 Ed25519、プリハッシュなし）、`kid` はグループ鍵の識別子（[鍵ファイル](#鍵ファイル)の `keyId`、sdk では `pasta-group-key-1`）。検証者は `alg` が `EdDSA` または `Ed25519`（同じ署名方式の完全指定名。RFC 9053 系の JOSE 登録）であることを確かめ、グループ公開鍵 `Y` で Ed25519 署名を検証する。

## 3種のトークンのレイアウト

グループが署名する JWT は 3 種類で、`typ` だけで区別される。ヘッダはいずれも `{ "alg": "EdDSA", "typ": <typ>, "kid": <keyId> }`。

| トークン | `typ` | ペイロード |
|---|---|---|
| アサーション（= 認可コード） | `JWT` | `iss`, `sub`, `aud` (= `iss`), `client_id`, `scope`, `cnf: { jkt }`, `nonce`（任意。ないときはメンバーごと省く）, `iat`, `exp` |
| アクセストークン | `at+jwt` | `iss`, `sub`, `aud` (= クレデンシャルの `client_id`), `scope`, `cnf: { jkt }`, `iat`, `exp`, `jti` |
| リフレッシュトークン | `refresh+jwt` | `iss`, `sub`, `client_id`, `scope`, `cnf: { jkt }`, `iat`, `exp` |

アサーションの `sub` はノードのユーザーレコード、`client_id`・`scope`・`cnf.jkt`・`nonce`・`iat`・`exp` は `/sign-on` リクエストの `clientId`・`scope`・`cnfJkt`・`nonce`・`iat`・`exp` から取る。`iss` はノードに設定された issuer（ゲートウェイの URL、末尾スラッシュなし）。

アクセストークンとリフレッシュトークンは、`/sign` に提示されたクレデンシャル（アサーションまたはリフレッシュトークン）から `sub`・`client_id`・`scope`・`cnf.jkt` を写す。`iat`・`exp`・`jti` は `/sign` リクエストの `claims`（アクセストークン用）で、リフレッシュトークンの `iat` は同じ `claims.iat`、`exp` は `claims.iat + 2592000`（30 日）。

## FROST

群は Ed25519（基点 `B`、位数 `L`）。グループ秘密鍵 `s` は Shamir で分割され、ノード i は `s_i = f(i)` を持つ。`Y = s·B`。

Shamir: `f(x) = s + c_1·x + … + c_{t-1}·x^{t-1}`（`c_j` は Z_L の一様乱数）、評価点は `nodeId`。参加者集合 `P` に対するラグランジュ係数は

```
λ_i = ∏_{j ∈ P, j ≠ i} j / (j − i)   (mod L)
```

逆元は `a^(L−2) mod L`。

ラウンド 1（`/commit`）: ノード i は `d_i`, `e_i` を Z_L から一様に選び、`D_i = d_i·B`, `E_i = e_i·B` を返す。`(d_i, e_i)` は `roundId` に紐づけて保持する。

ラウンド 2（`/sign-on`、`/sign`）: リクエストの `commitments` は参加者全員の `{ nodeId, D, E }`、`allParticipants` は参加者の `nodeId` の一覧。`msg` は署名対象 JWT の署名入力。

```
ρ_i = SHA-512( byte(i) ‖ msg ‖ ‖_{c ∈ commitments, nodeId 昇順} ( byte(c.nodeId) ‖ c.D ‖ c.E ) )   をリトルエンディアン整数と読み、mod L
R   = Σ_{c ∈ commitments} ( c.D + ρ_{c.nodeId}·c.E )
c   = SHA-512( R ‖ Y ‖ msg )   をリトルエンディアン整数と読み、mod L
z_i = d_i + ρ_i·e_i + λ_i·s_i·c   (mod L)
```

`byte(i)` は `nodeId` の 1 バイト表現、`R`・`Y`・`D`・`E` は 32 バイトの点。集約者（ブラウザまたはゲートウェイ）は同じ `R` を計算し、

```
σ = R ‖ LE32( Σ_i z_i mod L )
```

を署名とする。`σ` は `Y` の下での `msg` に対する標準の Ed25519 署名として検証できる（`c` が Ed25519 の challenge そのものであるため）。

## ラウンドの規則

- ラウンドはゲートウェイが選ぶ `roundId`（文字列。sdk は UUID）で識別する。ノードは `roundId` ごとに `(d_i, e_i)` を 1 組保持する
- ラウンド 1 は全ノードに対して開く。応答しなかったノードは、閾値 `t` 以上のノードが残る限り除外して続行する。残らなければその要求は失敗する
- 1 回の要求で複数のラウンドを同時に開くとき（`/token` はアクセストークン用とリフレッシュトークン用の 2 つ）、いずれか 1 つに失敗したノードはすべてから除外する。参加者集合はすべてのラウンドで同一になる
- `allParticipants` は昇順、`commitments` も `nodeId` 昇順で送る（ρ_i の計算はいずれにせよ `nodeId` でソートする）
- ラウンド 2 は全員一致。`R` とラグランジュ係数がラウンド 1 のコミットメント集合で固定されるため、参加者 1 台でも失敗すればその要求は失敗し、クライアントは最初からやり直す
- ナンスの組は 1 つのメッセージにちょうど 1 回だけ使う。ノードはラウンド 2 で `roundId` のナンスを取り出すと同時に消す。未知または消費済みの `roundId` は拒否する
- `/sign-on` は 1 ラウンド、`/sign` は 2 ラウンド（`roundId` と `refreshRoundId`、異なること）を消費する。ノードはナンスを取り出す前に、クレデンシャル・DPoP・時刻の検証をすべて済ませる

## TOPRF

群は ristretto255（RFC 9496）。ユーザーごとに独立した鍵 `k` を Shamir で分割し、ノード i は `k_i` を持つ。`pw` はパスワードの UTF-8 バイト列、`u64LE(n)` は 8 バイトリトルエンディアン、`u16LE(n)` は 2 バイトリトルエンディアン。

```
H1(pw) = hash_to_ristretto255( SHA-512( "PASTA-TOPRF-H1" ‖ u64LE(len(pw)) ‖ pw ) )
```

`hash_to_ristretto255` は RFC 9496 §4.3.4 の 64 バイト一様入力からの導出（前半 32 バイトと後半 32 バイトをそれぞれ写して加える）。

```
クライアント:  r ← Z_L 一様乱数,  A = r·H1(pw)                         → /sign-on の blinded
ノード i:      B_i = k_i·A                                             → /sign-on 応答の toprfPartial
クライアント:  v = r⁻¹ · Σ_{i ∈ P} λ_i·B_i                            (= k·H1(pw)、P は応答したノードの id、λ_i は上記 Shamir の係数)
               h = SHA-512( "PASTA-TOPRF-H2" ‖ u64LE(len(pw)) ‖ pw ‖ enc(v) )[0..32]
               h_i = SHA-512( "PASTA-TOPRF-H-PRIME" ‖ h ‖ u16LE(i) )[0..32]
```

`enc(v)` は `v` の 32 バイト正準表現。ノードは `k_i` と `h_i`（ディーラーが同じ手順で導出したもの）を保持し、`pw` も `h` も知らない。ノードは `blinded` を ristretto255 の正準表現として復号できなければ拒否する。

## AEAD

`/sign-on` で、ノード i は署名シェア `z_i` を `h_i` で暗号化して返す。

| 項目 | 値 |
|---|---|
| アルゴリズム | ChaCha20-Poly1305（RFC 8439）、タグ 16 バイトを暗号文の末尾に付ける |
| 鍵 | `h_i`（32 バイト） |
| ナンス | `SHA-512( "PASTA-AEAD-NONCE" ‖ sessionNonce ‖ u16LE(i) )[0..12]`。両側が導出し、ワイヤには載せない |
| AAD | アサーションの署名入力（`base64url(header) "." base64url(payload)` の ASCII バイト列） |
| 平文 | `{"z_i":"<z_i の 10 進表現>"}` の UTF-8。空白なし、メンバーはこの 1 つだけ |

クライアントは自分で導いた `h_i` で復号する。パスワードが違えば `h_i` が違い、タグ検証で失敗する。ノードはパスワードの正誤を知らない。

## DPoP

RFC 9449 を Ed25519 で使う。`/sign` に提示されるプルーフはゲートウェイとノードの両方が同じ規則で検証する。

プルーフの JWT:

| 部分 | 内容 |
|---|---|
| ヘッダ | `typ: "dpop+jwt"`, `alg: "EdDSA"`, `jwk: { kty: "OKP", crv: "Ed25519", x: <公開鍵 32 バイトの base64url> }` |
| ペイロード | `jti`（空でない文字列）, `htm`, `htu`, `iat` |

検証は以下をすべて満たすこと。順序は sdk のもので、最初に失敗した項目で拒否する。

1. ヘッダの `jwk` が `kty: OKP`、`crv: Ed25519` で、`x` が 32 バイトにデコードできる
2. `alg` が `EdDSA` または `Ed25519` で、署名入力に対する Ed25519 署名がその `jwk` の鍵で検証できる（一般の OAuth クライアントライブラリは後者の名前を使うことがある）
3. `typ` が `dpop+jwt`
4. `htm` を大文字にしたものが `POST`
5. `htu` が `<issuer>/token` に文字列として一致
6. `|now − iat| ≤ 60`
7. `jwk` の RFC 7638 サムプリントが、提示されたクレデンシャルの `cnf.jkt` に一致
8. `jti` が空でない文字列

サムプリントは `base64url( SHA-256( '{"crv":"Ed25519","kty":"OKP","x":"<x>"}' ) )`（43 文字）。キーはこの順、空白なし。

アサーションの `cnf.jkt` は、RP が `/authorize` の `dpop_jkt` で示したサムプリントを、ブラウザが `/sign-on` の `cnfJkt` としてそのまま渡したもの。アクセストークンとリフレッシュトークンはクレデンシャルの `cnf.jkt` を写す。`jti` によるリプレイ追跡は行わない。

## 時間の規則

`now` はノード自身の時計。

| 対象 | 規則 |
|---|---|
| `/sign-on` リクエストの `iat`・`exp` | `|now − iat| ≤ 60`、`1 ≤ exp − iat ≤ 30` |
| `/sign` に提示されたアサーション | `typ` が `JWT`、`exp ≥ now`、`iss` と `aud` が issuer に一致、`1 ≤ exp − iat ≤ 30` |
| `/sign` に提示されたリフレッシュトークン | `typ` が `refresh+jwt`、`exp ≥ now`、`iss` が issuer に一致、`1 ≤ exp − iat ≤ 2592000` |
| `/sign` リクエストの `claims`（アクセストークン） | `|now − claims.iat| ≤ 60`、`1 ≤ claims.exp − claims.iat ≤ 3600` |
| 発行するリフレッシュトークン | `iat = claims.iat`、`exp = claims.iat + 2592000` |
| DPoP プルーフ | `|now − iat| ≤ 60`（ゲートウェイ、ノードとも） |

sdk のゲートウェイは `claims.iat = now`、`claims.exp = now + 3600` で発行する。ブラウザはアサーションを `iat = now`、`exp = now + 30` で要求する。

## 鍵ファイル

ディーラー（distKey）が書き出し、ゲートウェイとノードが読む。バイト列とスカラーはすべて小文字 hex、スカラーは 64 桁固定でビッグエンディアン。

`group.json`（ゲートウェイが読む）:

```json
{
  "version": 1,
  "threshold": 2,
  "total": 3,
  "keyId": "pasta-group-key-1",
  "groupPublicKey": "<hex 64桁: Y>"
}
```

`node-<id>.json`（ノード `<id>` が読む）:

```json
{
  "version": 1,
  "nodeId": 1,
  "threshold": 2,
  "total": 3,
  "groupPublicKey": "<hex 64桁: Y>",
  "secretKeyShare": "<hex 64桁: s_i>",
  "users": [
    {
      "username": "alice",
      "sub": "usr_alice_12345",
      "toprfKeyShare": { "id": 1, "value": "<hex 64桁: k_i>" },
      "h_i": "<hex 64桁: h_i (32 バイト)>"
    }
  ]
}
```

`toprfKeyShare.id` は自ノードの `nodeId` と一致していなければならず、ノードは一致しないファイルを読み込み時に拒否する。`users` は全ノードで同じユーザー集合（`username`、`sub`）を持つ。`keyId` はすべての JWT ヘッダの `kid` であり、ゲートウェイが JWKS で公開する鍵の識別子。

## テストベクタ

`vectors/*.json`。バイト列は base64url、スカラーは 64 桁 hex。乱数で選ぶ値（`r`、`d_i`、`e_i`、`sessionNonce` など）はすべてファイル内の固定値で与える。

| ファイル | 内容 |
|---|---|
| `base64url.json` | `valid`: バイト列（hex）と base64url の対。`invalid`: デコーダが拒否すべき文字列 |
| `scalar-hex.json` | `valid`: 64 桁 hex と 10 進の対。`invalid`: ワイヤのスカラーとして拒否すべき文字列 |
| `deterministic-json.json` | `cases[]`: JSON 値と、その決定的直列化 |
| `tokens.json` | 固定の issuer・`sub`・リクエスト・クレデンシャル・`claims` に対する 4 つの JWT（`nonce` あり/なしのアサーション、アクセストークン、リフレッシュトークン）。それぞれ `header`・`payload`・正規化 JSON・base64url・署名入力 |
| `shamir.json` | `lagrange[]`: 参加者集合ごとの λ_i。`combine`: 2-of-3 のシェアと復元される秘密 |
| `frost.json` | 2-of-3 のグループ（`groupSecret`、`shares`、`groupPublicKey`）でノード 1 と 3 が `msg`（`tokens.json` のアサーションの署名入力）に署名する 1 回分。署名者ごとに `d`・`e`・`D`・`E`・`λ_i`・`ρ_i`・`z_i`、全体の `R`・`c`・`signature`。`signature` は `groupPublicKey` の下で `msg` の Ed25519 署名として検証できる |
| `toprf.json` | 固定のパスワード・`k`・`k_i`・`r` に対する `H1`・`A`・`B_i`（ノード 1 と 2）・`v`・`h`、およびノード 1〜3 の `h_i` |
| `aead.json` | `toprf.json` のノード 1 の `h_i` を鍵に、`frost.json` のノード 1 の `z_i` を平文として、`tokens.json` のアサーションの署名入力を AAD とした暗号化。`sessionNonce` から導いた `nonce` も含む |
| `dpop.json` | 固定の Ed25519 鍵に対する JWK・サムプリント（`thumbprintJson` はハッシュ入力）と、`/token` 向けのプルーフ 1 つ。`proof.expected` はそれを受理する検証条件 |

sdk はこれらを `projects/sdk/tests/protocol.test.ts` で使う。スキーマとベクタを sdk 自身の関数から生成し直して、コミットされたファイルと完全一致することを確かめ、さらに FROST 署名の検証・TOPRF の unblind と finalize・AEAD の復号・DPoP プルーフの受理をコミットされた値に対して行う。sdk 側の意図した変更でこのテストが落ちたときは、`projects/sdk` で `npm run protocol:generate` を実行して差分を確認し、この README も合わせて改める。
