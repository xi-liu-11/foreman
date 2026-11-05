import { test, expect, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `fm-stall-${name}-`)));
const home = tmp("home");
process.env.FOREMAN_HOME = home;
const bin = tmp("bin");
writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 1\n");
chmodSync(join(bin, "herdr"), 0o755);
const savedPath = process.env.PATH;
process.env.PATH = `${bin}:${savedPath}`;
const { Store } = await import("../src/db");
const { tick, cfg, testHooks } = await import("../src/taskd");
const { DB_PATH } = await import("../src/config");
if (![tmpdir(), realpathSync(tmpdir())].some(d => DB_PATH.startsWith(d))) throw new Error(`refusing to run against ${DB_PATH}`);
const { pipelineFor } = await import("../src/pipelines");
import type { StepRow } from "../src/db";

const store = new Store();
const P = "stall-t";
cfg.projects[P] = { name: P, path: home, base_branch: "main", verify: "inspect", speckit: false, deny: [], concurrency: 0, merge: "direct", merge_gate: true, squash: true, ticket_states: {}, resources: [], lease_max_minutes: 60 };
afterAll(() => {
  delete cfg.projects[P];
  testHooks.setLastTickStart(Date.now());
  process.env.PATH = savedPath;
});

const PIPELINE = pipelineFor("implement", false, { merge: "direct", merge_gate: true, tickets: false }).steps;
let n = 0;
function seed(): StepRow {
  const task = store.insertTask({
    id: `ST${++n}`, project: P, kind: "implement", title: `stall ${n}`, brief: "b", status: "running",
    pipeline: JSON.stringify(PIPELINE), current_step: "implement", priority: 0, branch: null, worktree: null,
    feature_dir: null, ticket: null, pr_url: null, qa_cycles: 0, result: null,
  });
  const step = store.insertStep({ task_id: task.id, name: "implement", role: "developer", status: "running", attempt: 1 });
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  store.updateStep(step.id, {
    launch_started_at: ago(120_000), launched_at: ago(119_000), runner_seen_at: ago(60_000), lease_until: ago(30_000),
  });
  return store.getStep(step.id)!;
}
const stallEvents = () =>
  (store as any).db.query("SELECT * FROM events WHERE type = 'taskd.stall' ORDER BY id DESC").all() as { id: number; task_id: string | null; data: string }[];

test("a long tick gap extends leases instead of expiring them, and records taskd.stall", async () => {
  const s = seed();
  const before = stallEvents()[0]?.id ?? 0;
  testHooks.setLastTickStart(Date.now() - 600_000);
  const t0 = Date.now();
  await tick();
  const after = store.getStep(s.id)!;
  expect(after.status).toBe("running");
  const until = Date.parse(after.lease_until!);
  // Old lease (now-30s) + ~600s gap = ~now+570s.
  expect(Math.abs(until - (t0 + 570_000))).toBeLessThan(5_000);
  const ev = stallEvents()[0];
  expect(ev.id).toBeGreaterThan(before);
  expect(ev.task_id).toBeNull();
  const data = JSON.parse(ev.data);
  expect(Math.abs(data.gap_sec - 600)).toBeLessThanOrEqual(3);
  expect(data.extended).toBeGreaterThanOrEqual(1);
});

test("control: a normal tick gap still expires the lease", async () => {
  const s = seed();
  testHooks.setLastTickStart(Date.now() - 2000);
  await tick();
  const after = store.getStep(s.id)!;
  expect(after.status).toBe("failed");
  expect(after.error).toBe("lease expired: runner stopped heartbeating");
  testHooks.setLastTickStart(Date.now());
});
