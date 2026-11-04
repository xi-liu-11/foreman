import { test, expect, spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FOREMAN_HOME = mkdtempSync(join(tmpdir(), "fm-lane-"));
const { parseLane } = await import("../src/config");
import { orderWaiters, laneEta, dispatchVerdict, stepClassRank, type Waiter, type DispatchCandidate, type DispatchView } from "../src/lane";

const quiet = () => spyOn(console, "warn").mockImplementation(() => {});

// ---------------------------------------------------------------- parseLane

test("parseLane: no groups gives [] and concurrency", () => {
  expect(parseLane({}, "projects.p", ["ios-sim"], 3)).toEqual({ resource_groups: [], device_steps: [], device_steps_running: 3, resources: ["ios-sim"] });
});

test("parseLane: defaults with a group", () => {
  const r = parseLane({ resource_groups: { devices: { members: ["ios-sim", "android-emu"], capacity: 1 } } }, "projects.p", ["ios-sim", "android-emu"], 3);
  expect(r.resource_groups).toEqual([{ name: "devices", members: ["ios-sim", "android-emu"], capacity: 1 }]);
  expect(r.device_steps).toEqual(["implement", "test"]);
  expect(r.device_steps_running).toBe(2);
  expect(r.resources).toEqual(["ios-sim", "android-emu"]);
});

test("parseLane: inline table and sub-table give the same result", () => {
  const inline = Bun.TOML.parse(`[projects.p]\nresources = ["a"]\nresource_groups = { lane = { members = ["a", "b"], capacity = 2 } }\n`) as any;
  const sub = Bun.TOML.parse(`[projects.p]\nresources = ["a"]\n[projects.p.resource_groups.lane]\nmembers = ["a", "b"]\ncapacity = 2\n`) as any;
  const w = quiet();
  const a = parseLane(inline.projects.p, "projects.p", ["a"], 3);
  const b = parseLane(sub.projects.p, "projects.p", ["a"], 3);
  w.mockRestore();
  expect(a).toEqual(b);
  expect(a.device_steps_running).toBe(3);
});

test("parseLane: AS-15 missing member is added, duplicate dropped, bad capacity becomes 1", () => {
  const w = quiet();
  const r = parseLane({
    resource_groups: {
      g1: { members: ["ios-sim", "android-emu"], capacity: 0 },
      g2: { members: ["android-emu", "browser"], capacity: 2.5 },
      g3: { members: [] },
      g4: { members: "ios-sim" },
    },
  }, "projects.p", ["ios-sim"], 3);
  const msgs = w.mock.calls.map(c => String(c[0]));
  w.mockRestore();
  expect(r.resource_groups).toEqual([
    { name: "g1", members: ["ios-sim", "android-emu"], capacity: 1 },
    { name: "g2", members: ["browser"], capacity: 1 },
  ]);
  expect(r.resources).toEqual(["ios-sim", "android-emu", "browser"]);
  expect(msgs.some(m => m.includes("g1.capacity"))).toBe(true);
  expect(msgs.some(m => m.includes("'android-emu' is already in an earlier group"))).toBe(true);
  expect(msgs.some(m => m.includes("'android-emu' is not in resources"))).toBe(true);
  expect(msgs.some(m => m.includes("g3.members"))).toBe(true);
  expect(msgs.some(m => m.includes("g4.members"))).toBe(true);
});

test("parseLane: explicit device_steps and device_steps_running; invalid ones fall back", () => {
  const g = { devices: { members: ["a"], capacity: 2 } };
  expect(parseLane({ resource_groups: g, device_steps: ["test"], device_steps_running: 4 }, "p", ["a"], 3))
    .toMatchObject({ device_steps: ["test"], device_steps_running: 4 });
  const w = quiet();
  const r = parseLane({ resource_groups: g, device_steps: "test", device_steps_running: -1 }, "p", ["a"], 3);
  expect(w).toHaveBeenCalledTimes(2);
  w.mockRestore();
  expect(r).toMatchObject({ device_steps: ["implement", "test"], device_steps_running: 3 });
});

// ---------------------------------------------------------------- orderWaiters

let wid = 0;
const W = (task_id: string, step: string, qa_cycles = 0, expect_min: number | null = null): Waiter =>
  ({ id: ++wid, task_id, step_id: wid, step, qa_cycles, requested_at: new Date(Date.UTC(2026, 0, 1, 0, wid)).toISOString(), expect_min });

const shuffle = <T>(xs: T[]) => [...xs].sort(() => Math.random() - 0.5);

test("orderWaiters: AS-5 test before implement, higher qa first, then age", () => {
  const ws = [W("A", "implement", 0), W("B", "test", 0), W("C", "implement", 2), W("D", "test", 1)];
  expect(orderWaiters(ws).map(w => w.task_id)).toEqual(["D", "B", "C", "A"]);
  for (let i = 0; i < 10; i++) expect(orderWaiters(shuffle(ws))).toEqual(orderWaiters(ws));
});

test("orderWaiters: AS-6 FIFO within a task, ranked by the head waiter", () => {
  const a1 = W("A", "implement"), b = W("B", "implement"), a2 = W("A", "test");
  expect(orderWaiters([a2, b, a1]).map(w => w.id)).toEqual([a1.id, a2.id, b.id]);
});

test("orderWaiters: input is not mutated; other steps rank after implement", () => {
  const ws = [W("A", "research"), W("B", "implement"), W("C", "triage", 5)];
  const copy = ws.map(w => ({ ...w }));
  expect(orderWaiters(ws).map(w => w.task_id)).toEqual(["B", "C", "A"]);
  expect(ws).toEqual(copy);
  expect(stepClassRank("test")).toBeLessThan(stepClassRank("implement"));
  expect(stepClassRank("implement")).toBeLessThan(stepClassRank("plan"));
});

// ---------------------------------------------------------------- laneEta

test("laneEta: capacity 1", () => {
  expect(laneEta(1, [13], [{ expect_min: 20 }, { expect_min: null }], 45)).toEqual([13, 33]);
});

test("laneEta: capacity 2 fills the free slot first", () => {
  expect(laneEta(2, [10], [{ expect_min: 30 }, { expect_min: 5 }, { expect_min: null }], 45)).toEqual([0, 10, 15]);
});

test("laneEta: an overdue holder gives 0; missing expect uses the fallback", () => {
  expect(laneEta(1, [-12], [{ expect_min: null }, { expect_min: null }], 45)).toEqual([0, 45]);
});

// ---------------------------------------------------------------- dispatchVerdict

let sid = 0;
const C = (name: string, o: Partial<DispatchCandidate> = {}): DispatchCandidate =>
  ({ step_id: ++sid, task_id: `T${sid}`, name, priority: 5, qa_cycles: 0, created_at: new Date(Date.UTC(2026, 0, 1, 0, sid)).toISOString(), ...o });
const view = (o: Partial<DispatchView>): DispatchView =>
  ({ freeSlots: 1, deviceSteps: ["implement", "test"], deviceRunning: 0, deviceLimit: 2, laneBusy: false, queued: [], ...o });

test("dispatchVerdict: AS-8 device_limit holds a device step, a plan step launches", () => {
  const impl = C("implement"), plan = C("plan");
  const v = view({ deviceRunning: 2, deviceLimit: 2, queued: [impl, plan] });
  expect(dispatchVerdict(impl, v)).toEqual({ launch: false, reason: "device_limit" });
  expect(dispatchVerdict(plan, v)).toEqual({ launch: true });
});

test("dispatchVerdict: AS-9 a test launches before an older implement at equal priority", () => {
  const impl = C("implement"), tst = C("test");
  const v = view({ deviceRunning: 1, queued: [impl, tst] });
  expect(dispatchVerdict(tst, v)).toEqual({ launch: true });
  expect(dispatchVerdict(impl, v)).toEqual({ launch: false, reason: "ranked_behind" });
  // Higher priority (lower number) wins first.
  const urgent = C("implement", { priority: 1 }), tst2 = C("test");
  const v2 = view({ deviceRunning: 1, queued: [urgent, tst2] });
  expect(dispatchVerdict(urgent, v2)).toEqual({ launch: true });
  expect(dispatchVerdict(tst2, v2)).toEqual({ launch: false, reason: "ranked_behind" });
  // With room for both, both launch.
  const v3 = view({ deviceRunning: 0, queued: [impl, tst] });
  expect(dispatchVerdict(impl, v3)).toEqual({ launch: true });
});

test("dispatchVerdict: AS-10 empty deviceSteps launches everything", () => {
  const impl = C("implement");
  expect(dispatchVerdict(impl, view({ deviceSteps: [], deviceRunning: 9, deviceLimit: 1, laneBusy: true, queued: [impl, C("plan")] }))).toEqual({ launch: true });
});

test("dispatchVerdict: lane_busy holds only when free slots <= queued device-free steps", () => {
  const impl = C("implement"), plan = C("plan"), review = C("review");
  expect(dispatchVerdict(impl, view({ laneBusy: true, freeSlots: 1, deviceRunning: 1, queued: [impl, plan] })))
    .toEqual({ launch: false, reason: "lane_busy" });
  expect(dispatchVerdict(impl, view({ laneBusy: true, freeSlots: 2, deviceRunning: 1, queued: [impl, plan] })))
    .toEqual({ launch: true });
  expect(dispatchVerdict(impl, view({ laneBusy: true, freeSlots: 2, deviceRunning: 1, queued: [impl, plan, review] })))
    .toEqual({ launch: false, reason: "lane_busy" });
  expect(dispatchVerdict(impl, view({ laneBusy: false, freeSlots: 1, deviceRunning: 1, queued: [impl, plan] })))
    .toEqual({ launch: true });
});

test("dispatchVerdict: device-free candidates always launch", () => {
  for (const name of ["plan", "specify", "review", "handoff", "design", "research", "triage"]) {
    const c = C(name);
    expect(dispatchVerdict(c, view({ laneBusy: true, freeSlots: 1, deviceRunning: 5, deviceLimit: 2, queued: [c, C("test"), C("plan")] }))).toEqual({ launch: true });
  }
});
