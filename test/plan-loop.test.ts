import { test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `fm-plq-${name}-`)));
const home = tmp("home");
process.env.FOREMAN_HOME = home;
// A herdr that always fails, so gate notifications neither reach the real herdr nor stall a tick.
const bin = tmp("bin");
writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 1\n");
chmodSync(join(bin, "herdr"), 0o755);
const savedPath = process.env.PATH;
process.env.PATH = `${bin}:${savedPath}`;
const { Store } = await import("../src/db");
const { route, cfg, tick } = await import("../src/taskd");
const { DB_PATH } = await import("../src/config");
// Workers run with FOREMAN_HOME pointing at the live home; never tick or seed that DB.
if (![tmpdir(), realpathSync(tmpdir())].some(d => DB_PATH.startsWith(d))) throw new Error(`refusing to run against ${DB_PATH}`);
const { pipelineFor } = await import("../src/pipelines");
import type { TaskRow, StepRow, StepStatus } from "../src/db";
import type { PipelineStep } from "../src/pipelines";

// Same harness as superseded.test.ts: seed through a second Store on taskd's DB,
// register projects on the exported cfg, concurrency 0 so nothing is spawned.
// The scheduler ticks only after /result, /approve and /reject, so the tests
// finish a step by hand and poll for the rows the next tick creates, ticking
// again while polling in case the scheduled tick found another one running.
const store = new Store();
const headers = { authorization: `Bearer ${cfg.server.token}`, "content-type": "application/json" };
const P = "plq-speckit";
cfg.projects[P] = { name: P, path: home, base_branch: "main", verify: "inspect", speckit: true, deny: [], concurrency: 0, merge: "direct", merge_gate: true, squash: true, ticket_states: {}, resources: [], lease_max_minutes: 60 };
const savedMaxPlan = cfg.defaults.max_plan_cycles;
cfg.defaults.max_plan_cycles = 2;
afterAll(() => {
  delete cfg.projects[P];
  cfg.defaults.max_plan_cycles = savedMaxPlan;
  process.env.PATH = savedPath;
});

const PIPELINE = pipelineFor("implement", true, { merge: "direct", merge_gate: true, tickets: false }).steps;
// The shape stored on tasks created before T0035 (T0034): plan_qa without on_fail.
const LEGACY = PIPELINE.map(s => s.type === "agent" && s.name === "plan_qa" ? { type: "agent", name: "plan_qa", role: "qa-reviewer", prompt: "plan_qa" } : s) as PipelineStep[];

let tid = 0;
function mkTask(over: Partial<TaskRow> & { pipeline?: string } = {}): TaskRow {
  return store.insertTask({
    id: `PLQ${++tid}`, project: P, kind: "implement", title: `plan loop ${tid}`, brief: "b", status: "queued",
    pipeline: JSON.stringify(PIPELINE), current_step: "plan_qa", priority: 0, branch: null, worktree: null,
    feature_dir: "specs/041-thing", ticket: null, pr_url: null, qa_cycles: 0, result: null, ...over,
  });
}
const so = (verdict: string, summary: string, notes = "") => ({ status: "done", verdict, summary, notes_for_next: notes, artifacts: [] });
function row(task: TaskRow, name: string, status: StepStatus, result?: object, role = "architect"): StepRow {
  const s = store.insertStep({ task_id: task.id, name, role, status, attempt: (store.latestStep(task.id, name)?.attempt ?? 0) + 1 });
  if (result) store.updateStep(s.id, { result: JSON.stringify(result), finished_at: "x" });
  return store.getStep(s.id)!;
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await route(new Request(`http://x${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}
// Report a result for the step's latest queued attempt as if a worker had run it.
async function finish(task: TaskRow, name: string, verdict: string, summary = `${name} summary`, notes = ""): Promise<StepRow> {
  const s = store.latestStep(task.id, name)!;
  expect(s.status).toBe("queued");
  store.updateStep(s.id, { status: "running" });
  const r = await call("POST", `/steps/${s.id}/result`, { exit_code: 0, result: { structured_output: so(verdict, summary, notes) } });
  expect(r.status).toBe(200);
  return s;
}
async function waitFor(what: string, fn: () => boolean): Promise<void> {
  for (let i = 0; i < 150; i++) { if (fn()) return; await Bun.sleep(20); await tick(); }
  throw new Error(`timed out waiting for ${what}`);
}
const queued = (task: TaskRow, name: string, attempt: number) => () => {
  const s = store.latestStep(task.id, name);
  return s?.status === "queued" && s.attempt === attempt;
};
const atGate = (task: TaskRow, attempt: number) => () => {
  const t = store.getTask(task.id)!;
  return t.status === "gate" && store.latestStep(task.id, t.current_step!)?.attempt === attempt;
};
const events = (id: string, type: string) => store.eventsForTask(id, 200).filter(e => e.type === type).map(e => JSON.parse(e.data)).reverse();
const context = async (task: TaskRow, name: string) => (await call("GET", `/steps/${store.latestStep(task.id, name)!.id}/context`)).body.prompt_vars;

function seedAtPlanQa(): TaskRow {
  const t = mkTask();
  row(t, "specify", "done", so("n/a", "specified"));
  row(t, "plan", "done", so("n/a", "planned"));
  row(t, "plan_qa", "queued", undefined, "qa-reviewer");
  return t;
}

// ---------------------------------------------------------------- plan QA loop

test("plan QA fail sends the plan back with the findings, then a pass goes to the gate", async () => {
  const t = seedAtPlanQa();
  await finish(t, "plan_qa", "fail", "C1 HIGH: the retry path is missing", "Fix C1 in plan.md");
  await waitFor("plan#2 queued", queued(t, "plan", 2));
  let task = store.getTask(t.id)!;
  expect(task.plan_cycles).toBe(1);
  expect(task.current_step).toBe("plan");
  expect(task.status).toBe("queued");
  expect(store.latestStep(t.id, "plan_qa")!.status).toBe("skipped");
  expect(events(t.id, "task.plan_qa_fail")).toEqual([{ cycle: 1, revising: true, summary: "C1 HIGH: the retry path is missing" }]);

  const vars = await context(t, "plan");
  expect(vars.QA_FEEDBACK).toContain("This is plan revision 1.");
  expect(vars.QA_FEEDBACK).toContain("C1 HIGH: the retry path is missing");
  expect(vars.QA_FEEDBACK).toContain("Fix C1 in plan.md");
  expect(vars.QA_FEEDBACK).toContain("specs/041-thing/qa/plan-review.md");
  expect(vars.PLAN_CYCLE).toBe("2");

  await finish(t, "plan", "n/a", "revised");
  await waitFor("plan_qa#2 queued", queued(t, "plan_qa", 2));
  await finish(t, "plan_qa", "pass", "all findings addressed");
  await waitFor("gate", atGate(t, 1));
  task = store.getTask(t.id)!;
  expect(task.current_step).toBe("plan_approved");
  expect(events(t.id, "task.gate").at(-1)!.label).toBe("Approve the plan");
  expect((await call("GET", `/tasks/${t.id}`)).body.task.gate_label).toBe("Approve the plan");
});

test("plan QA failing on every allowed review goes to the gate with a warning, not a failure", async () => {
  const t = seedAtPlanQa();
  await finish(t, "plan_qa", "fail", "C1 HIGH");
  await waitFor("plan#2 queued", queued(t, "plan", 2));
  await finish(t, "plan", "n/a", "revised");
  await waitFor("plan_qa#2 queued", queued(t, "plan_qa", 2));
  await finish(t, "plan_qa", "fail", "C1 still HIGH");
  await waitFor("gate", atGate(t, 1));

  const task = store.getTask(t.id)!;
  expect(task.status).toBe("gate");
  expect(task.plan_cycles).toBe(1);
  expect(store.stepsForTask(t.id).filter(s => s.status === "failed")).toEqual([]);
  expect(events(t.id, "task.plan_qa_fail").map(e => [e.cycle, e.revising])).toEqual([[1, true], [2, false]]);
  const label = "Approve the plan — plan QA still fails after 2 review(s); see specs/041-thing/qa/plan-review.md";
  expect(events(t.id, "task.gate").at(-1)!.label).toBe(label);
  expect((await call("GET", `/tasks/${t.id}`)).body.task.gate_label).toBe(label);
  const listed = (await call("GET", `/tasks?project=${P}`)).body.find((x: any) => x.id === t.id);
  expect(listed.gate_label).toBe(label);
});

// ---------------------------------------------------------------- reject

test("reject at the plan gate re-runs the plan of a legacy task with the user's feedback and the plan QA review", async () => {
  // T0034 as it stands: legacy pipeline JSON, plan_qa #1 done with verdict fail, waiting at plan_approved.
  const t = mkTask({ pipeline: JSON.stringify(LEGACY), status: "gate", current_step: "plan_approved" });
  row(t, "specify", "done", so("n/a", "specified"));
  const plan1 = row(t, "plan", "done", so("n/a", "planned"));
  const qa1 = row(t, "plan_qa", "done", so("fail", "U1 HIGH: undo is unspecified", "see U1"), "qa-reviewer");
  const gate1 = row(t, "plan_approved", "gate", undefined, "user");
  expect((await call("GET", `/tasks/${t.id}`)).body.task.gate_label).toContain("plan QA still fails after 1 review(s)");

  const r = await call("POST", `/tasks/${t.id}/reject`, { feedback: "  Please address U1 and drop the CSV export.  " });
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ ok: true, gate: "plan_approved", step: "plan" });

  let task = store.getTask(t.id)!;
  expect(task.status).toBe("queued");
  expect(task.current_step).toBe("plan");
  expect(task.plan_cycles).toBe(0);
  expect(task.pipeline).toBe(JSON.stringify(LEGACY)); // stored step names untouched
  const rejection = JSON.parse(task.rejection!);
  expect(rejection).toMatchObject({ gate: "plan_approved", target: "plan", feedback: "Please address U1 and drop the CSV export." });
  expect(store.getStep(gate1.id)!.status).toBe("skipped");
  expect(store.getStep(qa1.id)!.status).toBe("skipped");
  expect(store.getStep(plan1.id)!.status).toBe("done");
  const plan2 = store.latestStep(t.id, "plan")!;
  expect([plan2.status, plan2.attempt, plan2.session_id]).toEqual(["queued", 2, null]);
  expect(events(t.id, "note").at(-1)!.text).toBe("Rejected at plan_approved: Please address U1 and drop the CSV export.");
  expect(events(t.id, "task.rejected")).toEqual([{ gate: "plan_approved", target: "plan", feedback: "Please address U1 and drop the CSV export." }]);

  const vars = await context(t, "plan");
  expect(vars.QA_FEEDBACK).toContain("The user sent this back with feedback.");
  expect(vars.QA_FEEDBACK).toContain("Please address U1 and drop the CSV export.");
  expect(vars.QA_FEEDBACK).toContain("U1 HIGH: undo is unspecified");
  expect(vars.QA_FEEDBACK).toContain("specs/041-thing/qa/plan-review.md");

  await finish(t, "plan", "n/a", "revised");
  await waitFor("plan_qa#2 queued", queued(t, "plan_qa", 2));
  await finish(t, "plan_qa", "pass", "fixed");
  await waitFor("gate reopened", atGate(t, 2));
  task = store.getTask(t.id)!;
  expect(task.rejection).toBeNull();
  expect(store.stepsForTask(t.id).filter(s => s.name === "plan_approved").map(s => s.status)).toEqual(["skipped", "gate"]);
  expect((await call("GET", `/tasks/${t.id}`)).body.task.gate_label).toBe("Approve the plan");
});

test("reject at the merge gate re-runs implement, QA and handoff with the feedback", async () => {
  const t = mkTask({ status: "gate", current_step: "merge_approved", qa_cycles: 1 });
  for (const n of ["specify", "plan"]) row(t, n, "done", so("n/a", n));
  const qa = row(t, "plan_qa", "done", so("pass", "ok"), "qa-reviewer");
  row(t, "plan_approved", "done", undefined, "user");
  const impl1 = row(t, "implement", "done", so("n/a", "built"), "developer");
  const rev = row(t, "review", "done", so("pass", "ok"), "qa-reviewer");
  const tst = row(t, "test", "done", so("pass", "ok"), "test-analyst");
  const hand = row(t, "handoff", "done", so("n/a", "handed off"), "developer");
  const gate1 = row(t, "merge_approved", "gate", undefined, "user");

  const r = await call("POST", `/tasks/${t.id}/reject`, { feedback: "The empty state copy is wrong" });
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ ok: true, gate: "merge_approved", step: "implement" });
  const task = store.getTask(t.id)!;
  expect([task.status, task.current_step, task.qa_cycles]).toEqual(["queued", "implement", 0]);
  for (const s of [gate1, rev, tst, hand]) expect(store.getStep(s.id)!.status).toBe("skipped");
  expect(store.getStep(qa.id)!.status).toBe("done");
  expect(store.getStep(impl1.id)!.status).toBe("done");
  expect(store.latestStep(t.id, "implement")!.attempt).toBe(2);

  const vars = await context(t, "implement");
  expect(vars.QA_FEEDBACK).toContain("The user rejected this at merge_approved");
  expect(vars.QA_FEEDBACK).toContain("The empty state copy is wrong");

  await finish(t, "implement", "n/a", "fixed copy");
  await waitFor("review#2 and test#2 queued", () => queued(t, "review", 2)() && queued(t, "test", 2)());
  await finish(t, "review", "pass");
  await finish(t, "test", "pass");
  await waitFor("handoff#2 queued", queued(t, "handoff", 2));
  await finish(t, "handoff", "n/a");
  await waitFor("merge gate reopened", atGate(t, 2));
  expect(store.getTask(t.id)!.current_step).toBe("merge_approved");
  expect(store.getTask(t.id)!.rejection).toBeNull();
});

test("reject refuses a task that is not at a gate, and empty feedback", async () => {
  const running = mkTask({ status: "running", current_step: "plan" });
  const r1 = await call("POST", `/tasks/${running.id}/reject`, { feedback: "no" });
  expect(r1.status).toBe(400);
  expect(r1.body.error).toContain("not waiting at a gate");

  const t = mkTask({ status: "gate", current_step: "plan_approved" });
  row(t, "plan", "done", so("n/a", "planned"));
  row(t, "plan_qa", "done", so("pass", "ok"), "qa-reviewer");
  row(t, "plan_approved", "gate", undefined, "user");
  const before = JSON.stringify([store.getTask(t.id), store.stepsForTask(t.id)]);
  for (const feedback of [undefined, "", "   "]) {
    const r = await call("POST", `/tasks/${t.id}/reject`, feedback === undefined ? {} : { feedback });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("feedback required");
  }
  expect(JSON.stringify([store.getTask(t.id), store.stepsForTask(t.id)])).toBe(before);
  expect(events(t.id, "task.rejected")).toEqual([]);
});

// ---------------------------------------------------------------- migration

test("the migration adds plan_cycles and rejection to an old database and keeps its rows", () => {
  const path = join(tmp("migrate"), "old.db");
  const old = new Database(path, { create: true });
  old.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, brief TEXT NOT NULL, status TEXT NOT NULL, pipeline TEXT NOT NULL, current_step TEXT, priority INTEGER NOT NULL DEFAULT 5, branch TEXT, worktree TEXT, feature_dir TEXT, ticket TEXT, qa_cycles INTEGER NOT NULL DEFAULT 0, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, pr_url TEXT, superseded_by TEXT);
    INSERT INTO tasks (id, project, kind, title, brief, status, pipeline, current_step, qa_cycles, created_at, updated_at) VALUES ('T0034', 'p', 'implement', 't', 'b', 'gate', '${JSON.stringify(LEGACY)}', 'plan_approved', 0, 'x', 'x');`);
  old.close();
  for (let i = 0; i < 2; i++) {
    const migrated = new Store(path);
    const row = migrated.getTask("T0034")!;
    expect([row.status, row.current_step, row.pipeline]).toEqual(["gate", "plan_approved", JSON.stringify(LEGACY)]);
    expect(row.plan_cycles).toBe(0);
    expect(row.rejection).toBeNull();
    migrated.db.close();
  }
});
