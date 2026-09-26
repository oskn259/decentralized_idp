# e2e

`docker compose` で上げた本物のコンテナ群を、ホストの Chromium から一人のユーザーとして操作する。テストはプロジェクトのコードを一切 import しない。頼るのは公開ポート（gateway `:3000`、rp `:3001`）と画面の文言だけ。

操作は 1 本。rp の「Sign in」→ ログイン画面で入力 →「Sign on」→「Return to the relying party」→ クレーム表示 →「Refresh」。ケースごとに変えるのは入力とノードの生死だけで、ノードは `docker compose stop` で落とす。

| ケース | 見るもの |
|---|---|
| alice が正しいパスワード | クレームに `sub` と `scope`、Refresh 後も同じ `sub`、callback の URL を再度開くと 400、画面のトレースにパスワードが出ない |
| 誤ったパスワード | ログイン画面にエラー。rp には何も届かない |
| 未知のユーザー | ログイン画面にエラー |
| node3 停止 | 2 台でサインインできる |
| node2 も停止 | `quorum 1 < 2` で拒否 |

DPoP 鍵の不一致やアサーションの改竄は画面からは作れないので、ここでは扱わない。

## 使い方

Docker が動いていること。テストが `docker compose up --build --wait` を自分で実行し（初回はビルドに数分）、終わりに止めたノードを戻す。スタックは上げたままにする。

```bash
npm ci --prefix ../..
npm run browser:install                # Chromium を一度だけ入れる
npm test
npm run qa-gate
```

`GW` と `RP` で URL を変えられる（compose の issuer は `http://localhost:3000` なので、通常は変えない）。

- `tests/helpers/compose.ts`: `docker compose` の up・stop・復旧
- `tests/browser.test.ts`: 上の表
