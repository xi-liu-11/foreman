// QA T0035: migration + task show + reject T0034 on a copy of the live DB.
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const W = process.argv[2];
const bin = mkdtempSync("/tmp/fm-qa-bin-"); writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 1\n"); chmodSync(join(bin, "herdr"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.FOREMAN_HOME = W;
const path = join(W, "foreman.db");
// Make it an "old" DB: drop the two new columns.
const raw = new Database(path);
raw.exec("ALTER TABLE tasks DROP COLUMN plan_cycles; ALTER TABLE tasks DROP COLUMN rejection;");
const before = raw.query("select * from tasks order by id").all() as any[];
const stepsBefore = JSON.stringify(raw.query("select * from steps order by id").all());
console.log("old columns:", Object.keys(before[0]).join(","));
raw.close();
const root = process.argv[3];
const { Store } = await import(join(root, "src/db.ts"));
for (let i = 1; i <= 2; i++) {
  const s = new Store(path);
  const rows = s.db.query("select * from tasks order by id").all() as any[];
  const same = rows.length === before.length && rows.every((r: any, k: number) => Object.keys(before[k]).every(c => r[c] === before[k][c]));
  console.log(`open #${i}: ${rows.length} tasks, unchanged=${same}, plan_cycles all 0=${rows.every((r: any) => r.plan_cycles === 0)}, rejection all null=${rows.every((r: any) => r.rejection === null)}, steps unchanged=${JSON.stringify(s.db.query("select * from steps order by id").all()) === stepsBefore}`);
  s.db.close();
}
const { route, cfg } = await import(join(root, "src/taskd.ts"));
const { DB_PATH } = await import(join(root, "src/config.ts"));
if (DB_PATH !== path) throw new Error(`refusing: DB_PATH=${DB_PATH}`);
for (const p of Object.values(cfg.projects) as any[]) p.concurrency = 0;
const store = new Store(path);
// Neutralise the other active task(s) in the copy so a tick can never act on real worktrees.
store.db.exec("update tasks set status='cancelled' where id != 'T0034' and status in ('queued','running','blocked')");
const H = { authorization: `Bearer ${cfg.server.token}`, "content-type": "application/json" };
const call = async (m: string, p: string, b?: unknown) => { const r = await route(new Request(`http://x${p}`, { method: m, headers: H, body: b === undefined ? undefined : JSON.stringify(b) })); return { status: r.status, body: await r.json() as any }; };
const show = await call("GET", "/tasks/T0034");
console.log("\n== GET /tasks/T0034 (task show) ==");
console.log("status:", show.body.task.status, "step:", show.body.task.current_step, "plan_cycles:", show.body.task.plan_cycles);
console.log("gate_label:", show.body.task.gate_label);
console.log("steps:", show.body.steps.map((s: any) => `${s.name}#${s.attempt}:${s.status}`).join(" "));
const r = await call("POST", "/tasks/T0034/reject", { feedback: "QA test: please address the plan-review findings" });
console.log("\n== POST /tasks/T0034/reject ==", r.status, JSON.stringify(r.body));
const t = store.getTask("T0034")!;
console.log("after: status", t.status, "step", t.current_step, "rejection", t.rejection);
console.log("steps:", store.stepsForTask("T0034").map((s: any) => `${s.name}#${s.attempt}:${s.status}`).join(" "));
const plan = store.latestStep("T0034", "plan")!;
const ctx = await call("GET", `/steps/${plan.id}/context`);
console.log("\n== plan#2 QA_FEEDBACK ==\n" + ctx.body.prompt_vars.QA_FEEDBACK);
process.exit(0);
