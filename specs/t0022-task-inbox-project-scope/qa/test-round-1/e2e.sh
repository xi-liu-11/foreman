#!/bin/bash
# T0022 end-to-end check. Real taskd on port 7787 in a temp FOREMAN_HOME, with
# test/fake-claude.sh as the worker, so blocks and gates come from real pipelines.
# herdr is left off PATH so workers run as background processes. No model is called.
set -u
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
T="$(mktemp -d "${TMPDIR:-/tmp}/fm-t0022-e2e-XXXXXX")"
PORT=7787 TOKEN=testtoken

# A Foreman worker inherits live values: drop them all so nothing reaches the real taskd.
for v in $(env | sed -n 's/^\(FOREMAN_[A-Z_]*\)=.*/\1/p'); do unset "$v"; done
# bun may live beside herdr, so hand the bin shims its path rather than its directory.
export BUN="$(command -v bun)"
export PATH="$ROOT/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export FOREMAN_HOME="$T" FOREMAN_URL="http://127.0.0.1:$PORT" FOREMAN_TOKEN="$TOKEN"
command -v herdr >/dev/null && { echo "herdr still on PATH"; exit 2; }

cat > "$T/config.toml" <<CFG
[server]
port = $PORT
bind = "127.0.0.1"
token = "$TOKEN"
[defaults]
worktrees = "$T/worktrees"
concurrency = 6
[projects.a]
path = "$T/repos/a"
verify = "inspect"
speckit = false
[projects.b]
path = "$T/repos/b"
verify = "inspect"
speckit = false
CFG
for n in a b; do
  r="$T/repos/$n"; mkdir -p "$r"; git -C "$r" init -q -b main; echo hi > "$r/README.md"
  git -C "$r" add -A; git -C "$r" -c user.email=f@x -c user.name=f commit -qm init
  git init -q --bare "$T/repos/$n.git"; git -C "$r" remote add origin "$T/repos/$n.git"; git -C "$r" push -q -u origin main 2>/dev/null
done

# Baseline: the merge base's code, unpacked aside, to compare no-flag output with.
BASE="$T/baseline"; mkdir -p "$BASE"
git -C "$ROOT" archive "$(git -C "$ROOT" merge-base main HEAD)" | tar -x -C "$BASE"

PID=""
start() { # root
  FOREMAN_CLAUDE_BIN="$ROOT/test/fake-claude.sh" FOREMAN_GH_BIN="$ROOT/test/fake-gh.sh" "$1/bin/foreman" taskd >> "$T/taskd.log" 2>&1 & PID=$!
  for _ in $(seq 1 40); do curl -sf -o /dev/null -H "authorization: Bearer $TOKEN" "$FOREMAN_URL/health" && return 0; sleep 0.25; done
  echo "taskd did not start"; cat "$T/taskd.log"; exit 2
}
stop() { kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; PID=""; }
trap 'stop; pkill -f "$T" 2>/dev/null; rm -rf "$T"' EXIT

fails=0
check() { # label, then a command whose exit status decides
  local label="$1"; shift
  if "$@"; then echo "PASS  $label"; else echo "FAIL  $label"; fails=$((fails+1)); fi
}
status() { task show "$1" --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["task"]["status"])'; }
wait_for() { for _ in $(seq 1 90); do [ "$(status "$1")" = "$2" ] && { echo "  $1 -> $2"; return 0; }; sleep 0.5; done; echo "  $1 expected $2, got $(status "$1")"; exit 2; }
api() { curl -s -H "authorization: Bearer $TOKEN" "$FOREMAN_URL$1"; }
# jq-ish: evaluates a python expression over the JSON on stdin (`d`), exit 0 when true.
jt() { python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if eval(sys.argv[1]) else 1)' "$1"; }
show() { echo "\$ $*"; "$@"; echo "[exit $?]"; }

start "$ROOT"
echo "== seed"
echo done > "$T/mode"
task create --project a --kind implement --title "a gated task" --brief x >/dev/null; wait_for T0001 gate
task create --project b --kind implement --title "b gated task" --brief x >/dev/null; wait_for T0002 gate
echo block > "$T/mode"
task create --project a --kind research --title "a blocked task" --brief x >/dev/null; wait_for T0003 blocked
task create --project b --kind research --title "b blocked task" --brief x >/dev/null; wait_for T0004 blocked
task create --project a --kind research --title "a answered task" --brief x >/dev/null; wait_for T0005 blocked
ANSWERED=$(api /blocks | python3 -c 'import json,sys; print(next(b["id"] for b in json.load(sys.stdin) if b["task_id"]=="T0005"))')
task answer "$ANSWERED" "Blue." >/dev/null; wait_for T0005 done
echo slow > "$T/mode"
task create --project a --kind research --title "a running task" --brief x >/dev/null; wait_for T0006 running

echo; echo "== route scenarios"
check "S5 precondition: T0006 in project a is running" test "$(status T0006)" = running
check "S5 GET /tasks?status=gate&project=a is only a's gated task, not its running one" \
  sh -c "curl -s -H 'authorization: Bearer $TOKEN' '$FOREMAN_URL/tasks?status=gate&project=a' | python3 -c 'import json,sys; sys.exit(0 if [t[\"id\"] for t in json.load(sys.stdin)]==[\"T0001\"] else 1)'"
s1() { api "/blocks?project=a" | jt '[b["task_id"] for b in d]==["T0003"] and d[0]["task"]["project"]=="a" and d[0]["task"]["title"]=="a blocked task"'; }
s2() { api "/blocks" | jt 'sorted(b["task_id"] for b in d)==["T0003","T0004"]'; }
s3() { api "/blocks?project=none" | jt 'd==[]'; }
s4() { api "/blocks?project=a" | jt '"T0005" not in [b["task_id"] for b in d]'; }
s6() { api "/tasks?status=gate" | jt 'sorted(t["id"] for t in d)==["T0001","T0002"]'; }
check "S1 GET /blocks?project=a is only a's block, with task embedded" s1
check "S2 GET /blocks returns both blocks" s2
check "S3 GET /blocks?project=none returns []" s3
check "S4 answered block on a is not returned" s4
check "S6 GET /tasks?status=gate returns both gated tasks" s6
wait_for T0006 done

echo; echo "== CLI scenarios"
s7() { task inbox --project a --json | jt '[b["task_id"] for b in d["blocks"]]==["T0003"] and [t["id"] for t in d["gates"]]==["T0001"]'; }
s7b() { task inbox --json --project a | jt '[b["task_id"] for b in d["blocks"]]==["T0003"] and [t["id"] for t in d["gates"]]==["T0001"]'; }
s8() { x=$(task inbox --project a); case "$x" in *"b blocked task"*|*"b gated task"*) return 1;; esac; case "$x" in *"a blocked task"*) ;; *) return 1;; esac; case "$x" in *"a gated task"*) ;; *) return 1;; esac; }
s9t() { x=$(task inbox); for s in "a blocked task" "b blocked task" "a gated task" "b gated task"; do case "$x" in *"$s"*) ;; *) return 1;; esac; done; }
s9j() { task inbox --json | jt 'sorted(b["task_id"] for b in d["blocks"])==["T0003","T0004"] and sorted(t["id"] for t in d["gates"])==["T0001","T0002"]'; }
empty_t() { [ "$(task inbox --project none)" = "inbox empty" ]; }
empty_j() { task inbox --project none --json | jt 'd=={"blocks":[],"gates":[]}'; }
s10() { # An unreachable taskd proves the error comes before any request.
  for form in "--project" "--project|" "--json|--project" "--project|--json"; do
    if [ "$form" = "--project|" ]; then set -- --project ""; else IFS='|' read -r -a parts <<< "$form"; set -- "${parts[@]}"; fi
    e=$(FOREMAN_URL=http://127.0.0.1:1 task inbox "$@" 2>&1 >/dev/null); c=$?
    [ "$c" = 1 ] && [ "$e" = "error: --project requires a name" ] || { echo "  form [$form]: exit $c, stderr: $e"; return 1; }
  done
}
s11() { task --help | grep -q 'task inbox \[--project <name>\]'; }
check "S7 inbox --project a --json has a's block and gate only" s7
check "S7 same with the flags reversed" s7b
check "S8 inbox --project a text names a's items and none of b's" s8
check "S9 inbox text lists both projects" s9t
check "S9 inbox --json lists both projects" s9j
check "S10 --project without a value exits 1 with the error, before any request" s10
check "S11 --help shows --project on the inbox line" s11
check "Behaviour table: unknown project reads as inbox empty, exit 0" empty_t
check "Behaviour table: unknown project --json is empty lists, exit 0" empty_j

echo; echo "== transcript"
show task inbox --project a
show task inbox --project a --json
show task inbox --project b
show task inbox --project none
show task inbox --project none --json
show task inbox --project
show task inbox --project ""
show task inbox
task --help | grep -n 'inbox'

echo; echo "== argument edge probes (outside the numbered scenarios)"
show task inbox --project=a
show task ls --project=a

echo; echo "== no-flag output against the merge base"
mkdir -p "$T/cmp"
capture() { # tag cli-root
  "$2/bin/task" inbox > "$T/cmp/$1.text"; "$2/bin/task" inbox --json > "$T/cmp/$1.json"
  api /blocks > "$T/cmp/$1.blocks"; api "/tasks?status=gate" > "$T/cmp/$1.gates"
  sed -E 's/ [0-9]+[smhd] ago/ <age> ago/' "$T/cmp/$1.text" > "$T/cmp/$1.textn"
}
capture new "$ROOT"
capture basecli "$BASE"
stop; start "$BASE"
capture basefull "$BASE"
stop; start "$ROOT"
same() { cmp -s "$T/cmp/new.$1" "$T/cmp/$2.$1"; }
for k in textn json blocks gates; do
  check "byte-identical to baseline CLI on this daemon: $k" same "$k" basecli
  check "byte-identical to baseline CLI + baseline daemon: $k" same "$k" basefull
done

echo; echo "== id commands still work (new CLI)"
s_show() { task show T0003 --json | jt 'd["task"]["project"]=="a"'; }
check "show T0003" s_show
show task answer "$(api /blocks | python3 -c 'import json,sys; print(next(b["id"] for b in json.load(sys.stdin) if b["task_id"]=="T0004"))')" "Red."
wait_for T0004 done
show task approve T0002
show task cancel T0001
show task retry T0003
for c in "show T9999" "approve T9999" "answer 9999 x" "retry T9999" "cancel T9999"; do
  n=$(task $c 2>&1; echo "exit $?"); b=$("$BASE/bin/task" $c 2>&1; echo "exit $?")
  check "same result as baseline for missing id: $c ($(echo "$n" | tr '\n' ' '))" test "$n" = "$b"
done

echo; echo "== result: $fails failed"
[ "$fails" = 0 ]
