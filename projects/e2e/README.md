# e2e

本物のブラウザで、rp の「Sign in」からリフレッシュまでを通す。node 3 台・gateway（ビルド済みのログイン画面を配信）・rp をこのプロセス内で実 HTTP サーバーとして起動し、Chromium で操作する。docker は使わない。

操作は 1 本だけ。「Sign in」→ ログイン画面で入力 →「Sign on」→「Return to the relying party」→ クレーム表示 →「Refresh」。ケースごとに変えるのは入力とノードの生死だけ。

| ケース | 見るもの |
|---|---|
| alice が正しいパスワード | クレームに `sub` と `scope`、Refresh 後も同じ `sub`、callback の URL を再度開くと 400、画面のトレースにパスワードが出ない |
| 誤ったパスワード | ログイン画面にエラー。rp には何も届かない |
| 未知のユーザー | ログイン画面にエラー |
| ノード 1 台停止 | 2 台でサインインできる |
| ノード 2 台停止 | `quorum 1 < 2` で拒否 |

DPoP 鍵の不一致やアサーションの改竄は画面からは作れないので、ここでは扱わない。

## 使い方

```bash
npm ci --prefix ../..
npm run browser:install                # Chromium を一度だけ入れる
npm test                               # ログイン画面をビルドしてから実行
npm run qa-gate
```

- `tests/helpers/stack.ts`: node・gateway・rp の起動と停止。鍵は `../node/tests/fixtures` のもの
- `tests/browser.test.ts`: 上の表
