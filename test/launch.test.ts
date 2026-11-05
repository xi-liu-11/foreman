// T0054: lease armed after launch, async launch, never-started accounting, runner check-in.
// Covers AS-1, AS-2, AS-3, AS-4, AS-5, AS-7, AS-8 against a stub `herdr` on PATH.
import { test, expect, beforeEach, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `fm-launch-${name}-`)));
const home = tmp("home");
process.env.FOREMAN_HOME = home;
const bin = tmp("bin");
const herdrLog = join(tmp("log"), "herdr.log");
writeFileSync(herdrLog, "");
writeFileSync(join(bin, "herdr"), `#!/bin/sh
echo "$@" >> "$HERDR_LOG"
case "$1 $2" in
  "workspace list") echo '{"result":{"workspaces":[{"label":"fm:launch-t","workspace_id":"w1"}]}}' ;;
  "tab create")
    if [ -n "$HERDR_TAB_EXIT" ]; then echo "boom" >&2; exit "$HERDR_TAB_EXIT"; fi
    sleep \${HERDR_TAB_SLEEP:-0}
    echo '{"result":{"tab":{"tab_id":"t1"},"root_pane":{"pane_id":"p1"}}}' ;;
  *) exit 0 ;;
esac
`);
chmodSync(join(bin, "herdr"), 0o755);
const savedPath = process.env.PATH;
process.env.PATH = `${bin}:${savedPath}`;
process.env.HERDR_LOG = herdrLog;
const { Store } = await import("../src/db");
const { route, cfg, tick, testHooks } = await import("../src/taskd");
const { DB_PATH } = await import("../src/config");
if (![tmpdir(), realpathSync(tmpdir())].some(d => DB_PATH.startsWith(d))) throw new Error(`refusing to run against ${DB_PATH}`);
import type { TaskRow, StepRow } from "../src/db";

const store = new Store();
const headers = { authorization: `Bearer ${cfg.server.token}`, "content-type": "application/json" };
const P = "launch-t";
const proj = { name: P, path: home, base_branch: "main", verify: "inspect", speckit: false, deny: [], concurrency: 50, merge: "direct", merge_gate: true, squash: true, ticket_states: {}, resources: [], resource_groups: [], device_steps: [], device_steps_running: 51, lease_max_minutes: 60 } as any;
cfg.projects[P] = proj;
const D = cfg.defaults;
const saved = { lease_sec: D.lease_sec, launch_grace_sec: D.launch_grace_sec, launch_attempts_max: D.launch_attempts_max, concurrency: D.concurrency, max_attempts: D.max_attempts };
D.concurrency = 1000;
testHooks.setHerdrOk(true);

const PIPELINE = JSON.stringify([{ type: "agent", name: "plan", role: "architect", prompt: "plan" }]);
const created: string[] = [];
let tid = 0;

// Close every task of ours so a test's leftovers (and the background ticks they trigger) cannot touch the next test.
function closeAll() {
  for (const id of created) {
    for (const s of store.stepsForTask(id)) if (s.status === "running" || s.status === "queued") store.updateStep(s.id, { status: "failed", finished_at: new Date().toISOString(), error: "test cleanup", runner_seen_at: "x" });
    store.updateTask(id, { status: "failed" });
  }
}

beforeEach(() => {
  closeAll();
  Object.assign(D, saved, { concurrency: 1000 });
  proj.concurrency = 50;
  delete process.env.HERDR_TAB_EXIT;
  delete process.env.HERDR_TAB_SLEEP;
  writeFileSync(herdrLog, "");
});
afterAll(() => {
  closeAll();
  Object.assign(D, saved);
  delete cfg.projects[P];
  testHooks.setHerdrOk(false);
  process.env.PATH = savedPath;
});

function seedTask(status = "queued"): TaskRow {
  const task = store.insertTask({
    id: `LT${++tid}`, project: P, kind: "research", title: `launch ${tid}`, brief: "b", status,
    pipeline: PIPELINE, current_step: "plan", priority: 0, branch: null, worktree: null,
    feature_dir: null, ticket: null, pr_url: null, qa_cycles: 0, result: null,
  } as any);
  created.push(task.id);
  return task;
}
const seedStep = (task: TaskRow, status: string, attempt = 1, extra: Partial<StepRow> = {}): StepRow => {
  const s = store.insertStep({ task_id: task.id, name: "plan", role: "architect", status: status as any, attempt });
  if (Object.keys(extra).length) store.updateStep(s.id, extra);
  return store.getStep(s.id)!;
};
const freshTick = async () => { testHooks.setLastTickStart(Date.now()); await tick(); };
const events = (stepId: number, type: string) => store.db.query("SELECT * FROM events WHERE step_id = ? AND type = ?").all(stepId, type) as any[];
const taskEvents = (taskId: string, type: string) => store.db.query("SELECT * FROM events WHERE task_id = ? AND type = ?").all(taskId, type) as any[];
const ms = (iso: string | null) => Date.parse(iso!);
const logText = () => readFileSync(herdrLog, "utf8");
const attempts = (task: TaskRow) => store.stepsForTask(task.id).filter(s => s.name === "plan");

test("AS-1: a slow launch keeps its step running and arms the lease after the launch returns", async () => {
  D.lease_sec = 1; D.launch_grace_sec = 30;
  process.env.HERDR_TAB_SLEEP = "2";
  const task = seedTask();
  const step = seedStep(task, "queued");
  const t0 = Date.now();
  await freshTick();
  let s = store.getStep(step.id)!;
  expect(s.status).toBe("running");
  expect(s.launch_started_at).not.toBeNull();
  expect(s.launched_at).toBeNull();
  // Launch deadline, not the 1 s heartbeat lease.
  expect(ms(s.lease_until) - t0).toBeGreaterThan(25_000);
  await Bun.sleep(1300); // longer than lease_sec, still inside the grace
  await freshTick();
  expect(store.getStep(step.id)!.status).toBe("running");
  await testHooks.launchesSettled();
  s = store.getStep(step.id)!;
  expect(s.status).toBe("running");
  expect(s.launched_at).not.toBeNull();
  expect(s.tab_id).toBe("t1");
  expect(Math.abs(ms(s.lease_until) - (ms(s.launched_at) + 1000))).toBeLessThan(300);
  expect(s.error).toBeNull();
  expect(events(step.id, "step.started").length).toBe(1);
  expect(events(step.id, "step.lease_expired").length).toBe(0);
});

test("AS-2: a tick does not wait for a slow launch and can expire another step's lease", async () => {
  D.lease_sec = 150;
  process.env.HERDR_TAB_SLEEP = "2";
  const other = seedTask("failed");
  const stale = seedStep(other, "running", 1, { launch_started_at: new Date(Date.now() - 60_000).toISOString(), launched_at: new Date(Date.now() - 59_000).toISOString(), runner_seen_at: new Date(Date.now() - 50_000).toISOString(), lease_until: new Date(Date.now() - 5_000).toISOString() });
  const task = seedTask();
  const step = seedStep(task, "queued");
  const t0 = Date.now();
  await freshTick();
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(store.getStep(step.id)!.status).toBe("running");
  expect(store.getStep(step.id)!.launched_at).toBeNull();
  expect(store.getStep(stale.id)!.status).toBe("failed");
  expect(store.getStep(stale.id)!.error).toBe("lease expired: runner stopped heartbeating");
  await testHooks.launchesSettled();
  expect(store.getStep(step.id)!.launched_at).not.toBeNull();
});

test("AS-3: a launch that outlives launch_grace_sec fails as never started; the late tab is closed", async () => {
  D.launch_grace_sec = 1;
  process.env.HERDR_TAB_SLEEP = "2";
  const task = seedTask();
  const step = seedStep(task, "queued");
  await freshTick();
  proj.concurrency = 0; // keep the follow-up attempt queued
  await Bun.sleep(1200);
  await freshTick();
  const s = store.getStep(step.id)!;
  expect(s.status).toBe("failed");
  expect(s.error).toBe("runner never started: launch timed out after 1s");
  expect(events(step.id, "step.never_started").length).toBe(1);
  expect(JSON.parse(events(step.id, "step.never_started")[0].data).error).toBe(s.error);
  expect(events(step.id, "step.lease_expired").length).toBe(0);
  await testHooks.launchesSettled();
  for (let i = 0; i < 40 && !logText().includes("tab close t1"); i++) await Bun.sleep(50);
  expect(logText()).toContain("tab close t1");
  const after = store.getStep(step.id)!;
  expect(after.status).toBe("failed");
  expect(after.tab_id).toBeNull();
  expect(events(step.id, "step.started").length).toBe(0);
});

test("AS-4: never-started attempts relaunch with the same session and prompt, are bounded, and are not counted", async () => {
  proj.concurrency = 0; // the relaunched attempt stays queued
  D.max_attempts = 3; D.launch_attempts_max = 3;
  const task = seedTask("running");
  const NS = "runner never started: herdr tab create failed (1): boom";
  const fail = (s: StepRow) => store.updateStep(s.id, { status: "failed", error: NS, finished_at: new Date().toISOString() });
  const first = seedStep(task, "failed", 1, { error: NS, session_id: "sess1", resume_prompt: "[user-retry] do X" });
  await freshTick();
  let a = attempts(task);
  expect(a.length).toBe(2);
  expect(a[1]).toMatchObject({ attempt: 2, status: "queued", session_id: "sess1", resume_prompt: "do X" });
  expect(store.getTask(task.id)!.status).not.toBe("failed");
  fail(a[1]);
  await freshTick();
  a = attempts(task);
  expect(a.length).toBe(3);
  expect(a[2]).toMatchObject({ attempt: 3, status: "queued", session_id: "sess1", resume_prompt: "do X" });
  expect(store.getTask(task.id)!.status).not.toBe("failed");
  fail(a[2]);
  await freshTick();
  const t = store.getTask(task.id)!;
  expect(t.status).toBe("failed");
  expect(JSON.parse(t.result!).error).toStartWith("step 'plan' could not start a runner 3 times: runner never started");
  expect(attempts(task).length).toBe(3);
  expect(first.status).toBe("failed");

  // One real failure plus two never-started failures is not three counted failures.
  const t2 = seedTask("running");
  seedStep(t2, "failed", 1, { error: "claude exited 1", finished_at: new Date().toISOString() });
  seedStep(t2, "failed", 2, { error: NS, finished_at: new Date().toISOString() });
  seedStep(t2, "failed", 3, { error: NS, finished_at: new Date().toISOString() });
  await freshTick();
  expect(store.getTask(t2.id)!.status).not.toBe("failed");
  const a2 = attempts(t2);
  expect(a2.length).toBe(4);
  expect(a2[3]).toMatchObject({ attempt: 4, status: "queued" });
});

test("AS-5: a herdr failure fails the step as never started and is not counted", async () => {
  D.max_attempts = 1; // a counted failure would fail the task at once
  process.env.HERDR_TAB_EXIT = "1";
  const task = seedTask();
  const step = seedStep(task, "queued");
  await freshTick();
  proj.concurrency = 0; // hold the relaunch
  await testHooks.launchesSettled();
  const s = store.getStep(step.id)!;
  expect(s.status).toBe("failed");
  expect(s.error).toStartWith("runner never started: herdr tab create");
  expect(s.error).toContain("failed (1): boom");
  expect(s.runner_seen_at).toBeNull();
  expect(events(step.id, "step.never_started").length).toBe(1);
  expect(events(step.id, "step.launch_failed").length).toBe(1);
  await freshTick();
  expect(store.getTask(task.id)!.status).not.toBe("failed");
  const a = attempts(task);
  expect(a.length).toBe(2);
  expect(a[1]).toMatchObject({ attempt: 2, status: "queued" });
});

test("AS-7: a heartbeat during launch arms the lease; a later expiry is 'stopped heartbeating' and counted", async () => {
  D.lease_sec = 2; D.max_attempts = 1;
  process.env.HERDR_TAB_SLEEP = "1";
  const task = seedTask();
  const step = seedStep(task, "queued");
  await freshTick();
  proj.concurrency = 0;
  expect(store.getStep(step.id)!.runner_seen_at).toBeNull();
  const before = Date.now();
  const res = await route(new Request(`http://x/steps/${step.id}/heartbeat`, { method: "POST", headers, body: "{}" }));
  expect(res.status).toBe(200);
  expect((await res.json() as any).cancel).toBe(false);
  let s = store.getStep(step.id)!;
  expect(s.runner_seen_at).not.toBeNull();
  expect(ms(s.runner_seen_at)).toBeGreaterThanOrEqual(before - 5);
  expect(Math.abs(ms(s.lease_until) - (ms(s.runner_seen_at) + 2000))).toBeLessThan(300);
  await testHooks.launchesSettled();
  expect(store.getStep(step.id)!.status).toBe("running");
  await Bun.sleep(2300);
  await freshTick();
  s = store.getStep(step.id)!;
  expect(s.status).toBe("failed");
  expect(s.error).toBe("lease expired: runner stopped heartbeating");
  expect(events(step.id, "step.lease_expired").length).toBe(1);
  expect(events(step.id, "step.never_started").length).toBe(0);
  // Counted: with max_attempts 1 the task fails.
  expect(store.getTask(task.id)!.status).toBe("failed");
  expect(JSON.parse(store.getTask(task.id)!.result!).error).toStartWith("step 'plan' failed 1 times: lease expired");
  expect(taskEvents(task.id, "task.failed").length).toBe(1);
});

test("AS-8: a launch that returns but never checks in fails as never started and is not counted", async () => {
  D.lease_sec = 1; D.max_attempts = 1;
  const task = seedTask();
  const step = seedStep(task, "queued");
  await freshTick();
  await testHooks.launchesSettled();
  proj.concurrency = 0;
  let s = store.getStep(step.id)!;
  expect(s.status).toBe("running");
  expect(s.launched_at).not.toBeNull();
  await Bun.sleep(1200);
  await freshTick();
  s = store.getStep(step.id)!;
  expect(s.status).toBe("failed");
  expect(s.error).toMatch(/^runner never started: no check-in within 1s of launch \(launch took \d+s\)$/);
  expect(events(step.id, "step.never_started").length).toBe(1);
  expect(events(step.id, "step.lease_expired").length).toBe(0);
  expect(store.getTask(task.id)!.status).not.toBe("failed");
  expect(attempts(task).length).toBe(2);
  expect(attempts(task)[1].status).toBe("queued");
});

// --- Added by T0054 test round 1: gaps F2 from review round 1 ---

test("AS-6 through taskd: a hanging tab create fails the step as 'runner never started: herdr tab create timed out after 1s'", async () => {
  const { setTimeoutSec } = await import("../src/herdr");
  D.max_attempts = 1;
  process.env.HERDR_TAB_SLEEP = "5";
  setTimeoutSec(1);
  try {
    const task = seedTask();
    const step = seedStep(task, "queued");
    const t0 = Date.now();
    await freshTick();
    proj.concurrency = 0; // hold the relaunch
    await testHooks.launchesSettled();
    expect(Date.now() - t0).toBeLessThan(3000);
    const s = store.getStep(step.id)!;
    expect(s.status).toBe("failed");
    expect(s.error).toBe("runner never started: herdr tab create timed out after 1s");
    expect(events(step.id, "step.never_started").length).toBe(1);
    await freshTick();
    expect(store.getTask(task.id)!.status).not.toBe("failed"); // not counted against max_attempts = 1
  } finally {
    setTimeoutSec(cfg.defaults.herdr_timeout_sec);
  }
});

test("AS-7 task show: running steps print 'runner seen … ago' or 'runner not seen yet (launch started … ago)'", async () => {
  const server = Bun.serve({ port: 0, fetch: req => route(req) });
  try {
    const task = seedTask("running");
    const seen = seedStep(task, "running", 1, { started_at: new Date(Date.now() - 90_000).toISOString(), launch_started_at: new Date(Date.now() - 90_000).toISOString(), runner_seen_at: new Date(Date.now() - 5_000).toISOString(), lease_until: new Date(Date.now() + 600_000).toISOString() });
    const show = async () => {
      const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^FOREMAN_(TASK|STEP|STEP_NAME|RUN_DIR)$/.test(k)));
      const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "show", task.id], {
        env: { ...base, FOREMAN_URL: server.url.origin, FOREMAN_TOKEN: cfg.server.token, FOREMAN_CLI_NAME: "task", FOREMAN_HOME: home },
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(code).toBe(0);
      return stdout + stderr;
    };
    let out = await show();
    expect(out).toMatch(/\n {6}runner seen \S+ ago\n/);
    expect(out).not.toContain("runner not seen yet");
    store.updateStep(seen.id, { runner_seen_at: null } as any);
    out = await show();
    expect(out).toMatch(/\n {6}runner not seen yet \(launch started \S+ ago\)/);
    store.updateStep(seen.id, { status: "done", finished_at: new Date().toISOString() } as any);
    out = await show();
    expect(out).not.toMatch(/runner (seen|not seen)/);
  } finally {
    server.stop(true);
  }
});
