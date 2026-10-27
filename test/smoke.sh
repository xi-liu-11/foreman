#!/bin/sh
# End-to-end smoke test with a stub in place of `claude`. No model is called.
# Starts an isolated taskd on port 7778 with its own FOREMAN_HOME, drives the
# happy, blocked/answer/resume, crash/retry, and cancel paths, then cleans up.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T="${TMPDIR:-/tmp}/foreman-smoke-$$"; mkdir -p "$T"
cat > "$T/config.toml" <<CFG
[server]
port = 7778
bind = "127.0.0.1"
token = "testtoken"
[defaults]
lease_sec = 5
heartbeat_sec = 2
[projects.smoke]
path = "$ROOT"
verify = "inspect"
concurrency = 1
CFG
echo done > "$T/mode"
start_taskd() { FOREMAN_HOME="$T" FOREMAN_CLAUDE_BIN="$ROOT/test/fake-claude.sh" "$ROOT/bin/foreman" taskd >> "$T/taskd.log" 2>&1 & PID=$!; }
start_taskd
cleanup() {
  kill $PID 2>/dev/null
  ws=$(herdr workspace list 2>/dev/null | python3 -c 'import json,sys; print(next((w["workspace_id"] for w in json.load(sys.stdin)["result"]["workspaces"] if w["label"]=="fm:smoke"),""))' 2>/dev/null)
  [ -n "$ws" ] && herdr workspace close "$ws" >/dev/null 2>&1
  echo "logs: $T"
}
trap cleanup EXIT
export FOREMAN_URL=http://127.0.0.1:7778 FOREMAN_TOKEN=testtoken
sleep 1.5
status() { "$ROOT/bin/task" show "$1" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["task"]["status"])'; }
wait_for() { i=0; while [ $i -lt 40 ]; do s=$(status "$1"); [ "$s" = "$2" ] && { echo "  $1 -> $s"; return 0; }; i=$((i+1)); sleep 1; done; echo "  $1 expected $2, got $s"; return 1; }
echo "happy path";          "$ROOT/bin/task" create --project smoke --kind research --title Happy --brief x >/dev/null; wait_for T0001 done
echo "block/answer/resume"; echo block > "$T/mode"; "$ROOT/bin/task" create --project smoke --kind research --title Blocky --brief x >/dev/null; wait_for T0002 blocked; "$ROOT/bin/task" answer 1 "Blue." >/dev/null; wait_for T0002 done
echo "crash/retry";         echo fail > "$T/mode";  "$ROOT/bin/task" create --project smoke --kind research --title Faily --brief x >/dev/null; wait_for T0003 done
echo "cancel";              echo block > "$T/mode"; "$ROOT/bin/task" create --project smoke --kind research --title Cancelme --brief x >/dev/null; sleep 1; "$ROOT/bin/task" cancel T0004 >/dev/null; sleep 4; wait_for T0004 cancelled
echo "taskd outage longer than the lease mid-step"; echo slow > "$T/mode"; "$ROOT/bin/task" create --project smoke --kind research --title Outage --brief x >/dev/null; sleep 3
kill $PID; wait $PID 2>/dev/null || true; sleep 8; start_taskd; sleep 1.5; wait_for T0005 done
attempts=$("$ROOT/bin/task" show T0005 --json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["steps"]))')
[ "$attempts" = "1" ] && echo "  single attempt survived the outage" || { echo "  expected 1 attempt, got $attempts"; exit 1; }
"$ROOT/bin/task" ls --all
echo "smoke test passed"
