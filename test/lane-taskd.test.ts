import { test, expect, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectConfig } from "../src/config";

// T0048 test round 1: the device lane through the real taskd (tick -> tryLaunch,
// HTTP routes) and the real CLI, for scenarios the unit tests cover only as pure
// functions: AS-8, AS-9, AS-10 dispatch; AS-11 expect/ETA/show; AS-12 exit codes;
// AS-14 task ls. The project path does not exist, so a step that passes dispatch
// fails with "cwd missing" instead of spawning a worker; a held step stays queued.
const tmp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `fm-lanetd-${name}-`)));
const home = tmp("home");
process.env.FOREMAN_HOME = home;
const bin = tmp("bin");
writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 1\n");
chmodSync(join(bin, "herdr"), 0o755);
const savedPath = process.env.PATH;
process.env.PATH = `${bin}:${savedPath}`;
const { DB_PATH, REPO_ROOT } = await import("../src/config");
if (![tmpdir(), realpathSync(tmpdir())].some(d => DB_PATH.startsWith(d))) throw new Error(`refusing to run against ${DB_PATH}`);
const { Store } = await import("../src/db");
const { route, cfg, tick } = await import("../src/taskd");

const store = new Store();
const server = Bun.serve({ port: 0, fetch: req => route(req) });
const savedConcurrency = cfg.defaults.concurrency;
cfg.defaults.concurrency = 50;
afterAll(() => { server.stop(true); process.env.PATH = savedPath; cfg.defaults.concurrency = savedConcurrency; });

const devices = { name: "devices", members: ["ios-sim", "android-emu"], capacity: 1 };
const proj = (name: string, o: Partial<ProjectConfig> = {}) => ({
  name, path: join(home, "no-such-dir"), base_branch: "main", verify: "inspect", speckit: false, deny: [], concurrency: 3,
  merge: "direct", merge_gate: false, squash: true, ticket_states: {}, resources: ["android-emu", "ios-sim"], lease_max_minutes: 45,
  resource_groups: [devices], device_steps: ["implement", "test"], device_steps_running: 2, ...o,
}) as unknown as ProjectConfig;

let tid = 0;
const ids: string[] = [];
function mk(project: string, step: string, status: "running" | "queued", o: { priority?: number; qa_cycles?: number } = {}) {
  const id = `LT${String(++tid).padStart(3, "0")}`;
  ids.push(id);
  store.insertTask({
    id, project, kind: "implement", title: `${step} ${id}`, brief: "b", status,
    pipeline: JSON.stringify([{ type: "agent", name: step, role: step === "test" ? "test-analyst" : "developer" }]),
    current_step: step, priority: o.priority ?? 5, branch: null, worktree: null, feature_dir: null, ticket: null, pr_url: null,
    qa_cycles: o.qa_cycles ?? 0, result: null,
  });
  const s = store.insertStep({ task_id: id, name: step, role: step === "test" ? "test-analyst" : "developer", status, attempt: 1 });
  if (status === "running") store.updateStep(s.id, { started_at: new Date().toISOString(), lease_until: new Date(Date.now() + 3600_000).toISOString() });
  return { id, step: store.getStep(s.id)! };
}
const closeAll = () => { for (const id of ids.splice(0)) store.updateTask(id, { status: "cancelled" }); };
const deferredReason = (stepId: number) =>
  (store.db.query("SELECT data FROM events WHERE type = 'step.deferred' AND step_id = ? ORDER BY id DESC").get(stepId) as any)?.data;
const launched = (stepId: number) => { const s = store.getStep(stepId)!; return s.status !== "queued" && String(s.error).startsWith("cwd missing"); };

// The worker's own FOREMAN_TASK/FOREMAN_STEP must not leak into CLI calls made here.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^FOREMAN_(TASK|STEP|STEP_NAME|RUN_DIR)$/.test(k)));
async function cli(env: Record<string, string>, ...args: string[]) {
  const proc = Bun.spawn([process.execPath, join(REPO_ROOT, "src", "cli.ts"), ...args], {
    env: { ...baseEnv, FOREMAN_URL: server.url.origin, FOREMAN_TOKEN: cfg.server.token, FOREMAN_CLI_NAME: "task", FOREMAN_HOME: home, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}
const post = (path: string, body: unknown) =>
  fetch(server.url.origin + path, { method: "POST", headers: { authorization: `Bearer ${cfg.server.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

test("AS-8 via tick: device_steps_running reached holds the third device step; a queued plan launches; task ls says queued: device lane", async () => {
  const P = "lt-as8";
  cfg.projects[P] = proj(P);
  try {
    mk(P, "implement", "running"); mk(P, "test", "running");
    const third = mk(P, "implement", "queued");
    const plan = mk(P, "plan", "queued");
    await tick();
    expect(store.getStep(third.step.id)!.status).toBe("queued");
    expect(deferredReason(third.step.id)).toContain("device_limit");
    expect(launched(plan.step.id)).toBe(true);
    const ls = await cli({}, "ls", "--project", P);
    expect(ls.stdout.split("\n").find(l => l.startsWith(third.id))).toContain("queued: device lane");
  } finally { closeAll(); delete cfg.projects[P]; }
});

test("AS-9 via tick: with one device slot left a newer test launches before an older implement", async () => {
  const P = "lt-as9";
  cfg.projects[P] = proj(P);
  try {
    mk(P, "implement", "running");
    const impl = mk(P, "implement", "queued");
    await Bun.sleep(5);
    const tst = mk(P, "test", "queued");
    await tick();
    expect(launched(tst.step.id)).toBe(true);
    expect(store.getStep(impl.step.id)!.status).toBe("queued");
    expect(deferredReason(impl.step.id)).toContain("ranked_behind");
  } finally { closeAll(); delete cfg.projects[P]; }
});

test("AS-10 via tick: a project without groups launches device-named steps as today", async () => {
  const P = "lt-as10";
  cfg.projects[P] = proj(P, { resource_groups: [], device_steps: [], device_steps_running: 1, resources: [] });
  try {
    mk(P, "implement", "running"); mk(P, "test", "running");
    const third = mk(P, "implement", "queued");
    await tick();
    expect(launched(third.step.id)).toBe(true);
    expect(deferredReason(third.step.id)).toBeUndefined();
  } finally { closeAll(); delete cfg.projects[P]; }
});

test("AS-1/AS-11/AS-12/AS-14 via HTTP and CLI: expect stored and shown, waiter ETA, exit codes, waiting for devices", async () => {
  const P = "lt-as11";
  cfg.projects[P] = proj(P);
  try {
    const a = mk(P, "test", "running");
    const b = mk(P, "implement", "running");
    const envA = { FOREMAN_TASK: a.id, FOREMAN_STEP: String(a.step.id) };
    const envB = { FOREMAN_TASK: b.id, FOREMAN_STEP: String(b.step.id) };

    // AS-12: invalid --expect exits 1 and sends nothing.
    for (const v of ["0", "-3", "abc"]) {
      const r = await cli(envA, "lease", "ios-sim", "--expect", v);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("--expect");
    }
    expect(store.listLeases({ project: P }).length).toBe(0);
    // Server side rejects a bad expect_min too.
    expect((await post(`/steps/${a.step.id}/lease`, { resource: "ios-sim", expect_min: 0 })).status).toBe(400);

    // AS-11: granted with expect 25, exit 0.
    const ga = await cli(envA, "lease", "ios-sim", "--expect", "25", "--reason", "flows");
    expect(ga.code).toBe(0);
    expect(ga.stdout).toContain("lease ios-sim granted");
    expect(store.listLeases({ project: P })[0]!.expect_min).toBe(25);

    // AS-1 + AS-12: B asks for the free android-emu and stays queued; --wait 1 exits 3 with its place and ETA.
    const wb = await cli(envB, "lease", "android-emu", "--wait", "1");
    expect(wb.code).toBe(3);
    expect(wb.stdout).toMatch(/you are #1 of 1, eta ~2[45]m/);

    // AS-14: task ls marks B as waiting for devices (1st).
    const ls = await cli({}, "ls", "--project", P);
    expect(ls.stdout.split("\n").find(l => l.startsWith(b.id))).toContain("waiting for devices (1st)");

    // AS-11: task leases and task show print expect and eta.
    const leases = await cli({}, "leases", "--project", P);
    expect(leases.code).toBe(0);
    expect(leases.stdout).toContain(`${P} local devices (capacity 1, device steps 2/2 running)`);
    expect(leases.stdout).toMatch(/expect ~25m \(2[45]m left\)/);
    expect(leases.stdout).toMatch(/#1\s+\S+\/implement#1 android-emu waiting \d+m eta ~2[45]m/);
    const json = JSON.parse((await cli({}, "leases", "--project", P, "--json")).stdout);
    expect(Array.isArray(json)).toBe(true);
    expect(json.map((l: any) => l.resource).sort()).toEqual(["android-emu", "ios-sim"]);
    const showA = await cli({}, "show", a.id);
    expect(showA.stdout).toMatch(/ios-sim\s+held by test#1 .*expect ~?25m/);
    const showB = await cli({}, "show", b.id);
    expect(showB.stdout).toMatch(/android-emu\s+waiting #1 .*eta ~?2[45]m/);

    // AS-11: overdue after expect (25 min), not lease_max_minutes (45): backdate the grant by 30 min.
    store.db.run("UPDATE resource_leases SET granted_at = ? WHERE project = ? AND resource = 'ios-sim'", [new Date(Date.now() - 30 * 60_000).toISOString(), P]);
    await tick();
    const overdue = store.db.query("SELECT COUNT(*) AS n FROM events WHERE type = 'lease.overdue' AND task_id = ?").get(a.id) as any;
    expect(overdue.n).toBe(1);

    // AS-1: A releases; B is granted; a plain lease with no --wait now exits 0 at once.
    const rel = await cli(envA, "release", "ios-sim");
    expect(rel.code).toBe(0);
    const gb = await cli(envB, "lease", "android-emu");
    expect(gb.code).toBe(0);
    expect(gb.stdout).toContain("android-emu");
  } finally { closeAll(); delete cfg.projects[P]; }
}, 30000);

test("R1: a stopped task with a stale held-back step shows its real status; a concurrency hold clears the lane reason", async () => {
  const P = "lt-r1";
  cfg.projects[P] = proj(P);
  const lane = async (id: string) => ((await (await fetch(`${server.url.origin}/tasks?all=1&project=${P}`, { headers: { authorization: `Bearer ${cfg.server.token}` } })).json()) as any[]).find(t => t.id === id)?.lane;
  try {
    mk(P, "implement", "running"); mk(P, "test", "running");
    const held = mk(P, "implement", "queued");
    await tick();
    expect(await lane(held.id)).toEqual({ state: "deferred", reason: "device_limit" });
    store.updateTask(held.id, { status: "cancelled" });
    expect(await lane(held.id)).toBeNull();
    const ls = await cli({}, "ls", "--all", "--project", P);
    expect(ls.stdout.split("\n").find(l => l.startsWith(held.id))).toContain("cancelled");

    const held2 = mk(P, "implement", "queued");
    await tick();
    expect((await lane(held2.id))?.state).toBe("deferred");
    cfg.projects[P] = proj(P, { concurrency: 2 });
    await tick();
    expect(store.getStep(held2.step.id)!.status).toBe("queued");
    expect(await lane(held2.id)).toBeNull();
  } finally { closeAll(); delete cfg.projects[P]; }
});

// Test round 2: R2 through the real /lanes route and CLI (the round-1 fix is unit-tested only against a stub).
test("R2 via route and CLI: /lanes?task= scopes to the task's project; unscoped task leases prints every project's lane", async () => {
  const [P1, P2] = ["lt-r2a", "lt-r2b"];
  cfg.projects[P1] = proj(P1); cfg.projects[P2] = proj(P2);
  const get = async (q: string) => (await (await fetch(`${server.url.origin}/lanes${q}`, { headers: { authorization: `Bearer ${cfg.server.token}` } })).json()) as any;
  try {
    const a = mk(P1, "test", "running");
    const b = mk(P2, "implement", "running");
    expect((await cli({ FOREMAN_TASK: a.id, FOREMAN_STEP: String(a.step.id) }, "lease", "ios-sim")).code).toBe(0);
    expect((await cli({ FOREMAN_TASK: b.id, FOREMAN_STEP: String(b.step.id) }, "lease", "android-emu")).code).toBe(0);

    const byTask = await get(`?task=${b.id}`);
    expect(byTask.lanes.map((l: any) => l.project)).toEqual([P2]);
    expect(Object.keys(byTask.projects)).toEqual([P2]);
    expect((await get(`?project=${P1}`)).lanes.map((l: any) => l.project)).toEqual([P1]);
    const every = (await get("")).lanes.map((l: any) => l.project);
    expect(every).toContain(P1); expect(every).toContain(P2);

    const all = await cli({}, "leases");
    expect(all.code).toBe(0);
    expect(all.stdout).toContain(`${P1} local devices (capacity 1`);
    expect(all.stdout).toContain(`${P2} local devices (capacity 1`);
    const scoped = await cli({ FOREMAN_TASK: a.id, FOREMAN_STEP: String(a.step.id) }, "leases");
    expect(scoped.stdout).toContain(`${P1} local devices`);
    expect(scoped.stdout).not.toContain(`${P2} local devices`);
  } finally {
    for (const t of [P1, P2]) for (const r of store.listLeases({ project: t })) store.db.query("DELETE FROM resource_leases WHERE id = ?").run(r.id);
    closeAll(); delete cfg.projects[P1]; delete cfg.projects[P2];
  }
}, 30000);
