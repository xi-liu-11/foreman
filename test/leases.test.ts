import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOREMAN_HOME = mkdtempSync(join(tmpdir(), "fm-leases-"));
const { Store } = await import("../src/db");
const L = await import("../src/leases");
const { deviceResources } = await import("../src/config");
import type { StepRow, TaskRow, StepStatus, TaskStatus } from "../src/db";
import type { ProjectConfig } from "../src/config";

let n = 0;
const fresh = () => {
  const path = join(mkdtempSync(join(tmpdir(), "fm-leasedb-")), "t.db");
  return { store: new Store(path), path };
};
let tid = 0;
function mkTask(store: InstanceType<typeof Store>, project: string, status: TaskStatus = "running"): TaskRow {
  return store.insertTask({
    id: `T${String(++tid).padStart(4, "0")}`, project, kind: "feature", title: "t", brief: "b", status,
    pipeline: "[]", current_step: null, priority: 0, branch: null, worktree: null, feature_dir: null,
    ticket: null, pr_url: null, qa_cycles: 0, result: null,
  });
}
function mkStep(store: InstanceType<typeof Store>, task: TaskRow, o: { machine?: string | null; status?: StepStatus; name?: string; role?: string } = {}): StepRow {
  return store.insertStep({ task_id: task.id, name: o.name ?? `s${++n}`, role: o.role ?? "developer", status: o.status ?? "running", attempt: 1, machine: o.machine ?? null });
}
const events = (store: InstanceType<typeof Store>, type: string) =>
  (store.db.query("SELECT * FROM events WHERE type = ? ORDER BY id").all(type) as any[]).map(e => ({ ...e, data: JSON.parse(e.data) }));
const REQ = "ios-sim";
const req = (store: InstanceType<typeof Store>, t: TaskRow, s: StepRow, r = REQ, declared: string[] = []) => L.requestLease(store, t, s, r, null, declared);

test("grant order and queue positions", () => {
  const { store } = fresh();
  const t = mkTask(store, "P");
  const [a, b, c] = [mkStep(store, t), mkStep(store, t), mkStep(store, t)];
  const sa = req(store, t, a), sb = req(store, t, b), sc = req(store, t, c);
  expect([sa.granted, sa.position]).toEqual([true, 0]);
  expect([sb.granted, sb.position]).toEqual([false, 1]);
  expect([sc.granted, sc.position]).toEqual([false, 2]);
  expect(L.releaseLease(store, a, REQ).released).toBe(true);
  expect(req(store, t, b).granted).toBe(true);
  expect(req(store, t, c)).toMatchObject({ granted: false, position: 1 });
  L.releaseLease(store, b, REQ);
  expect(req(store, t, c).granted).toBe(true);
  expect(events(store, "lease.requested")).toHaveLength(3);
  expect(events(store, "lease.granted")).toHaveLength(3);
  const rel = events(store, "lease.released");
  expect(rel).toHaveLength(2);
  for (const e of rel) { expect(e.data.held_sec).toBeGreaterThanOrEqual(0); expect(e.data.why).toBe("released"); }
});

test("re-entrant requests", () => {
  const { store } = fresh();
  const t = mkTask(store, "P");
  const [a, b] = [mkStep(store, t), mkStep(store, t)];
  req(store, t, a); req(store, t, b);
  const rows = store.listLeases().length, evs = store.db.query("SELECT COUNT(*) c FROM events").get() as any;
  expect(req(store, t, a).granted).toBe(true);
  expect(store.listLeases()).toHaveLength(rows);
  expect(req(store, t, b)).toMatchObject({ granted: false, position: 1 });
  expect((store.db.query("SELECT COUNT(*) c FROM events").get() as any).c).toBe(evs.c);
  expect(req(store, t, a, "android-emu").granted).toBe(true);
  expect(store.leasesForStep(a.id).filter(r => r.granted_at)).toHaveLength(2);
});

function setup2(opts: { taskStatus?: TaskStatus } = {}) {
  const { store } = fresh();
  const t = mkTask(store, "P", opts.taskStatus);
  const a = mkStep(store, t), b = mkStep(store, t);
  req(store, t, a); req(store, t, a, "android-emu"); req(store, t, b);
  req(store, t, b, "android-emu");
  return { store, t, a, b };
}
function checkReleased(store: InstanceType<typeof Store>, a: StepRow, b: StepRow, why: string) {
  expect(store.leasesForStep(a.id)).toHaveLength(0);
  const rel = events(store, "lease.released").filter(e => e.step_id === a.id);
  expect(rel).toHaveLength(2);
  for (const e of rel) expect(e.data.why).toBe(why);
  expect(store.leasesForStep(b.id).every(r => r.granted_at)).toBe(true);
  expect(store.leasesForStep(b.id)).toHaveLength(2);
}

for (const status of ["done", "failed", "blocked"] as const) {
  test(`auto-release when step ${status}`, () => {
    const { store, a, b } = setup2();
    expect(store.leasesForStep(a.id)).toHaveLength(2);
    store.updateStep(a.id, { status });
    expect(L.releaseStepLeases(store, a.id, `step ${status}`)).toBe(2);
    checkReleased(store, a, b, `step ${status}`);
  });
}

test("auto-release on explicit heartbeat expiry", () => {
  const { store, a, b } = setup2();
  store.updateStep(a.id, { status: "failed", error: "lease expired" });
  L.releaseStepLeases(store, a.id, "heartbeat lease expired");
  checkReleased(store, a, b, "heartbeat lease expired");
});

test("heartbeat expiry swept by reconcile", () => {
  const { store, a, b } = setup2();
  store.updateStep(a.id, { status: "failed", error: "lease expired" });
  L.reconcileLeases(store, () => 45);
  checkReleased(store, a, b, "swept");
});

for (const ts of ["cancelled", "failed"] as const) {
  test(`task ${ts} while step still running`, () => {
    const x = setup2();
    x.store.updateTask(x.t.id, { status: ts });
    L.releaseStepLeases(x.store, x.a.id, `task ${ts}`);
    expect(x.store.leasesForStep(x.a.id)).toHaveLength(0);
    expect(events(x.store, "lease.released").filter(e => e.step_id === x.a.id).every(e => e.data.why === `task ${ts}`)).toBe(true);
    expect(x.store.leasesForStep(x.b.id).every(r => r.granted_at)).toBe(true);
  });
  test(`reconcile sweeps when task ${ts}`, () => {
    const x = setup2();
    x.store.updateTask(x.t.id, { status: ts });
    L.reconcileLeases(x.store, () => 45);
    expect(x.store.listLeases()).toHaveLength(0);
    expect(events(x.store, "lease.released").every(e => e.data.why === "swept")).toBe(true);
  });
}

test("parallel QA: blocked step swept, running sibling keeps its lease", () => {
  const { store } = fresh();
  const t = mkTask(store, "P", "blocked");
  const s1 = mkStep(store, t, { status: "blocked" }), s2 = mkStep(store, t);
  store.insertLease({ project: "P", machine: "local", resource: "android-emu", task_id: t.id, step_id: s1.id, reason: null });
  store.grantLease(store.leasesForStep(s1.id)[0].id);
  req(store, t, s2);
  L.reconcileLeases(store, () => 45);
  expect(store.leasesForStep(s1.id)).toHaveLength(0);
  const kept = store.leasesForStep(s2.id);
  expect(kept).toHaveLength(1);
  expect(kept[0].granted_at).toBeTruthy();
});

test("restart: state visible from a second Store", () => {
  const { store, path } = fresh();
  const t = mkTask(store, "P");
  const [a, b] = [mkStep(store, t), mkStep(store, t)];
  req(store, t, a); req(store, t, b);
  const s2 = new Store(path);
  const rows = s2.leasesForKey("P", "local", REQ);
  expect(rows.map(r => [r.step_id, Boolean(r.granted_at)])).toEqual([[a.id, true], [b.id, false]]);
  const before = events(s2, "lease.granted").length;
  L.reconcileLeases(s2, () => 45);
  expect(events(s2, "lease.granted")).toHaveLength(before);
  expect(s2.leasesForKey("P", "local", REQ).filter(r => r.granted_at)).toHaveLength(1);
});

test("scoping by project and machine", () => {
  const { store } = fresh();
  const tp = mkTask(store, "P"), tq = mkTask(store, "Q");
  const a = mkStep(store, tp), b = mkStep(store, tp, { machine: "mini" }), c = mkStep(store, tq), d = mkStep(store, tp);
  expect(req(store, tp, a).granted).toBe(true);
  expect(req(store, tp, b).granted).toBe(true);
  expect(req(store, tq, c).granted).toBe(true);
  expect(req(store, tp, d)).toMatchObject({ granted: false, position: 1, queue: 1 });
});

test("overdue is flagged once and lease is kept", () => {
  const { store } = fresh();
  const t = mkTask(store, "P");
  const a = mkStep(store, t);
  req(store, t, a);
  const back = new Date(Date.now() - 50 * 60_000).toISOString();
  store.db.run("UPDATE resource_leases SET granted_at = ? WHERE step_id = ?", [back, a.id]);
  L.reconcileLeases(store, () => 45);
  const ev = events(store, "lease.overdue");
  expect(ev).toHaveLength(1);
  expect(ev[0].data.held_min).toBeGreaterThanOrEqual(45);
  expect(ev[0].data.max_min).toBe(45);
  expect(store.leasesForStep(a.id)[0].granted_at).toBeTruthy();
  L.reconcileLeases(store, () => 45);
  expect(events(store, "lease.overdue")).toHaveLength(1);
});

test("undeclared resource name warns but is granted", () => {
  const { store } = fresh();
  const t = mkTask(store, "P");
  const [a, b] = [mkStep(store, t), mkStep(store, t)];
  const s = req(store, t, a, "ios-sm", ["ios-sim"]);
  expect(s.warning).toContain("ios-sm");
  expect(s.granted).toBe(true);
  expect(events(store, "lease.requested")[0].data.undeclared).toBe(true);
  expect(req(store, t, b, "ios-sm", []).warning).toBeUndefined();
});

const cfg = (o: Partial<ProjectConfig>): ProjectConfig => ({
  name: "p", path: "/tmp/p", base_branch: "main", verify: "tests", speckit: false, deny: [], concurrency: 1,
  merge: "pr", merge_gate: true, squash: true, ticket_states: {}, resources: [], lease_max_minutes: 45, ...o,
});

test("devicePrompt", () => {
  const both = L.devicePrompt(deviceResources(cfg({ resources: ["ios-sim", "android-emu"] })), "developer");
  expect(both).toContain("ios-sim");
  expect(both).toContain("android-emu");
  expect(L.devicePrompt(deviceResources(cfg({ verify: "browser" })), "test-analyst")).toContain("browser");
  expect(L.devicePrompt(deviceResources(cfg({ resources: ["ios-sim"] })), "architect")).toBe("");
  expect(L.devicePrompt(deviceResources(cfg({ verify: "tests" })), "test-analyst")).toBe("");
});
