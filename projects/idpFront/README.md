# idpFront

ゲートウェイが `/login` で配信するログインページ。パスワードはブラウザの中で認証アサーション（＝OAuth認可コード）に変わり、外には出ない。

読者はFROST（閾値Ed25519署名）とTOPRF（閾値OPRF）の基本を知っているものとする。

## ファイル

FROST・TOPRF・AEAD・JWT署名入力・DPoPの計算は [`../sdk`](../sdk)（`@decentralized-idp/sdk`、[`../protocol`](../protocol) の仕様の TypeScript 実装）にあり、ここでは使うだけ。

- `src/client/sign-on.ts`: PASTAのブラウザ側半分。パスワードがこの関数の外に出ることはない。
  1. Blind: `A = r·H1(pw)`。載るのは`A`のみ。
  2. 各ノードが `B_i = k_i·A` と、`h_i`で暗号化したFROSTシェアを返す。
  3. unblind・finalizeで`h`を求め、各`h_i`を導いてシェアを復号する。パスワードが違うとここでAEADタグが破れて失敗する。ノード側は正誤を知らない。
  4. シェアを合算して群署名にし、JWTを組み立てる。
- `src/App.tsx`: ページ本体。URLから`c`（チャレンジ）、`redirect_uri`、`dpop_jkt`、`client_id`、`scope`、`state`を読み、クライアントIDとスコープ、デモトレース、認証結果を表示する。サインオンが済むと `redirect_uri?code=<assertion>&state=<state>` に遷移してリライングパーティへ戻る。

## 流れ

1. `/authorize` がこのページへリダイレクトする（`c`、`redirect_uri`、`dpop_jkt`などをクエリに乗せて）。
2. ページがユーザー名とパスワードを受け取る。
3. `POST /api/pasta/sign-on` で各ノードに問い合わせる。
4. 返ってきたシェアを復号・合算してアサーションを組み立てる。
5. `redirect_uri` にアサーションを`code`として付けて戻す。

デモトレースのbrowser列（`sign-on.ts`の`log(...)`より、値は8文字のプレースホルダ）。

```
[browser] sign-on   user=alice nonce=8f3a2b1c  → r 4f2a91cd  A=r·H1(pw) 9b31aa02  jkt(rp) 1a2b3c4d  nonce_s c1d2e3f4
[browser]           ← B_i×3 ct_i×3 (D,E)×3
[browser]           → h=finalize(pw, unblind(r,B_i))  h_i×3  z_i=dec(ct_i)×3 6d5c4b3a 7f8e9d0c 5e6f7a8b  R 2b3c4d5e  σ=Σz_i  assertion 3a4b5c6d ✔ assembled only here
```

## 実行

```bash
npm ci --prefix ../..
npm run build      # Vite。dist/ をゲートウェイが LOGIN_DIST として配信する
npm run dev        # :5173 のVite dev server。/api を :3000 のゲートウェイへプロキシ
```

## 開発

```bash
npm run typecheck
npm run qa-gate    # typecheck + build
```

テストは持たない。ログイン画面は本物のブラウザから、compose のコンテナ群に対して [`../e2e`](../e2e) が通す。

このページは `projects/gateway/Dockerfile` によってビルドされ、ゲートウェイのイメージに組み込まれる。
