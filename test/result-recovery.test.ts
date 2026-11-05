import { test, expect, afterAll } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `fm-recover-${name}-`)));
const home = tmp("home");
process.env.FOREMAN_HOME = home;
// A herdr that always fails, so closeTab and notifications neither reach the real herdr nor stall a tick.
const bin = tmp("bin");
writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 1\n");
chmodSync(join(bin, "herdr"), 0o755);
const savedPath = process.env.PATH;
process.env.PATH = `${bin}:${savedPath}`;
const { Store } = await import("../src/db");
const { tick, cfg, testHooks } = await import("../src/taskd");
const { DB_PATH, RUNS_DIR } = await import("../src/config");
// Workers run with FOREMAN_HOME pointing at the live home; never seed that DB.
if (![tmpdir(), realpathSync(tmpdir())].some(d => DB_PATH.startsWith(d))) throw new Error(`refusing to run against ${DB_PATH}`);
const { pipelineFor } = await import("../src/pipelines");
import type { StepRow } from "../src/db";

// AS-10: a finished result left in transcript.jsonl is recovered when the lease expires.
const store = new Store();
const P = "result-recovery";
cfg.projects[P] = { name: P, path: home, base_branch: "main", verify: "inspect", speckit: false, deny: [], concurrency: 0, merge: "direct", merge_gate: true, squash: true, ticket_states: {}, resources: [], lease_max_minutes: 60 };
afterAll(() => {
  delete cfg.projects[P];
  process.env.PATH = savedPath;
});

const PIPELINE = pipelineFor("implement", false, { merge: "direct", merge_gate: true, tickets: false }).steps;
const SUMMARY = "Revised the plan: split the lease work into arm-after-launch, runner check-in and tick-gap extension, with the schema change first.";
const assistant = (text: string) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const userLine = JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "ok" }] } });
const resultLine = JSON.stringify({
  type: "result", subtype: "success", is_error: false, num_turns: 36, total_cost_usd: 2.738647,
  session_id: "7c1f0e52-3a4b-4d6e-9a10-5b2c8d9e0f11",
  structured_output: { status: "done", summary: SUMMARY, verdict: "n/a", artifacts: [], notes_for_next: "" },
});

let tid = 0;
function seed(transcript: string[] | null, report?: object): { taskId: string; step: StepRow; runDir: string } {
  const task = store.insertTask({
    id: `RR${++tid}`, project: P, kind: "implement", title: `result recovery ${tid}`, brief: "b", status: "running",
    pipeline: JSON.stringify(PIPELINE), current_step: "plan", priority: 0, branch: null, worktree: null,
    feature_dir: null, ticket: null, pr_url: null, qa_cycles: 0, result: null,
  });
  const step = store.insertStep({ task_id: task.id, name: "plan", role: "planner", status: "running", attempt: 2 });
  const t = new Date(Date.now() - 60_000).toISOString();
  store.updateStep(step.id, { lease_until: new Date(Date.now() - 30_000).toISOString(), launch_started_at: t, launched_at: t, runner_seen_at: t });
  const runDir = join(RUNS_DIR, task.id, "plan-2");
  mkdirSync(runDir, { recursive: true });
  if (transcript) writeFileSync(join(runDir, "transcript.jsonl"), transcript.join("\n") + "\n");
  if (report) writeFileSync(join(runDir, "report.json"), JSON.stringify(report));
  return { taskId: task.id, step, runDir };
}
const recoveredEvents = (taskId: string, stepId: number) =>
  store.eventsForTask(taskId, 100).filter(e => e.type === "step.result_recovered" && e.step_id === stepId);

test("a finished result in the transcript is recovered when the lease expires", async () => {
  const { taskId, step, runDir } = seed([assistant("Reading the spec"), userLine, assistant("Writing the plan"), resultLine]);
  expect(existsSync(join(runDir, "report.json"))).toBe(false);
  testHooks.setLastTickStart(Date.now());
  await tick();
  const s = store.getStep(step.id)!;
  expect(s.status).toBe("done");
  expect(s.cost_usd).toBe(2.738647);
  expect(s.turns).toBe(36);
  expect(JSON.parse(s.result!).summary).toBe(SUMMARY);
  const report = JSON.parse(readFileSync(join(runDir, "report.json"), "utf8"));
  expect(report.recovered_from).toBe("transcript");
  expect(report.result.num_turns).toBe(36);
  const ev = recoveredEvents(taskId, step.id);
  expect(ev.length).toBe(1);
  expect(JSON.parse(ev[0].data).source).toBe("transcript");
});

test("a transcript whose last line is not a result event expires as before", async () => {
  const { taskId, step, runDir } = seed([assistant("Reading the spec"), userLine, assistant("Still working on it")]);
  testHooks.setLastTickStart(Date.now());
  await tick();
  const s = store.getStep(step.id)!;
  expect(s.status).toBe("failed");
  expect(s.error).toBe("lease expired: runner stopped heartbeating");
  expect(existsSync(join(runDir, "report.json"))).toBe(false);
  expect(recoveredEvents(taskId, step.id).length).toBe(0);
});

test("a truncated trailing result line is not recovered", async () => {
  const { taskId, step, runDir } = seed([assistant("Writing the plan"), `{"type":"result","subtype":"succ`]);
  testHooks.setLastTickStart(Date.now());
  await tick();
  const s = store.getStep(step.id)!;
  expect(s.status).toBe("failed");
  expect(s.error).toBe("lease expired: runner stopped heartbeating");
  expect(existsSync(join(runDir, "report.json"))).toBe(false);
  expect(recoveredEvents(taskId, step.id).length).toBe(0);
});

test("an existing report.json is applied and recorded with source report", async () => {
  const { taskId, step } = seed([assistant("Writing the plan")], { exit_code: 0, killed: null, result: JSON.parse(resultLine) });
  testHooks.setLastTickStart(Date.now());
  await tick();
  const s = store.getStep(step.id)!;
  expect(s.status).toBe("done");
  expect(s.cost_usd).toBe(2.738647);
  const ev = recoveredEvents(taskId, step.id);
  expect(ev.length).toBe(1);
  expect(JSON.parse(ev[0].data).source).toBe("report");
});
