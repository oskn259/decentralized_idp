#!/usr/bin/env bash
# Shows every component's log side by side, so the audience can compare what each one
# knows: three nodes, the gateway, the relying party, and a shell with the browser CLI.
#
#   docker compose up --build --wait && scripts/demo-tmux.sh
set -euo pipefail
cd "$(dirname "$0")/.."

command -v tmux >/dev/null || { echo "tmux is required: brew install tmux" >&2; exit 1; }
docker compose ps --status running --services 2>/dev/null | grep -q gateway || { echo "start the stack first: docker compose up --build --wait" >&2; exit 1; }

session=idp-demo
tmux kill-session -t "$session" 2>/dev/null || true
tmux new-session -d -s "$session" -n logs "docker compose logs -f --no-log-prefix node1"
for service in node2 node3 gateway rp; do
  tmux split-window -t "$session:logs" "docker compose logs -f --no-log-prefix $service"
  tmux select-layout -t "$session:logs" tiled
done
tmux split-window -t "$session:logs"
tmux select-layout -t "$session:logs" tiled
tmux send-keys -t "$session:logs" \
  "npx tsx projects/idpFront/cli.ts --gateway http://localhost:3000 --user alice --password password123 --refresh" ""

tmux set-option -t "$session" pane-border-status top
i=0
for title in node1 node2 node3 gateway rp browser; do
  tmux select-pane -t "$session:logs.$i" -T "$title"
  i=$((i + 1))
done
tmux attach -t "$session"
