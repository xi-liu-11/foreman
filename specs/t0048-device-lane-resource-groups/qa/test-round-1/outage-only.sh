#!/bin/sh
# QA repro (T0048 test round 1): only smoke.sh's "taskd outage longer than the
# lease mid-step" flow. Usage: outage-only.sh <foreman-root> [lane]
# Prints: attempts=<n> runner_start_s=<seconds from launch to run dir, or none>
ROOT="$1"; T="${TMPDIR:-/tmp}/foreman-outage-$$"; mkdir -p "$T"
LANE=""; [ "$2" = lane ] && LANE='resources = ["dev-a", "dev-b"]
resource_groups = { lane = { members = ["dev-a", "dev-b"], capacity = 1 } }'
cat > "$T/config.toml" <<CFG
[server]
port = 7780
bind = "127.0.0.1"
token = "testtoken"
[defaults]
lease_sec = 5
heartbeat_sec = 2
worktrees = "$T/worktrees"
[projects.smoke]
path = "$ROOT"
verify = "inspect"
concurrency = 1
$LANE
CFG
echo slow > "$T/mode"
start() { FOREMAN_HOME="$T" FOREMAN_CLAUDE_BIN="$ROOT/test/fake-claude.sh" "$ROOT/bin/foreman" taskd >> "$T/taskd.log" 2>&1 & PID=$!; }
start; trap 'kill $PID 2>/dev/null' EXIT
export FOREMAN_URL=http://127.0.0.1:7780 FOREMAN_TOKEN=testtoken
sleep 1.5
"$ROOT/bin/task" create --project smoke --kind research --title Outage --brief x >/dev/null; sleep 3
kill $PID; wait $PID 2>/dev/null; sleep 8; start; sleep 1.5
i=0; while [ $i -lt 60 ]; do s=$("$ROOT/bin/task" show T0001 --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["task"]["status"])'); [ "$s" = done ] && break; i=$((i+1)); sleep 1; done
n=$("$ROOT/bin/task" show T0001 --json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["steps"]))')
st=$(grep -m1 "started T0001/research#1" "$T/taskd.log" | cut -c1-8); w=$(stat -f "%Sm" -t "%H:%M:%S" "$T/runs/T0001/research-1/system.md" 2>/dev/null)
echo "attempts=$n started=$st runner_wrote=${w:-none} status=$s"
ws=$(herdr workspace list 2>/dev/null | python3 -c 'import json,sys; print(next((w["workspace_id"] for w in json.load(sys.stdin)["result"]["workspaces"] if w["label"]=="fm:smoke"),""))' 2>/dev/null)
[ -n "$ws" ] && herdr workspace close "$ws" >/dev/null 2>&1
