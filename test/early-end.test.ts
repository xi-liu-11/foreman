import { test, expect, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `fm-early-${name}-`)));
const home = tmp("home");
process.env.FOREMAN_HOME = home;
// A herdr that always fails, so notifications neither reach the real herdr nor stall a tick.
const bin = tmp("bin");
writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 1\n");
chmodSync(join(bin, "herdr"), 0o755);
const savedPath = process.env.PATH;
process.env.PATH = `${bin}:${savedPath}`;
const { Store } = await import("../src/db");
const { route, cfg, endedEarly, EARLY_END_NOTE } = await import("../src/taskd");
const { DB_PATH } = await import("../src/config");
// Workers run with FOREMAN_HOME pointing at the live home; never seed that DB.
if (![tmpdir(), realpathSync(tmpdir())].some(d => DB_PATH.startsWith(d))) throw new Error(`refusing to run against ${DB_PATH}`);
const { pipelineFor } = await import("../src/pipelines");
import type { TaskRow, StepRow } from "../src/db";

// Same harness as plan-loop.test.ts: seed through a second Store, concurrency 0 so nothing is spawned.
const store = new Store();
const headers = { authorization: `Bearer ${cfg.server.token}`, "content-type": "application/json" };
const P = "early-end";
cfg.projects[P] = { name: P, path: home, base_branch: "main", verify: "inspect", speckit: false, deny: [], concurrency: 0, merge: "direct", merge_gate: true, squash: true, ticket_states: {}, resources: [], lease_max_minutes: 60 };
afterAll(() => {
  delete cfg.projects[P];
  process.env.PATH = savedPath;
});

const T0038 = "Test round 1 for T0038 is incomplete, so the verdict is fail: the Maestro suite was started in the background and had not reported.";
const T0039 = "The plan step is not finished. The harness asked for the result while the code survey was still running.";

test("endedEarly flags summaries that say work was still going", () => {
  for (const s of [T0038, T0039, "Waiting for the suite to finish.", "STILL RUNNING", "NOT FINISHED"]) expect(endedEarly(s)).toBe(true);
  for (const s of ["3 of 40 flows failed: login, signup, paywall", "", null, undefined, 42]) expect(endedEarly(s)).toBe(false);
});

const PIPELINE = pipelineFor("implement", false, { merge: "direct", merge_gate: true, tickets: false }).steps;
let tid = 0;
function running(): { task: TaskRow; step: StepRow } {
  const task = store.insertTask({
    id: `EE${++tid}`, project: P, kind: "implement", title: `early end ${tid}`, brief: "b", status: "running",
    pipeline: JSON.stringify(PIPELINE), current_step: "implement", priority: 0, branch: null, worktree: null,
    feature_dir: null, ticket: null, pr_url: null, qa_cycles: 0, result: null,
  });
  const step = store.insertStep({ task_id: task.id, name: "implement", role: "developer", status: "running", attempt: 1 });
  return { task, step };
}
async function report(body: object): Promise<StepRow> {
  const { step } = running();
  const res = await route(new Request(`http://x/steps/${step.id}/result`, { method: "POST", headers, body: JSON.stringify(body) }));
  expect(res.status).toBe(200);
  return store.getStep(step.id)!;
}
const result = (status: string, summary: string) =>
  ({ exit_code: 0, result: { structured_output: { status, verdict: "n/a", summary, notes_for_next: "", artifacts: [] } } });

test("a failed result that says work was still running is flagged, in the step and the event", async () => {
  const s = await report(result("failed", "Suite still running"));
  expect(s.status).toBe("failed");
  expect(s.error).toBe(`${EARLY_END_NOTE}: Suite still running`);
  expect(s.error).toBe("step ended early (work still running?): Suite still running");
  const ev = store.eventsForTask(s.task_id, 100).filter(e => e.type === "step.failed" && e.step_id === s.id);
  expect(ev.length).toBe(1);
  expect(JSON.parse(ev[0].data).error).toBe(s.error);
});

test("an ordinary failure keeps its summary as the error", async () => {
  const s = await report(result("failed", "2 flows failed"));
  expect(s.status).toBe("failed");
  expect(s.error).toBe("2 flows failed");
});

test("done and blocked results are never flagged", async () => {
  const done = await report(result("done", "incomplete docs noted"));
  expect(done.status).toBe("done");
  expect(done.error).toBeNull();
  const blocked = await report(result("blocked", "incomplete: which API key?"));
  expect(blocked.status).toBe("blocked");
  expect(blocked.error).toBeNull();
});

test("a killed step is not flagged", async () => {
  const s = await report({ killed: "timeout after 90 min", exit_code: 143, result: { structured_output: { status: "failed", verdict: "n/a", summary: "still running", notes_for_next: "", artifacts: [] } } });
  expect(s.status).toBe("failed");
  expect(s.error).toBe("timeout after 90 min");
});

// AS-7: the flag is a label only. A flagged failure retries and counts toward max_attempts like any other.
const { tick } = await import("../src/taskd");
async function waitFor(what: string, fn: () => boolean): Promise<void> {
  for (let i = 0; i < 150; i++) { if (fn()) return; await Bun.sleep(20); await tick(); }
  throw new Error(`timed out waiting for ${what}`);
}

test("a flagged failure retries and counts toward max_attempts like any other failure", async () => {
  const { task, step } = running();
  let s: StepRow = step;
  for (let attempt = 1; attempt <= cfg.defaults.max_attempts; attempt++) {
    if (s.status === "queued") store.updateStep(s.id, { status: "running" });
    const res = await route(new Request(`http://x/steps/${s.id}/result`, { method: "POST", headers, body: JSON.stringify(result("failed", T0038)) }));
    expect(res.status).toBe(200);
    expect(store.getStep(s.id)!.error).toBe(`${EARLY_END_NOTE}: ${T0038}`);
    if (attempt < cfg.defaults.max_attempts) {
      await waitFor(`attempt ${attempt + 1} queued`, () => { const l = store.latestStep(task.id, "implement"); return l?.attempt === attempt + 1 && l.status === "queued"; });
      expect(store.getTask(task.id)!.status).not.toBe("failed");
      s = store.latestStep(task.id, "implement")!;
    }
  }
  await waitFor("task failed", () => store.getTask(task.id)!.status === "failed");
  expect(store.stepsForTask(task.id).filter(x => x.name === "implement").length).toBe(cfg.defaults.max_attempts);
});
