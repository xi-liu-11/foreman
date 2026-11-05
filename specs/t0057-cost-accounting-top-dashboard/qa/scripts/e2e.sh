#!/bin/zsh
set -u
WT=$1
H=$(mktemp -d /tmp/fm-t0055-home.XXXX); C=$(mktemp -d /tmp/fm-t0055-claude.XXXX); B=$(mktemp -d /tmp/fm-t0055-bin.XXXX)
printf '#!/bin/sh\nexit 1\n' > $B/herdr; printf '#!/bin/sh\nexit 1\n' > $B/claude; chmod +x $B/*
export FOREMAN_HOME=$H CLAUDE_CONFIG_DIR=$C PATH=$B:$PATH
unset FOREMAN_TASK FOREMAN_STEP FOREMAN_STEP_NAME FOREMAN_RUN_DIR FOREMAN_URL FOREMAN_TOKEN
cd $WT
bun -e 'import {ensureHome} from "./src/config"; ensureHome()' >/dev/null
sed -i '' 's/^port = 7777/port = 17955/' $H/config.toml
TOKEN=$(grep '^token' $H/config.toml | cut -d'"' -f2)
# Session log for QA2/S4 in its worktree slug: m1 (dup rows) + m2 inside window, "old" outside. Expected 0.054.
mkdir -p "$C/projects/-fake-wt-QA2"
bun -e '
const ago = (m:number) => new Date(Date.now()-m*60000).toISOString();
const row = (id:string, ts:string, usage:object) => JSON.stringify({ type:"assistant", timestamp:ts, message:{ id, model:"claude-opus-5-5", usage } });
await Bun.write(process.argv[1], [row("old",ago(60),{input_tokens:99999,output_tokens:99999}), row("m1",ago(5),{input_tokens:1000,output_tokens:10}), row("m1",ago(5),{input_tokens:1000,output_tokens:2000}), row("m2",ago(4),{input_tokens:0,output_tokens:0,cache_read_input_tokens:10000,cache_creation_input_tokens:1000,cache_creation:{ephemeral_5m_input_tokens:0,ephemeral_1h_input_tokens:1000}})].join("\n")+"\n");
' "$C/projects/-fake-wt-QA2/S4.jsonl"
FOREMAN_CLI_NAME=foreman bun src/cli.ts taskd > $H/taskd.log 2>&1 &
TD=$!
for i in {1..50}; do curl -s -o /dev/null http://127.0.0.1:17955/costs/today -H "authorization: Bearer $TOKEN" && break; sleep 0.2; done
bun -e '
import { Store } from "./src/db";
import { pipelineFor } from "./src/pipelines";
const s = new Store();
const TOKEN = process.argv[1];
const PIPE = JSON.stringify(pipelineFor("implement", false, { merge: "direct", merge_gate: true, tickets: false }).steps);
const ago = (m:number) => new Date(Date.now()-m*60000).toISOString();
for (const [id, project] of [["QA1","qa-alpha"],["QA2","qa-alpha"],["QA3","qa-beta"]])
  s.insertTask({ id, project, kind:"implement", title:`qa ${id}`, brief:"b", status:"failed", pipeline:PIPE, current_step:"implement", priority:0, branch:null, worktree:`/fake/wt/${id}`, feature_dir:null, ticket:null, pr_url:null, qa_cycles:0, result:null });
const res = (sid:string, c:number, n:number) => ({ exit_code:0, session_id:sid, result:{ type:"result", total_cost_usd:c, num_turns:n, structured_output:{ status:"failed", verdict:"n/a", summary:"x", notes_for_next:"", artifacts:[] } } });
const kill = (sid:string|null) => ({ exit_code:143, killed:"timeout after 90 min", session_id:sid, result:null });
async function step(task:string, sid:string|null, body:object) {
  s.db.run("UPDATE tasks SET status = ?, current_step = ? WHERE id = ?", ["running", "implement", task]);
  const n = s.stepsForTask(task).length + 1;
  const st = s.insertStep({ task_id:task, name:"implement", role:"developer", status:"running", attempt:n, session_id:sid, machine:null });
  s.updateStep(st.id, { started_at: ago(10) });
  const r = await fetch(`http://127.0.0.1:17955/steps/${st.id}/result`, { method:"POST", headers:{ authorization:`Bearer ${TOKEN}`, "content-type":"application/json" }, body: JSON.stringify(body) });
  console.log(`POST step ${st.id} (${task} #${n}) -> ${r.status} ${await r.text()}`);
}
await step("QA1", null, res("S1", 7.84, 5));   // AS-1
await step("QA1", "S1", res("S1", 19.16, 10)); // AS-2
await step("QA1", null, res("S2", 6.77, 146)); // AS-3
await step("QA2", null, res("S4", 2, 3));
await step("QA2", "S4", kill("S4"));            // AS-4 (log present, expect ~0.054)
await step("QA2", "S4", res("S4", 3, 4));       // AS-5 (expect 3-2-0.054 = 0.946)
await step("QA3", null, kill(null));            // AS-6
' $TOKEN
echo "### steps table (sqlite)"
sqlite3 -header -column $H/foreman.db "SELECT id, task_id, attempt, session_id, round(cost_usd,4) cost_usd, round(session_cost_usd,4) session_cost_usd, turns, cost_estimated est, cost_unknown unk, date(finished_at,'localtime') day FROM steps ORDER BY id"
echo; echo "### GET /costs/today"; curl -s http://127.0.0.1:17955/costs/today -H "authorization: Bearer $TOKEN"; echo
echo; echo "### GET /tasks?all=1 (cost fields)"; curl -s "http://127.0.0.1:17955/tasks?all=1" -H "authorization: Bearer $TOKEN" | bun -e 'for (const t of JSON.parse(await Bun.stdin.text())) console.log(t.id, t.project, t.status, t.cost_usd, t.cost_estimated, t.cost_unknown)'
echo; echo "### task ls --all"; FOREMAN_CLI_NAME=task bun src/cli.ts ls --all; echo "exit $?"
echo; echo "### task ls --all --project qa-beta"; FOREMAN_CLI_NAME=task bun src/cli.ts ls --all --project qa-beta; echo "exit $?"
echo; echo "### task ls --all --json | head"; FOREMAN_CLI_NAME=task bun src/cli.ts ls --all --json | head -c 300; echo; echo "exit $?"
for t in QA1 QA2 QA3; do echo; echo "### task show $t"; FOREMAN_CLI_NAME=task bun src/cli.ts show $t | head -25; done
echo; echo "### dashboard header (#status) from the served /dashboard page and live /costs/today"
curl -s http://127.0.0.1:17955/dashboard -H "authorization: Bearer $TOKEN" > $H/dash.html
grep -o 'today \${money(today.total.usd, today.total.estimated, today.total.unknown)}[^`]*' $H/dash.html | head -1
curl -s http://127.0.0.1:17955/costs/today -H "authorization: Bearer $TOKEN" > $H/today.json
bun -e '
const html = await Bun.file(process.argv[1]).text();
const money = new Function(html.split("\n").find(l => l.startsWith("const money = "))! + "\nreturn money;")();
const today = await Bun.file(process.argv[2]).json();
const line = html.split("\n").find(l => l.includes(`getElementById("status").textContent`))!;
const tpl = line.slice(line.indexOf("`"), line.lastIndexOf("`") + 1);
const f = new Function("money", "today", "running", "needs", "failed", "superseded", "return " + tpl);
console.log("#status =", f(money, today, 0, [], 3, 0));
' $H/dash.html $H/today.json
echo; echo "### taskd log"; cat $H/taskd.log
kill $TD; wait $TD 2>/dev/null
rm -rf $H $C $B
