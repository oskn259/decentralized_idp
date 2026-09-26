# e2e

`docker compose` で上げた本物のコンテナ群を、ホストの Chromium から一人のユーザーとして操作する。テストはプロジェクトのコードを一切 import しない。頼るのは公開ポート（gateway `:3000`、rp `:3001`）と画面の文言だけ。

操作は 1 本。rp の「Sign in」→ ログイン画面で入力（初回は「Create account」にチェック）→「Sign on」→「Return to the relying party」→ クレーム表示 →「Refresh」。ケースごとに変えるのは入力とノードの生死だけで、ノードは `docker compose stop` で落とす。ユーザーは実行のたびに新しい名前で登録する。何も事前登録されていない。

| ケース | 見るもの |
|---|---|
| 新規登録してサインイン | クレームに gateway が採番した `sub` と `scope`、Refresh 後も同じ `sub`、callback の URL を再度開くと 400、画面のトレースにもコンテナのログにもパスワードが出ない |
| 登録せずに再サインイン | 同じ `sub` |
| 使用済みの username で登録 | ログイン画面に `is taken` |
| 誤ったパスワード | ログイン画面にエラー。rp には何も届かない |
| 未知のユーザー | ログイン画面にエラー |
| node3 停止 | 2 台でサインインできるが、登録は 3 台全部が要るので `unreachable` で拒否 |
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

鍵ファイルの形式が違うブランチから来たときは、ノードが古い `secrets/` で起動に失敗する。`docker compose down -v && rm -rf secrets` で作り直す。

- `tests/helpers/compose.ts`: `docker compose` の up・stop・復旧
- `tests/browser.test.ts`: 上の表
