#!/bin/bash
# End-to-end run of the T0023 scenarios against a real, isolated taskd and the real
# CLI (bin/task), with test/fake-claude.sh as the worker and test/fake-linear.ts as
# Linear. herdr is shimmed to fail, so workers run as background processes and the
# user's herdr is never touched. Own FOREMAN_HOME, ports 7788/7789. No model is called.
# Usage: bash specs/t0023-superseded-status-task-close/qa/test-round-1/e2e.sh
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
QA="$(cd "$(dirname "$0")" && pwd)"
# realpath: on macOS $TMPDIR is under the /var symlink, and Foreman compares its computed
# worktree path with the /private/var path git reports. test/superseded.test.ts does the same.
T="$(python3 -c 'import os,sys,tempfile; print(os.path.realpath(tempfile.mkdtemp(prefix="fm-t0023-e2e-")))')"
unset FOREMAN_TASK FOREMAN_STEP FOREMAN_STEP_NAME FOREMAN_RUN_DIR FOREMAN_CLI_NAME
export FOREMAN_HOME="$T" FOREMAN_URL=http://127.0.0.1:7788 FOREMAN_TOKEN=testtoken CLAUDE_CONFIG_DIR="$T/claude"
export FOREMAN_CLAUDE_BIN="$ROOT/test/fake-claude.sh" FOREMAN_GH_BIN="$ROOT/test/fake-gh.sh" FOREMAN_LINEAR_URL=http://127.0.0.1:7789
mkdir -p "$T/shim" "$T/claude" "$T/repos/plain" "$T/main"
printf '#!/bin/sh\nexit 1\n' > "$T/shim/herdr"; chmod +x "$T/shim/herdr"
export PATH="$T/shim:$ROOT/bin:$PATH"
cat > "$T/config.toml" <<CFG
[server]
port = 7788
bind = "127.0.0.1"
token = "testtoken"
[defaults]
lease_sec = 5
heartbeat_sec = 2
concurrency = 20
worktrees = "$T/worktrees"
[tickets.linear]
api_key = "lin_api_test"
[projects.plain]
path = "$T/repos/plain"
verify = "inspect"
speckit = false
concurrency = 20
[projects.clean]
path = "$T/repos/plain"
verify = "inspect"
speckit = false
concurrency = 20
[projects.repo]
path = "$T/repos/repo"
verify = "inspect"
speckit = false
merge = "direct"
concurrency = 20
[projects.tk]
path = "$T/repos/plain"
verify = "inspect"
speckit = false
concurrency = 20
tickets = "linear"
ticket_team = "TST"
ticket_states = { start = "In Progress", review = "In Review", done = "Done" }
CFG
for r in plain repo; do git -C "$T/repos/$r" init -q -b main 2>/dev/null || { mkdir -p "$T/repos/$r"; git -C "$T/repos/$r" init -q -b main; }; echo hi > "$T/repos/$r/README.md"; git -C "$T/repos/$r" add -A; git -C "$T/repos/$r" -c user.email=f@x -c user.name=f commit -qm init; done
git -C "$ROOT" archive main | tar -x -C "$T/main"

PASS=0; FAIL=0
ok() { # name, then a command that must succeed
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then echo "PASS  $name"; PASS=$((PASS+1)); else echo "FAIL  $name   [$*]"; FAIL=$((FAIL+1)); fi
}
eq() { [ "$1" = "$2" ]; }
ne() { [ "$1" != "$2" ]; }
has() { case "$1" in *"$2"*) return 0;; *) return 1;; esac; }
hasnt() { case "$1" in *"$2"*) return 1;; *) return 0;; esac; }
say() { echo; echo "=== $*"; }
run() { echo "\$ task $*"; task "$@" 2>&1; echo "[exit $?]"; }
J() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))" "$1"; }
field() { task show "$1" --json | J "d['task']['$2']"; }
nsteps() { task show "$1" --json | J "len(d['steps'])"; }
stepf() { task show "$1" --json | J "d['steps'][-1]['$2'] if d['steps'] else None"; }
evcount() { task show "$1" --json | J "len([e for e in d['events'] if e['type']=='$2'])"; }
evtext() { task show "$1" --json | J "[json.loads(e['data']).get('message') for e in d['events'] if e['type']=='$2']"; }
new() { task create "$@" --json | J "d['id']"; }
sql() { python3 -c "import sqlite3,sys; c=sqlite3.connect(sys.argv[1],timeout=5); r=c.execute(sys.argv[2]).fetchall(); c.commit(); print(r)" "$T/foreman.db" "$1"; }
wait_status() { local i=0; while [ $i -lt 60 ]; do [ "$(field "$1" status)" = "$2" ] && return 0; i=$((i+1)); sleep 0.5; done; echo "  timeout: $1 is $(field "$1" status), wanted $2"; return 1; }
wait_step() { local i=0; while [ $i -lt 60 ]; do [ "$(stepf "$1" status)" = "$2" ] && return 0; i=$((i+1)); sleep 0.5; done; echo "  timeout: $1 step is $(stepf "$1" status), wanted $2"; return 1; }
api() { curl -s -X POST -H "authorization: Bearer testtoken" -H "content-type: application/json" -d "$2" "$FOREMAN_URL$1"; }
start_taskd() { "$1/bin/foreman" taskd >> "$T/taskd.log" 2>&1 & PID=$!; for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do curl -s -o /dev/null "$FOREMAN_URL/" && return 0; sleep 0.25; done; echo "taskd did not start"; }
stop_taskd() { kill $PID 2>/dev/null; wait $PID 2>/dev/null; }
cleanup() { kill $PID $LPID 2>/dev/null; echo; echo "home: $T"; }
trap cleanup EXIT

FAKE_LINEAR_PORT=7789 FAKE_LINEAR_LOG="$T/linear.log" bun "$ROOT/test/fake-linear.ts" >> "$T/linear-server.log" 2>&1 & LPID=$!
touch "$T/linear.log"

say "Upgrade path: tasks made by main's taskd, then restart on this branch (the handoff's order)"
echo block > "$T/mode"
start_taskd "$T/main"
OLD=$(new --project plain --kind research --title "old failed task" --brief x)
SUCC=$(new --project plain --kind research --title "successor task" --brief x)
wait_status "$OLD" blocked; wait_status "$SUCC" blocked
ok "main's schema has no superseded_by" eq "$(sql "SELECT count(*) FROM pragma_table_info('tasks') WHERE name='superseded_by'")" "[(0,)]"
stop_taskd
sql "UPDATE tasks SET status='failed' WHERE id='$OLD'" >/dev/null
sql "UPDATE blocks SET answer='x' WHERE task_id='$OLD'" >/dev/null
start_taskd "$ROOT"
ok "restart adds superseded_by" eq "$(sql "SELECT count(*) FROM pragma_table_info('tasks') WHERE name='superseded_by'")" "[(1,)]"
ok "existing rows keep their status" eq "$(field "$OLD" status)" failed
run close "$OLD" --superseded-by "$SUCC"
ok "S1 failed closes: status" eq "$(field "$OLD" status)" superseded
ok "S1 failed closes: pointer" eq "$(field "$OLD" superseded_by)" "$SUCC"
ok "S1 one event on old" eq "$(evtext "$OLD" task.superseded)" "['superseded by $SUCC']"
ok "S1 one event on successor" eq "$(evtext "$SUCC" task.continues)" "['continues $OLD']"

say "S1 cancelled, S2 + S6 blocked with a real worker question"
CANC=$(new --project plain --kind research --title "to cancel" --brief x); wait_status "$CANC" blocked
task cancel "$CANC"; run close "$CANC" --superseded-by "$SUCC"
ok "S1 cancelled closes" eq "$(field "$CANC" status)" superseded
BLK=$(new --project plain --kind research --title "blocked with question" --brief x); wait_status "$BLK" blocked
N=$(nsteps "$BLK"); ok "open question before close" eq "$(task show "$BLK" --json | J "len(d['blocks'])")" 1
Q=$(sql "SELECT id FROM blocks WHERE task_id='$BLK'" | tr -dc 0-9)
run close "$BLK" --superseded-by "$SUCC"
ok "S1 blocked closes" eq "$(field "$BLK" status)" superseded
ok "S2 question answered" eq "$(sql "SELECT answer FROM blocks WHERE task_id='$BLK'")" "[('(task superseded)',)]"
ok "S18 blocked task not in inbox" hasnt "$(task inbox)" "$BLK"
sleep 5
ok "S6 no new step after real ticks" eq "$(nsteps "$BLK")" "$N"
ok "S6 still superseded" eq "$(field "$BLK" status)" superseded

say "S3 + S4 running step: lease released, heartbeat cancels, real runner killed, task stays superseded"
echo slow > "$T/mode"
RUN=$(new --project plain --kind research --title "running worker" --brief x); wait_step "$RUN" running
SID=$(stepf "$RUN" id)
echo "lease: $(api /steps/$SID/lease '{"resource":"sim"}')"
ok "S7 a running task is refused" ne "$(task close "$RUN" --superseded-by "$SUCC" >/dev/null 2>&1; echo $?)" 0
ok "S7 running task unchanged" eq "$(field "$RUN" status)" running
sql "UPDATE tasks SET status='blocked' WHERE id='$RUN'" >/dev/null   # parallel QA: one child blocked while its sibling still runs
run close "$RUN" --superseded-by "$SUCC"
ok "S3 lease released" eq "$(task show "$RUN" --json | J "len(d['leases'])")" 0
HB=$(api /steps/$SID/heartbeat '{}'); echo "heartbeat: $HB"
ok "S3 heartbeat says cancel" has "$HB" '"cancel":true'
wait_step "$RUN" failed
echo "step error: $(stepf "$RUN" error)"
ok "S4 runner's result fails the step" eq "$(stepf "$RUN" status)" failed
ok "S4 task stays superseded" eq "$(field "$RUN" status)" superseded
echo "S5 real CLI task block from the superseded task's worker:"
FOREMAN_TASK=$RUN FOREMAN_STEP=$SID task block "still there?" 2>&1; echo "[exit $?]"
ok "S5 answered at once" eq "$(sql "SELECT answer FROM blocks WHERE task_id='$RUN' AND question='still there?'")" "[('(task superseded)',)]"
ok "S5 not in inbox" hasnt "$(task inbox)" "$RUN"

LATE=$(new --project plain --kind research --title "late blocked result" --brief x); wait_step "$LATE" running
LSID=$(stepf "$LATE" id)
sql "UPDATE tasks SET status='blocked' WHERE id='$LATE'" >/dev/null
task close "$LATE" --superseded-by "$SUCC"
R=$(api /steps/$LSID/result '{"exit_code":0,"result":{"structured_output":{"status":"blocked","summary":"late"}}}'); echo "late blocked result: $R"
ok "S4 late blocked: step failed, task superseded" eq "$R" '{"step_status":"failed","task_status":"superseded"}'
ok "S4 no block row added" eq "$(task show "$LATE" --json | J "len(d['blocks'])")" 0
sleep 5
ok "S4 still one step after ticks" eq "$(nsteps "$LATE")" 1

say "S7 + S8 + S9 + S10 refusals"
echo done > "$T/mode"
DONE=$(new --project clean --kind research --title "finished" --brief x); wait_status "$DONE" done
run close "$DONE" --superseded-by "$SUCC"
ok "S7 done refused" eq "$(field "$DONE" status)" done
run close "$OLD" --superseded-by "$DONE"
ok "S7 superseded refused, pointer kept" eq "$(field "$OLD" superseded_by)" "$SUCC"
ok "S7 no continues event on the refused target" eq "$(evcount "$DONE" task.continues)" 0
echo block > "$T/mode"
VICT=$(new --project plain --kind research --title "refusal victim" --brief x); wait_status "$VICT" blocked
run close "$VICT" --superseded-by T9999
run close "$VICT" --superseded-by "$VICT"
run close "$SUCC" --superseded-by "$OLD"
ok "S8 unknown + self: unchanged" eq "$(field "$VICT" status)/$(field "$VICT" superseded_by)" "blocked/None"
ok "S8 cycle refused" eq "$(field "$SUCC" status)/$(field "$SUCC" superseded_by)" "blocked/None"
for a in "close $VICT" "close $VICT --superseded-by"; do
  echo "\$ task $a (FOREMAN_URL dead: a request would give a connection error)"; FOREMAN_URL=http://127.0.0.1:1 task $a 2>&1; c=$?; echo "[exit $c]"; ok "S9 '$a' exits 1" eq "$c" 1
done
OUT=$(FOREMAN_URL=http://127.0.0.1:1 task close "$VICT" --superseded-by "" 2>&1); c=$?; echo "$OUT"; ok "S9 empty value exits 1 without request" eq "$c/$OUT" "1/error: --superseded-by <id> required"
run cancel "$OLD"; ok "S10 cancel refused" eq "$(field "$OLD" status)" superseded
run retry "$OLD"; ok "S10 retry refused" eq "$(field "$OLD" status)" superseded
ok "S10 cancel exit code" ne "$(task cancel "$OLD" >/dev/null 2>&1; echo $?)" 0
ok "S10 retry exit code" ne "$(task retry "$OLD" >/dev/null 2>&1; echo $?)" 0

say "S11 + S12 + S15 --continues without a branch"
echo done > "$T/mode"
FLD=$(new --project plain --kind research --title "to fail" --brief x); wait_status "$FLD" done
sql "UPDATE tasks SET status='failed' WHERE id='$FLD'" >/dev/null
echo block > "$T/mode"
echo "\$ task create --project plain --kind research --title successor --brief x --continues $FLD"
task create --project plain --kind research --title successor --brief x --continues "$FLD"; echo "[exit $?]"
S11=$(field "$FLD" superseded_by); echo "successor: $S11"
ok "S11 old superseded" eq "$(field "$FLD" status)" superseded
ok "S11 events" eq "$(evtext "$FLD" task.superseded)/$(evtext "$S11" task.continues)" "['superseded by $S11']/['continues $FLD']"
wait_status "$S11" blocked
echo slow > "$T/mode"
RN2=$(new --project plain --kind research --title "still running" --brief x); wait_step "$RN2" running
C0=$(sql "SELECT count(*) FROM tasks"); SEQ0=$(sql "SELECT value FROM meta WHERE key='task_seq'"); W0=$(ls -R "$T/worktrees" 2>/dev/null | wc -l)
run create --project repo --kind implement --title nope --brief x --continues T9999
run create --project repo --kind implement --title nope --brief x --continues "$RN2"
ok "S12 no task, no id, no worktree" eq "$C0/$SEQ0/$W0" "$(sql "SELECT count(*) FROM tasks")/$(sql "SELECT value FROM meta WHERE key='task_seq'")/$(ls -R "$T/worktrees" 2>/dev/null | wc -l)"
ok "S12 running task untouched" eq "$(field "$RN2" superseded_by)" None
task cancel "$RN2" >/dev/null
echo "\$ task create --project plain --kind research --title t --brief x --continues (dead URL)"; OUT=$(FOREMAN_URL=http://127.0.0.1:1 task create --project plain --kind research --title t --brief x --continues 2>&1); c=$?; echo "$OUT"; echo "[exit $c]"; ok "S15 --continues as last arg exits 1 without a request" eq "$c/$OUT" "1/error: --continues requires a task id"
echo "Observation: a following flag is read as the value (shared opt() parser), so this one reaches taskd:"
C1=$(sql "SELECT count(*) FROM tasks")
run create --project plain --kind research --title t --brief x --continues --branch x
ok "S15 note: --continues --branch x exits 1 and creates nothing" eq "$(task create --project plain --kind research --title t --brief x --continues --branch x >/dev/null 2>&1; echo $?)/$(sql "SELECT count(*) FROM tasks")" "1/$C1"

say "S13 + S14 --branch --start-at --continues against a real worktree"
echo done > "$T/mode"
G1=$(new --project repo --kind implement --title "first feature" --brief x); wait_status "$G1" gate
NG1=$(nsteps "$G1"); B1=$(field "$G1" branch); W1=$(field "$G1" worktree); echo "gate task $G1 on $B1 at $W1; git status: [$(git -C "$W1" status --porcelain)]"
G2=$(new --project repo --kind implement --title "second feature" --brief x); wait_status "$G2" gate
B2=$(field "$G2" branch); W2=$(field "$G2" worktree)
touch "$W2/dirt.txt"
run create --project repo --kind implement --title recover --brief x --branch "$B2" --start-at implement --continues "$G2"
ok "S14 dirty: old keeps status" eq "$(field "$G2" status)/$(field "$G2" superseded_by)" "gate/None"
rm "$W2/dirt.txt"
run create --project repo --kind implement --title recover --brief x --branch no-such-branch --start-at implement --continues "$G2"
ok "S14 missing branch: old keeps status" eq "$(field "$G2" status)/$(field "$G2" superseded_by)" "gate/None"
run create --project repo --kind implement --title recover --brief x --branch "$B2" --start-at nonsense --continues "$G2"
ok "S14 bad --start-at: old keeps status" eq "$(field "$G2" status)/$(field "$G2" superseded_by)" "gate/None"
echo "\$ task create --project repo --kind implement --title recover --brief x --branch $B1 --start-at implement --continues $G1"
NEWT=$(new --project repo --kind implement --title recover --brief x --branch "$B1" --start-at implement --continues "$G1"); echo "created $NEWT"
ok "S13 old superseded by new" eq "$(field "$G1" status)/$(field "$G1" superseded_by)" "superseded/$NEWT"
ok "S13 adopts worktree" eq "$(field "$NEWT" worktree)" "$W1"
ok "S13 same branch" eq "$(field "$NEWT" branch)" "$B1"
sleep 1
ok "S13 starts at implement" eq "$(task show "$NEWT" --json | J "d['steps'][0]['name']")" implement
ok "S13 old worktree still there" test -d "$W1"
sleep 3
ok "S13 worker ran in the adopted worktree" has "$(git -C "$W1" log --format=%s -5)" "fake implement"
ok "S6 gate superseded: no step added to the old task" eq "$(nsteps "$G1")" "$NG1"
run close "$G2" --superseded-by "$NEWT"
ok "S1 gate closes directly" eq "$(field "$G2" status)/$(field "$G2" superseded_by)" "superseded/$NEWT"
ok "S1 gate events" eq "$(evtext "$G2" task.superseded)/$(evcount "$NEWT" task.continues)" "['superseded by $NEWT']/2"
task cancel "$NEWT" >/dev/null

say "S16 + S17 + S18 rendering"
run ls --all --project plain | tee "$QA/ls-all-plain.txt"
LS=$(task ls --all --project plain)
ok "S16 full pointer" has "$LS" "superseded→$SUCC"
ok "S16 columns aligned" eq "$(echo "$LS" | python3 -c "
import sys
L=sys.stdin.read().splitlines(); p=L[0].index('PROJECT'); print(all(l[p-1]==' ' and l[p:].startswith(('PROJECT','plain')) for l in L))")" True
sleep 1
A=$(task ls --all --project clean); M=$(FOREMAN_CLI_NAME=task bun "$T/main/src/cli.ts" ls --all --project clean)
echo "$A" | tee "$QA/ls-all-no-superseded-branch.txt"; echo "$M" > "$QA/ls-all-no-superseded-main.txt"
ok "S16 no superseded row: byte-identical to main" eq "$A" "$M"
SH=$(task show "$OLD"); echo "$SH" | sed -n 1,4p
ok "S17 line under status" eq "$(echo "$SH" | grep -A1 '^status: ' | tail -1)" "superseded by: $SUCC"
ok "S17 json" eq "$(task show "$OLD" --json | J "d['task']['superseded_by']")" "$SUCC"
ok "S17 ls json" eq "$(task ls --all --project plain --json | J "[t['superseded_by'] for t in d if t['id']=='$OLD'][0]")" "$SUCC"
ok "S17 no line on others" hasnt "$(task show "$SUCC")" "superseded by:"
ok "S18 ls leaves out" hasnt "$(task ls)" "superseded"
ok "S18 ls leaves out gate-closed tasks" hasnt "$(task ls)" "$G1"
IB=$(task inbox); echo "$IB" > "$QA/inbox.txt"
ok "S18 inbox leaves out blocked and gate" eq "$(has "$IB" "$BLK"; echo $?)$(has "$IB" "$G1"; echo $?)$(has "$IB" "$G2"; echo $?)" 111
ok "S18 inbox json has no superseded task" eq "$(task inbox --json | J "[x for x in d['gates']+d['blocks'] if (x.get('task') or x).get('status')=='superseded']")" "[]"

say "S19 + S20 tickets, real provider against fake Linear"
echo block > "$T/mode"
TK2=$(task ticket create --project tk --title second --body b --json | J "d['ref'] if 'ref' in d else d['identifier']"); echo "second ticket: $TK2"
L1=$(new --project tk --kind research --title a --brief x --ticket TST-1); L2=$(new --project tk --kind research --title b --brief x --ticket "$TK2")
L3=$(new --project tk --kind research --title c --brief x --ticket "$TK2"); L4=$(new --project tk --kind research --title d --brief x)
L5=$(new --project tk --kind research --title e --brief x --ticket TST-1)
for t in $L1 $L2 $L3 $L4 $L5; do wait_status "$t" blocked; done
sleep 1
before=$(wc -l < "$T/linear.log")
task close "$L1" --superseded-by "$L2"
delta=$(tail -n +$((before+1)) "$T/linear.log"); echo "linear after different-ticket close: [$delta]"
ok "S19 exactly one comment, no transition, no failure text" eq "$delta" "comment TST-1: Continued as $L2"
before=$(wc -l < "$T/linear.log")
task close "$L3" --superseded-by "$L2"
task close "$L4" --superseded-by "$L2"
ok "S19 shared ticket and no ticket: silent" eq "$(tail -n +$((before+1)) "$T/linear.log")" ""
before=$(wc -l < "$T/linear.log")
CT=$(new --project tk --kind research --title f --brief x --continues "$L5" --ticket "$TK2"); sleep 1
echo "linear after --continues: [$(tail -n +$((before+1)) "$T/linear.log")]"
ok "S19 --continues posts it too" has "$(tail -n +$((before+1)) "$T/linear.log")" "comment TST-1: Continued as $CT"
wait_status "$CT" blocked
L6=$(new --project tk --kind research --title g --brief x --ticket TST-1); wait_status "$L6" blocked; sleep 1
kill $LPID; wait $LPID 2>/dev/null; sleep 0.5
run close "$L6" --superseded-by "$L2"
ok "S20 provider down: still superseded" eq "$(field "$L6" status)/$(field "$L6" superseded_by)" "superseded/$L2"
ok "S20 ticket.error recorded" eq "$(evcount "$L6" ticket.error)" 1
task show "$L6" --json | J "[json.loads(e['data']) for e in d['events'] if e['type']=='ticket.error']"

say "S21 help"
H=$(task --help); echo "$H" | grep -n -A1 'continues\|task close'
ok "S21 close documented" has "$H" "task close <id> --superseded-by <other>"
ok "S21 --continues documented" has "$H" "[--continues <id>]"

say "foreman watch (the implement step did not exercise it)"
foreman watch > "$QA/watch-raw.txt" 2>&1 & WP=$!; sleep 3; kill $WP 2>/dev/null; wait $WP 2>/dev/null
python3 - "$QA/watch-raw.txt" <<'PY'
import re,sys
s=open(sys.argv[1]).read(); s=s.split('\x1b[2J\x1b[H')[-1]; open(sys.argv[1],'w').write(s); print(s)
PY
ok "watch shows the pointer in recent" has "$(sed -n '/^recent:/,$p' "$QA/watch-raw.txt")" "superseded→"

say "Dashboard in headless Chrome (temp profile)"
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
URL="$FOREMAN_URL/dashboard?token=testtoken"
echo done > "$T/mode"; FAILED=$(new --project clean --kind research --title "real failed one" --brief x); wait_status "$FAILED" done; sql "UPDATE tasks SET status='failed', result='{\"error\":\"boom\"}' WHERE id='$FAILED'" >/dev/null
"$CH" --headless=new --disable-gpu --user-data-dir="$T/chrome" --virtual-time-budget=4000 --window-size=1400,1500 --screenshot="$QA/dashboard.png" "$URL" >/dev/null 2>&1
sleep 1; "$CH" --headless=new --disable-gpu --user-data-dir="$T/chrome" --virtual-time-budget=4000 --dump-dom "$URL" > "$QA/dashboard-dom.html" 2>/dev/null
python3 - "$QA/dashboard-dom.html" > "$T/dash.txt" <<'PY'
import re,sys
s=open(sys.argv[1]).read()
st=re.search(r'id="status"[^>]*>(.*?)<',s).group(1); print("STATUS",st)
ib=re.search(r'id="inbox"(.*?)id="active"',s,re.S).group(1); print("INBOX_SUPERSEDED",'superseded' in ib)
print("INBOX_FAILED",'real failed one' in ib)
print("POINTERS",len(re.findall(r'superseded→T\d+',s)))
PY
cat "$T/dash.txt"
ok "dashboard counts failed and superseded separately" test -n "$(grep -E 'STATUS .*[1-9][0-9]* failed .* [1-9][0-9]* superseded' "$T/dash.txt")"
ok "dashboard: superseded never under Needs you" grep -q "INBOX_SUPERSEDED False" "$T/dash.txt"
ok "dashboard: failed still under Needs you" grep -q "INBOX_FAILED True" "$T/dash.txt"
ok "dashboard: Recent shows the pointer" test -z "$(grep 'POINTERS 0' "$T/dash.txt")"

say "Final listing"
task ls --all
cp "$T/linear.log" "$QA/linear.log"
grep -iE "error|failed:" "$T/taskd.log" | grep -v "fake crash" | head -20
echo; echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
