# sdk

[`../protocol`](../protocol) が定めるプロトコルの TypeScript 実装。node・gateway・idpFront・rp・distKey のサンプルコンポーネントが共通に使う。ここにあるものは規範ではなく、規範は protocol にある。

使う側は `@decentralized-idp/sdk/<module>` を import する。

| モジュール | 内容 |
|---|---|
| `scalar` | Ed25519 の位数 L 上のスカラー演算、乱数、リトルエンディアン変換 |
| `shamir` | Shamir 分散: `splitSecret`（配布側）、`lagrangeCoefficient`・`combineShares`（復元側） |
| `frost` | FROST 閾値署名: ラウンド1（`generateNonces`）、ラウンド2（`computeSignatureShare`）、集約（`computeGroupCommitment`・`aggregateSignatureShares`）、検証 |
| `toprf` | PASTA の閾値OPRF: `blind`→`evaluate`→`unblind`→`finalize` と、ノード鍵 `deriveServerKey` |
| `aead` | ChaCha20-Poly1305 とセッションナンスからの AEAD ナンス導出 |
| `register` | 登録: ブラウザが TOPRF 鍵を引いて分割し、ノードごとの `k_i` と `h_i` を作る `createUserShares` |
| `jwt` | 決定的 JSON 直列化、署名入力、JWT のデコードと EdDSA 検証 |
| `tokens` | アサーション・アクセストークン・リフレッシュトークンのヘッダとペイロードの組み立て、クレデンシャルからの identity 読み出し |
| `dpop` | RFC 9449: 鍵生成、RFC 7638 サムプリント、プルーフの生成と検証 |
| `node-api` | ノード HTTP API のリクエスト・レスポンスの codec（Zod）。`schema.parse` がワイヤ→ドメイン（base64url→bytes、hex→bigint）、`z.encode(schema, value)` がその逆 |
| `hex`, `base64url`, `bytes` | ファイル・ワイヤの符号化（スカラーは 64 桁 hex ビッグエンディアン、バイト列は base64url） |

## protocol との同期

`tests/protocol.test.ts` が、`node-api` から JSON Schema を、この sdk の関数から固定入力のテストベクタを生成し直し、`../protocol` にコミットされたファイルと完全一致することを確かめる。加えて、コミットされたベクタを sdk が受理すること（FROST 署名の検証、TOPRF の unblind、AEAD の復号、DPoP プルーフの受理）を確かめる。

意図した変更でこのテストが落ちたら、生成し直して差分を確認する。

```bash
npm run protocol:generate   # scripts/generate-protocol.ts が ../protocol/schema と ../protocol/vectors を書き直す
```

## 開発

```bash
npm run build      # 使う側は dist/ を読むので、変更後はビルドする
npm run typecheck
npm test
npm run qa-gate    # typecheck + build + テスト
```
