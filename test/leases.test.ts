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

// ---------------------------------------------------------------- T0048 device lane

const DEV = (capacity: number): L.GroupsOf => p => p === "P" ? [{ name: "devices", members: ["ios-sim", "android-emu"], capacity }] : [];
const greq = (store: InstanceType<typeof Store>, t: TaskRow, s: StepRow, r: string, groupsOf: L.GroupsOf, expect_min: number | null = null) =>
  L.requestLease(store, t, s, r, null, [], { groupsOf, expect_min });
function mkTaskQa(store: InstanceType<typeof Store>, qa: number, status: TaskStatus = "running", priority = 0): TaskRow {
  const t = mkTask(store, "P", status);
  store.updateTask(t.id, { qa_cycles: qa, priority });
  return store.getTask(t.id)!;
}

test("AS-1 capacity 1: a free member waits while the lane is held", () => {
  const { store } = fresh();
  const g = DEV(1);
  const ta = mkTask(store, "P"), tb = mkTask(store, "P");
  const a = mkStep(store, ta), b = mkStep(store, tb);
  expect(greq(store, ta, a, "ios-sim", g)).toMatchObject({ granted: true, group: "devices" });
  expect(greq(store, tb, b, "android-emu", g)).toMatchObject({ granted: false, position: 1, queue: 1, group: "devices" });
  expect(greq(store, tb, b, "android-emu", g).holder?.task_id).toBe(ta.id);
  L.releaseLease(store, a, "ios-sim", "released", g);
  expect(greq(store, tb, b, "android-emu", g).granted).toBe(true);
  expect(events(store, "lease.granted").at(-1)!.data.group).toBe("devices");
});

test("AS-2 one slot per step: the holder takes a second member at once", () => {
  const { store } = fresh();
  const g = DEV(1);
  const ta = mkTask(store, "P"), tb = mkTask(store, "P");
  const a = mkStep(store, ta), b = mkStep(store, tb);
  greq(store, ta, a, "ios-sim", g);
  expect(greq(store, tb, b, "ios-sim", g).granted).toBe(false);
  expect(greq(store, ta, a, "android-emu", g).granted).toBe(true);
  L.releaseLease(store, a, "ios-sim", "released", g);
  expect(greq(store, tb, b, "ios-sim", g).granted).toBe(false); // a still holds android-emu
  L.releaseLease(store, a, "android-emu", "released", g);
  expect(greq(store, tb, b, "ios-sim", g).granted).toBe(true);
});

test("AS-3 capacity 2: two holders, the third waits; key exclusivity still applies", () => {
  const { store } = fresh();
  const g = DEV(2);
  const [ta, tb, tc] = [mkTask(store, "P"), mkTask(store, "P"), mkTask(store, "P")];
  const a = mkStep(store, ta), b = mkStep(store, tb), c = mkStep(store, tc);
  expect(greq(store, ta, a, "ios-sim", g).granted).toBe(true);
  expect(greq(store, tb, b, "android-emu", g).granted).toBe(true);
  expect(greq(store, tc, c, "ios-sim", g)).toMatchObject({ granted: false, position: 1 });
  L.releaseLease(store, b, "android-emu", "released", g);
  expect(greq(store, tc, c, "ios-sim", g).granted).toBe(false); // a holds ios-sim
  L.releaseLease(store, a, "ios-sim", "released", g);
  expect(greq(store, tc, c, "ios-sim", g).granted).toBe(true);
});

test("AS-4 capacity 2: two steps never hold the same resource", () => {
  const { store } = fresh();
  const g = DEV(2);
  const steps = [0, 1, 2, 3].map(() => { const t = mkTask(store, "P"); return { t, s: mkStep(store, t) }; });
  for (const { t, s } of steps) greq(store, t, s, "ios-sim", g);
  L.reconcileLeases(store, () => 45, g);
  expect(store.listLeases().filter(r => r.granted_at)).toHaveLength(1);
});

test("AS-5 grant order through the store, with positions", () => {
  const { store } = fresh();
  const g = DEV(1);
  const th = mkTaskQa(store, 0); const h = mkStep(store, th, { name: "implement" });
  greq(store, th, h, "ios-sim", g);
  const mk = (qa: number, name: string) => { const t = mkTaskQa(store, qa); return { t, s: mkStep(store, t, { name }) }; };
  const w = [mk(0, "implement"), mk(0, "test"), mk(2, "implement"), mk(1, "test")];
  for (const x of w) greq(store, x.t, x.s, "ios-sim", g);
  const pos = (i: number) => greq(store, w[i]!.t, w[i]!.s, "ios-sim", g).position;
  expect([pos(3), pos(1), pos(2), pos(0)]).toEqual([1, 2, 3, 4]);
  const leaseRow = store.leasesForStep(w[1]!.s.id)[0]!;
  expect(L.leaseView(store, leaseRow, g).position).toBe(2);
  const order: number[] = [];
  let holder = h;
  for (let k = 0; k < 4; k++) {
    L.releaseLease(store, holder, "ios-sim", "released", g);
    const i = w.findIndex(x => store.leasesForStep(x.s.id)[0]?.granted_at);
    order.push(i); holder = w[i]!.s;
  }
  expect(order).toEqual([3, 1, 2, 0]);
});

test("AS-11 expect_min: stored, updated, drives overdue and ETA", () => {
  const { store } = fresh();
  const g = DEV(1);
  const ta = mkTask(store, "P"), tb = mkTask(store, "P");
  const a = mkStep(store, ta), b = mkStep(store, tb);
  expect(greq(store, ta, a, "ios-sim", g, 25)).toMatchObject({ granted: true, expect_min: 25, expect_left_min: 25 });
  expect(store.leasesForStep(a.id)[0]!.expect_min).toBe(25);
  const wb = greq(store, tb, b, "android-emu", g, 10);
  expect(wb.eta_min).toBe(25);
  // Held 30 min: overdue at the expect (25), not the fallback (45).
  store.db.run("UPDATE resource_leases SET granted_at = ? WHERE step_id = ?", [new Date(Date.now() - 30 * 60_000).toISOString(), a.id]);
  L.reconcileLeases(store, () => 45, g);
  const ev = events(store, "lease.overdue");
  expect(ev).toHaveLength(1);
  expect(ev[0].data).toMatchObject({ max_min: 25, expected: true });
  expect(greq(store, tb, b, "android-emu", g).eta_min).toBe(0);
  // A new expect clears overdue_at and re-arms the check.
  greq(store, ta, a, "ios-sim", g, 60);
  const row = store.leasesForStep(a.id)[0]!;
  expect([row.expect_min, row.overdue_at]).toEqual([60, null]);
  L.reconcileLeases(store, () => 45, g);
  expect(events(store, "lease.overdue")).toHaveLength(1);
  expect(L.leaseView(store, store.leasesForStep(b.id)[0]!, g).eta_min).toBe(30);
});

test("AS-11 overdue falls back to lease_max_minutes without an expect", () => {
  const { store } = fresh();
  const t = mkTask(store, "P");
  const a = mkStep(store, t);
  greq(store, t, a, "ios-sim", DEV(1));
  store.db.run("UPDATE resource_leases SET granted_at = ? WHERE step_id = ?", [new Date(Date.now() - 30 * 60_000).toISOString(), a.id]);
  L.reconcileLeases(store, () => 45, DEV(1));
  expect(events(store, "lease.overdue")).toHaveLength(0);
  L.reconcileLeases(store, () => 20, DEV(1));
  expect(events(store, "lease.overdue")[0].data).toMatchObject({ max_min: 20, expected: false });
});

test("AS-13 an old-schema database opens and its lease rows load unchanged", () => {
  const { Database } = require("bun:sqlite");
  const path = join(mkdtempSync(join(tmpdir(), "fm-oldlease-")), "old.db");
  const db = new Database(path, { create: true });
  db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, brief TEXT NOT NULL, status TEXT NOT NULL, pipeline TEXT NOT NULL, current_step TEXT, priority INTEGER NOT NULL DEFAULT 5, branch TEXT, worktree TEXT, feature_dir TEXT, ticket TEXT, qa_cycles INTEGER NOT NULL DEFAULT 0, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE steps (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id), name TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, session_id TEXT, resume_prompt TEXT, workspace_id TEXT, tab_id TEXT, pane_id TEXT, machine TEXT, started_at TEXT, finished_at TEXT, lease_until TEXT, result TEXT, error TEXT, cost_usd REAL NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE resource_leases (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, machine TEXT NOT NULL, resource TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), step_id INTEGER NOT NULL REFERENCES steps(id), reason TEXT, requested_at TEXT NOT NULL, granted_at TEXT, overdue_at TEXT, UNIQUE (project, machine, resource, step_id));
    INSERT INTO tasks VALUES ('T0001','P','feature','t','b','running','[]',NULL,5,NULL,NULL,NULL,NULL,0,NULL,'2026-11-01T00:00:00Z','2026-11-01T00:00:00Z');
    INSERT INTO steps (task_id, name, role, status, attempt, created_at) VALUES ('T0001','implement','developer','running',1,'2026-11-01T00:00:00Z');
    INSERT INTO resource_leases (project, machine, resource, task_id, step_id, reason, requested_at, granted_at) VALUES ('P','local','ios-sim','T0001',1,'flows','2026-11-01T00:01:00Z','2026-11-01T00:02:00Z');`);
  db.close();
  const s = new Store(path);
  expect(s.listLeases()).toEqual([{ id: 1, project: "P", machine: "local", resource: "ios-sim", task_id: "T0001", step_id: 1, reason: "flows", requested_at: "2026-11-01T00:01:00Z", granted_at: "2026-11-01T00:02:00Z", overdue_at: null, expect_min: null }]);
  expect(L.leaseView(s, s.listLeases()[0]!, DEV(1))).toMatchObject({ state: "held", group: "devices", expect_min: null });
});

test("dispatchView: device-running count, laneBusy, stale queued rows excluded", () => {
  const { store } = fresh();
  const g = DEV(1);
  const proj = { device_steps: ["implement", "test"], device_steps_running: 2, resource_groups: g("P") };
  const ta = mkTask(store, "P"), tb = mkTask(store, "P");
  const a = mkStep(store, ta, { name: "implement" }), b = mkStep(store, tb, { name: "test" });
  mkStep(store, ta, { name: "plan" });
  const gated = mkTask(store, "P", "gate");
  mkStep(store, gated, { name: "test", status: "queued" });
  const tq = mkTaskQa(store, 1, "queued", 3);
  const q = mkStep(store, tq, { name: "test", status: "queued" });
  let v = L.dispatchView(store, "P", proj, 1);
  expect(v).toMatchObject({ freeSlots: 1, deviceRunning: 2, deviceLimit: 2, laneBusy: false, deviceSteps: ["implement", "test"] });
  expect(v.queued.map(c => c.step_id)).toEqual([q.id]);
  expect(v.queued[0]).toMatchObject({ name: "test", priority: 3, qa_cycles: 1, task_id: tq.id });
  greq(store, ta, a, "ios-sim", g);
  expect(L.dispatchView(store, "P", proj, 1).laneBusy).toBe(false);
  greq(store, tb, b, "android-emu", g);
  expect(L.dispatchView(store, "P", proj, 1).laneBusy).toBe(true);
  expect(L.dispatchView(store, "P", { ...proj, resource_groups: [] }, 1).laneBusy).toBe(false);
});

test("laneViews and laneStatusForTask", () => {
  const { store } = fresh();
  const g = DEV(1);
  expect(L.laneViews(store, g, ["P", "Q"])).toEqual([{ project: "P", machine: "local", group: "devices", capacity: 1, members: ["ios-sim", "android-emu"], holders: [], waiters: [] }]);
  const ta = mkTask(store, "P"), tb = mkTask(store, "P");
  const a = mkStep(store, ta, { name: "implement" }), b = mkStep(store, tb, { name: "test" });
  greq(store, ta, a, "ios-sim", g, 20); greq(store, ta, a, "android-emu", g);
  greq(store, tb, b, "ios-sim", g, 15);
  const [lane] = L.laneViews(store, g, ["P"], () => 45);
  expect(lane!.holders).toHaveLength(1);
  expect(lane!.holders[0]).toMatchObject({ task_id: ta.id, step: "implement", resources: ["ios-sim", "android-emu"], expect_min: 20, expect_left_min: 20, overdue: false });
  expect(lane!.waiters).toEqual([expect.objectContaining({ task_id: tb.id, step: "test", resource: "ios-sim", position: 1, expect_min: 15, eta_min: 20 })]);
  expect(L.laneStatusForTask(store, tb.id, g)).toEqual({ position: 1, of: 1 });
  expect(L.laneStatusForTask(store, ta.id, g)).toBeNull();
});

test("devicePrompt: lane guidance", () => {
  const plain = L.devicePrompt(["android-emu", "ios-sim"], "developer");
  const grouped = L.devicePrompt(["android-emu", "ios-sim"], "developer", [{ name: "devices", members: ["android-emu", "ios-sim"], capacity: 1 }]);
  for (const p of [plain, grouped]) {
    const low = p.toLowerCase();
    expect(p).toContain("--expect");
    expect(p).toContain("--wait 540");
    expect(p).toContain("code 3");
    expect(low).toContain("alphabetical");
    expect(low).toContain("shut it down");
    expect(low).toContain("never kill");
  }
  expect(plain).not.toContain("device lane with capacity");
  expect(grouped).toContain("`android-emu` and `ios-sim` form one device lane with capacity 1");
  expect(L.devicePrompt(["ios-sim"], "architect", [{ name: "d", members: ["ios-sim"], capacity: 1 }])).toBe("");
});
