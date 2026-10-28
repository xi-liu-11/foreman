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
worktrees = "$T/worktrees"
[projects.lite]
path = "$T/repos/lite"
verify = "inspect"
speckit = false
[projects.kit]
path = "$T/repos/kit"
verify = "inspect"
speckit = true
[projects.smoke]
path = "$ROOT"
verify = "inspect"
concurrency = 1
[tickets.linear]
api_key = "lin_api_test"
[projects.direct]
path = "$T/repos/direct"
verify = "inspect"
speckit = false
merge = "direct"
tickets = "linear"
ticket_team = "TST"
ticket_states = { start = "In Progress", review = "In Review", done = "Done" }
[projects.gated]
path = "$T/repos/gated"
verify = "inspect"
speckit = false
merge = "direct"
merge_gate = true
squash = false
CFG
echo done > "$T/mode"
mk_repo() { # name speckit
  r="$T/repos/$1"; mkdir -p "$r"; git -C "$r" init -q -b main; echo hi > "$r/README.md"
  [ "$2" = 1 ] && mkdir -p "$r/.specify/templates" && echo "# Spec template" > "$r/.specify/templates/spec-template.md"
  git -C "$r" add -A; git -C "$r" -c user.email=f@x -c user.name=f commit -qm init
  git init -q --bare "$T/repos/$1.git"; git -C "$r" remote add origin "$T/repos/$1.git"; git -C "$r" push -q -u origin main 2>/dev/null
}
mk_repo lite 0; mk_repo kit 1; mk_repo direct 0; mk_repo gated 0
FAKE_LINEAR_PORT=7779 FAKE_LINEAR_LOG="$T/linear.log" bun "$ROOT/test/fake-linear.ts" >> "$T/linear-server.log" 2>&1 & LPID=$!
start_taskd() { FOREMAN_HOME="$T" FOREMAN_CLAUDE_BIN="$ROOT/test/fake-claude.sh" FOREMAN_GH_BIN="$ROOT/test/fake-gh.sh" FOREMAN_LINEAR_URL=http://127.0.0.1:7779 "$ROOT/bin/foreman" taskd >> "$T/taskd.log" 2>&1 & PID=$!; }
start_taskd
cleanup() {
  kill $PID $LPID 2>/dev/null
  ws=$(herdr workspace list 2>/dev/null | python3 -c 'import json,sys; print(next((w["workspace_id"] for w in json.load(sys.stdin)["result"]["workspaces"] if w["label"]=="fm:smoke"),""))' 2>/dev/null)
  [ -n "$ws" ] && herdr workspace close "$ws" >/dev/null 2>&1
  echo "logs: $T"
}
trap cleanup EXIT
export FOREMAN_URL=http://127.0.0.1:7778 FOREMAN_TOKEN=testtoken
sleep 1.5
status() { "$ROOT/bin/task" show "$1" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["task"]["status"])'; }
wait_for() { i=0; while [ $i -lt 90 ]; do s=$(status "$1"); [ "$s" = "$2" ] && { echo "  $1 -> $s"; return 0; }; i=$((i+1)); sleep 1; done; echo "  $1 expected $2, got $s"; return 1; }
echo "happy path";          "$ROOT/bin/task" create --project smoke --kind research --title Happy --brief x >/dev/null; wait_for T0001 done
echo "block/answer/resume"; echo block > "$T/mode"; "$ROOT/bin/task" create --project smoke --kind research --title Blocky --brief x >/dev/null; wait_for T0002 blocked; "$ROOT/bin/task" answer 1 "Blue." >/dev/null; wait_for T0002 done
echo "crash/retry";         echo fail > "$T/mode";  "$ROOT/bin/task" create --project smoke --kind research --title Faily --brief x >/dev/null; wait_for T0003 done
echo "cancel";              echo block > "$T/mode"; "$ROOT/bin/task" create --project smoke --kind research --title Cancelme --brief x >/dev/null; sleep 1; "$ROOT/bin/task" cancel T0004 >/dev/null; sleep 4; wait_for T0004 cancelled
echo "taskd outage longer than the lease mid-step"; echo slow > "$T/mode"; "$ROOT/bin/task" create --project smoke --kind research --title Outage --brief x >/dev/null; sleep 3
kill $PID; wait $PID 2>/dev/null || true; sleep 8; start_taskd; sleep 1.5; wait_for T0005 done
attempts=$("$ROOT/bin/task" show T0005 --json | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["steps"]))')
[ "$attempts" = "1" ] && echo "  single attempt survived the outage" || { echo "  expected 1 attempt, got $attempts"; exit 1; }
field() { "$ROOT/bin/task" show "$1" --json | python3 -c "import json,sys; t=json.load(sys.stdin)['task']; print(t['$2'])"; }
echo "implement (lite): plan, gate, implement, qa fails once, implement, qa passes, pr, open_pr, gate, merge"; echo done > "$T/mode"
"$ROOT/bin/task" create --project lite --kind implement --title "Add the widget" --brief x >/dev/null
wait_for T0006 gate; "$ROOT/bin/task" approve T0006 >/dev/null; wait_for T0006 gate; "$ROOT/bin/task" approve T0006 >/dev/null; wait_for T0006 done
[ "$(field T0006 qa_cycles)" = 1 ] && echo "  one QA cycle" || { echo "  expected 1 qa cycle"; exit 1; }
[ "$(field T0006 branch)" = "fm/t0006-add-widget" ] && echo "  branch fm/t0006-add-widget" || { echo "  unexpected branch $(field T0006 branch)"; exit 1; }
[ "$(field T0006 pr_url)" = "https://example.invalid/pr/1" ] && echo "  pr url recorded" || { echo "  no pr url"; exit 1; }
[ ! -d "$(field T0006 worktree)" ] && echo "  worktree removed after merge" || { echo "  worktree still present"; exit 1; }
git -C "$T/repos/lite" fetch -q origin && git -C "$T/repos/lite" show origin/main:work.log | grep -q "step implement ran" && echo "  merged work reached origin/main" || { echo "  merge missing on origin"; exit 1; }
echo "implement (speckit): numbered branch and feature dir from template"
"$ROOT/bin/task" create --project kit --kind implement --title "Add the gadget" --brief x >/dev/null
[ "$(field T0007 branch)" = "001-add-gadget" ] && echo "  branch 001-add-gadget" || { echo "  unexpected branch $(field T0007 branch)"; exit 1; }
grep -q "Spec template" "$(field T0007 worktree)/specs/001-add-gadget/spec.md" && echo "  spec.md seeded from template" || { echo "  spec.md not from template"; exit 1; }
wait_for T0007 gate; "$ROOT/bin/task" approve T0007 >/dev/null; wait_for T0007 gate; "$ROOT/bin/task" approve T0007 >/dev/null; wait_for T0007 done
echo "implement (direct merge) from a Linear ticket: title/brief from ticket, worker ticket commands, squash onto main and push, ticket transitions"
"$ROOT/bin/task" create --project direct --kind implement --ticket TST-1 >/dev/null
[ "$(field T0008 title)" = "Ticketed widget" ] && echo "  title taken from ticket" || { echo "  title not from ticket: $(field T0008 title)"; exit 1; }
"$ROOT/bin/task" show T0008 | grep -q "Build the widget" && echo "  brief taken from ticket" || { echo "  brief not from ticket"; exit 1; }
FOREMAN_TASK=T0008 FOREMAN_STEP=1 "$ROOT/bin/task" ticket comment "Found a thing" >/dev/null
FOREMAN_TASK=T0008 FOREMAN_STEP=1 "$ROOT/bin/task" ticket create --title "Follow-up bug" --parent TST-1 | grep -q "created TST-2" && echo "  worker created a child ticket" || { echo "  ticket create failed"; exit 1; }
"$ROOT/bin/task" ticket show TST-1 --project direct | grep -q "In Progress" && echo "  ticket moved to In Progress on start" || { echo "  no start transition"; exit 1; }
wait_for T0008 gate; "$ROOT/bin/task" approve T0008 >/dev/null; wait_for T0008 done
git -C "$T/repos/direct" fetch -q origin && git -C "$T/repos/direct" show origin/main:work.log | grep -q "step implement ran" && echo "  squashed work reached origin/main" || { echo "  direct merge missing on origin"; exit 1; }
[ "$(git -C "$T/repos/direct" rev-list --count origin/main)" = 2 ] && echo "  exactly one squash commit on main" || { echo "  unexpected commit count $(git -C "$T/repos/direct" rev-list --count origin/main)"; exit 1; }
git -C "$T/repos/direct" log -1 --format=%B origin/main | grep -q "Foreman T0008 (TST-1)" && echo "  commit message cites task and ticket" || { echo "  commit message wrong"; exit 1; }
[ "$(git -C "$T/repos/direct" rev-parse main)" = "$(git -C "$T/repos/direct" rev-parse origin/main)" ] && echo "  main checkout fast-forwarded" || { echo "  main checkout not updated"; exit 1; }
[ ! -d "$(field T0008 worktree)" ] && echo "  worktree removed" || { echo "  worktree still present"; exit 1; }
git -C "$T/repos/direct" branch --list "fm/*" | grep -q . && { echo "  feature branch not deleted"; exit 1; } || echo "  feature branch deleted"
grep -q "transition TST-1: In Review" "$T/linear.log" && grep -q "transition TST-1: Done" "$T/linear.log" && grep -q "comment TST-1: Found a thing" "$T/linear.log" && grep -q "create TST-2: Follow-up bug (parent TST-1)" "$T/linear.log" && grep -q "Ready to verify" "$T/linear.log" && echo "  linear log: start, comment, create, handoff review, done" || { echo "  linear log incomplete:"; cat "$T/linear.log"; exit 1; }
echo "implement (direct, gated, no-ff): handoff, merge gate, merge --no-ff"
"$ROOT/bin/task" create --project gated --kind implement --title "Gated thing" --brief x >/dev/null
wait_for T0009 gate; "$ROOT/bin/task" approve T0009 >/dev/null; wait_for T0009 gate
[ "$(field T0009 current_step)" = merge_approved ] && echo "  waiting at merge gate" || { echo "  unexpected gate $(field T0009 current_step)"; exit 1; }
"$ROOT/bin/task" approve T0009 >/dev/null; wait_for T0009 done
git -C "$T/repos/gated" fetch -q origin
[ "$(git -C "$T/repos/gated" rev-list --merges --count origin/main)" = 1 ] && echo "  one merge commit on main (no-ff)" || { echo "  expected a merge commit"; exit 1; }
git -C "$T/repos/gated" log -1 --format=%B origin/main | grep -q "The widget now exists" && echo "  merge message from handoff.md" || { echo "  merge message wrong"; exit 1; }
"$ROOT/bin/task" ls --all
echo "smoke test passed"
