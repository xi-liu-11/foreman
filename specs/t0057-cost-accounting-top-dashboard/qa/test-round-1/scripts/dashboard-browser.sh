#!/bin/zsh
# AS-5/AS-6/AS-7 against an isolated taskd (temp FOREMAN_HOME, port 17957), driven with headless Chrome.
# A Bun proxy on 17958 serves the real dashboard and API; with FAIL_TODAY=1 it answers /costs/today with 500.
# The proxy only pre-opens the cards (localStorage.foreman_open), it does not change dashboard code.
set -u
WT=$1; OUT=$2
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
H=$(mktemp -d /tmp/fm-t0057-dash.XXXX); B=$(mktemp -d /tmp/fm-t0057-bin.XXXX)
printf '#!/bin/sh\nexit 1\n' > $B/herdr; printf '#!/bin/sh\nexit 1\n' > $B/claude; chmod +x $B/*
export FOREMAN_HOME=$H CLAUDE_CONFIG_DIR=$H/claude PATH=$B:$PATH
unset FOREMAN_TASK FOREMAN_STEP FOREMAN_STEP_NAME FOREMAN_RUN_DIR FOREMAN_URL FOREMAN_TOKEN
cd $WT
bun -e 'import {ensureHome} from "./src/config"; ensureHome()' >/dev/null
sed -i '' 's/^port = 7777/port = 17957/' $H/config.toml
TOKEN=$(grep '^token' $H/config.toml | cut -d'"' -f2)
# Seed before taskd starts (no concurrent writer).
bun -e '
import { Store } from "./src/db";
import { pipelineFor } from "./src/pipelines";
const s = new Store();
const PIPE = JSON.stringify(pipelineFor("implement", false, { merge: "direct", merge_gate: true, tickets: false }).steps);
const ago = (m:number) => new Date(Date.now()-m*60000).toISOString();
const task = (id:string, status:string, step:string, result:string|null) => s.insertTask({ id, project:"qa-dash", kind:"implement", title:`qa ${id}`, brief:"b", status, pipeline:PIPE, current_step:step, priority:0, branch:null, worktree:`/fake/wt/${id}`, feature_dir:null, ticket:null, pr_url:null, qa_cycles:0, result });
const step = (t:string, name:string, status:string, f:object) => { const st = s.insertStep({ task_id:t, name, role:"developer", status, attempt:1, session_id:null, machine:null }); s.updateStep(st.id, { started_at: ago(10), finished_at: status === "running" ? null : ago(1), ...f }); return st; };
const failed = JSON.stringify({ error: "x broke" });
task("D1", "failed", "implement", failed); step("D1", "implement", "failed", { cost_usd: 1.2, cost_estimated: 1, cost_unknown: 0, turns: 3 });
task("D2", "failed", "implement", failed); step("D2", "implement", "failed", { cost_usd: 0, cost_estimated: 0, cost_unknown: 1 });
task("D3", "failed", "implement", failed); step("D3", "implement", "failed", { cost_usd: 1.2, cost_estimated: 0, cost_unknown: 0, turns: 3 });
task("D4", "gate", "plan_approved", null); step("D4", "plan", "done", { cost_usd: 1.5, cost_estimated: 1, cost_unknown: 0, turns: 2 });
task("D5", "running", "implement", null); step("D5", "implement", "running", { lease_until: new Date(Date.now()+3600e3).toISOString(), launch_started_at: ago(3), launched_at: ago(3), runner_seen_at: ago(1) });
task("D6", "running", "implement", null); step("D6", "implement", "running", { lease_until: new Date(Date.now()+3600e3).toISOString(), launch_started_at: ago(2), launched_at: null, runner_seen_at: null });
'
FOREMAN_CLI_NAME=foreman bun src/cli.ts taskd > $H/taskd.log 2>&1 &
TD=$!
for i in {1..100}; do curl -s -o /dev/null http://127.0.0.1:17957/costs/today -H "authorization: Bearer $TOKEN" && break; sleep 0.2; done
cat > $B/proxy.ts <<'P'
const fail = process.env.FAIL_TODAY === "1";
Bun.serve({ port: 17958, async fetch(req) {
  const u = new URL(req.url);
  if (fail && u.pathname === "/costs/today") return new Response("boom", { status: 500 });
  const r = await fetch("http://127.0.0.1:17957" + u.pathname + u.search, { headers: req.headers });
  if (u.pathname === "/dashboard") return new Response((await r.text()).replace("let open = new Set();", `localStorage.foreman_open = JSON.stringify(["D1","D2","D3","D4"]); let open = new Set();`), { headers: { "content-type": "text/html" } });
  return r;
}});
P
for mode in ok fail; do
  FAIL_TODAY=$([ $mode = fail ] && echo 1 || echo 0) bun $B/proxy.ts > $H/proxy.log 2>&1 &
  PX=$!; sleep 1
  URL="http://127.0.0.1:17958/dashboard?token=$TOKEN"
  "$CHROME" --headless=new --disable-gpu --no-first-run --user-data-dir=$H/chrome-$mode --virtual-time-budget=8000 --dump-dom "$URL" > $OUT/dashboard-$mode.dom.html 2>/dev/null
  "$CHROME" --headless=new --disable-gpu --no-first-run --user-data-dir=$H/chrome-$mode --virtual-time-budget=8000 --window-size=1400,1800 --screenshot=$OUT/dashboard-$mode.png "$URL" >/dev/null 2>&1
  kill $PX; wait $PX 2>/dev/null
done
echo "### GET /costs/today"; curl -s http://127.0.0.1:17957/costs/today -H "authorization: Bearer $TOKEN"; echo
for t in D1 D4 D5 D6; do echo; echo "### task show $t"; FOREMAN_CLI_NAME=task FOREMAN_URL=http://127.0.0.1:17957 bun src/cli.ts show $t | head -20; done
echo; echo "### task ls --all"; FOREMAN_CLI_NAME=task bun src/cli.ts ls --all
echo; echo "### taskd log"; cat $H/taskd.log
kill $TD; wait $TD 2>/dev/null
rm -rf $H $B
