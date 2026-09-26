# Fly.io への配備

5 つのアプリ（`dcidp-node1..3`、`dcidp-gateway`、`dcidp-rp`）を東京（`nrt`）に置く。1 アプリ 1 コンテナで、各自に HTTPS の公開 URL が付く。gateway → ノードは Fly の内部ネットワーク（`http://dcidp-node1.internal:4000`）、ブラウザ → ノードは公開 URL（`PUBLIC_URL`）。

| アプリ | URL | ボリューム |
|---|---|---|
| `dcidp-gateway` | `https://dcidp-gateway.fly.dev`（issuer、ログイン画面） | `/data`（残高） |
| `dcidp-rp` | `https://dcidp-rp.fly.dev` | なし |
| `dcidp-node1..3` | `https://dcidp-node<i>.fly.dev` | `/data`（ユーザー記録、残高） |

鍵ファイルの中身は Fly の Secret（環境変数）で渡す。各サービスは `*_JSON` の環境変数があればパスの代わりにその中身を読む。ウォレットは compose と同じものなので、入金済みなら決済も動く。

## 初回

```bash
fly auth login
for a in dcidp-node1 dcidp-node2 dcidp-node3 dcidp-gateway dcidp-rp; do fly apps create $a; done
for a in dcidp-node1 dcidp-node2 dcidp-node3 dcidp-gateway; do fly volumes create data -a $a -r nrt -s 1 -y; done

# 鍵ファイルの中身は distKey が書いた secrets/ から、そのアプリが読むものだけを渡す
for i in 1 2 3; do fly secrets set NODE_CONFIG_JSON="$(cat secrets/node-$i.json)" GATEWAYS_JSON="$(cat secrets/gateways.json)" -a dcidp-node$i --stage; done
fly secrets set GROUP_JSON="$(cat secrets/group.json)" CLIENTS_JSON="$(cat secrets/clients.json)" GATEWAY_KEY_JSON="$(cat secrets/gateway.json)" -a dcidp-gateway --stage
fly secrets set CLIENT_KEY_JSON="$(cat secrets/client-demo_client.json)" -a dcidp-rp --stage
```

## 配備

ビルドコンテキストはリポジトリルートで、Dockerfile はコマンドラインで指定する（設定ファイル内の `[build]` は設定ファイルのディレクトリ基準になるため使わない）。ノード → gateway → rp の順（gateway は起動時にノードを探し、rp は gateway をディスカバリする）。

```bash
fly deploy . -c deploy/fly/node1.toml --dockerfile projects/node/Dockerfile --remote-only --ha=false
fly deploy . -c deploy/fly/node2.toml --dockerfile projects/node/Dockerfile --remote-only --ha=false
fly deploy . -c deploy/fly/node3.toml --dockerfile projects/node/Dockerfile --remote-only --ha=false
fly deploy . -c deploy/fly/gateway.toml --dockerfile projects/gateway/Dockerfile --remote-only --ha=false
fly deploy . -c deploy/fly/rp.toml --dockerfile projects/rp/Dockerfile --remote-only --ha=false
```

確認は `curl https://dcidp-gateway.fly.dev/health` と、ブラウザで `https://dcidp-rp.fly.dev` の「Sign in」から。ログは `fly logs -a dcidp-gateway`。
