import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// AS-12 and AS-14 through the real CLI against a stub taskd: lane statuses in
// task ls, --expect validation and pass-through, and the lane block in task leases.
const home = realpathSync(mkdtempSync(join(tmpdir(), "fm-lanecli-")));
const REPO_ROOT = join(import.meta.dir, "..");
const TOKEN = "lanecli";

const posts: { path: string; body: any }[] = [];
const laneQueries: string[] = [];
const task = (id: string, lane: unknown) => ({
  id, project: "tt", kind: "implement", title: `task ${id}`, status: "running", current_step: "implement",
  created_at: new Date().toISOString(), cost_usd: 0, open_blocks: 0, superseded_by: null, rejection: null, lane,
});
const lease = { id: 1, project: "tt", machine: "local", resource: "ios-sim", task_id: "T0001", step_id: 1, reason: "flows", requested_at: new Date().toISOString(), granted_at: new Date().toISOString(), overdue_at: null, expect_min: 25, step: "test", attempt: 1, state: "held", position: 0, held_sec: 60, waited_sec: null, overdue: false, holder: null, group: "devices", eta_min: null, expect_left_min: 24 };
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname;
    const json = (d: unknown) => Response.json(d);
    if (req.method === "POST") {
      const body = await req.json();
      posts.push({ path: p, body });
      return json({ resource: body.resource, machine: "local", granted: true, position: 0, queue: 0, holder: null, group: "devices", expect_min: body.expect_min ?? null, eta_min: null, expect_left_min: null });
    }
    if (p === "/tasks") return json([task("T0001", { state: "waiting", position: 2, of: 2 }), task("T0002", { state: "deferred", reason: "device_limit" }), task("T0003", null)]);
    if (p === "/leases") return json([lease]);
    if (p === "/lanes") laneQueries.push(new URL(req.url).search);
    if (p === "/lanes" && !new URL(req.url).searchParams.size) return json({
      lanes: ["tt", "other"].map(project => ({ project, machine: "local", group: "devices", capacity: 1, members: ["ios-sim"], holders: [], waiters: [] })),
      projects: {},
    });
    if (p === "/lanes") return json({
      lanes: [{ project: "tt", machine: "local", group: "devices", capacity: 1, members: ["ios-sim", "android-emu"],
        holders: [{ task_id: "T0001", step: "test", attempt: 1, resources: ["ios-sim"], since: lease.granted_at, held_min: 1, expect_min: 25, expect_left_min: 24, overdue: false }],
        waiters: [{ task_id: "T0004", step: "implement", attempt: 1, resource: "android-emu", position: 1, waited_min: 3, expect_min: null, eta_min: 24 }] }],
      projects: { tt: { device_steps: ["implement", "test"], device_steps_running: 2, device_running: 2 } },
    });
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => server.stop(true));

async function cli(...args: string[]) { return cliEnv({ FOREMAN_TASK: "T0001", FOREMAN_STEP: "1" }, ...args); }
async function cliEnv(env: Record<string, string>, ...args: string[]) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^FOREMAN_(TASK|STEP|STEP_NAME|RUN_DIR)$/.test(k)));
  const proc = Bun.spawn([process.execPath, join(REPO_ROOT, "src", "cli.ts"), ...args], {
    env: { ...base, FOREMAN_URL: server.url.origin, FOREMAN_TOKEN: TOKEN, FOREMAN_CLI_NAME: "task", FOREMAN_HOME: home, ...env },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

test("task ls shows lane statuses", async () => {
  const r = await cli("ls");
  expect(r.code).toBe(0);
  const line = (id: string) => r.stdout.split("\n").find(l => l.startsWith(id)) ?? "";
  expect(line("T0001")).toContain("waiting for devices (2nd)");
  expect(line("T0002")).toContain("queued: device lane");
  expect(line("T0003")).toContain("running");
});

test("task lease --expect rejects bad values without a request", async () => {
  for (const v of ["0", "x", "-5"]) {
    const before = posts.length;
    const r = await cli("lease", "ios-sim", "--expect", v);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--expect");
    expect(posts.length).toBe(before);
  }
});

test("task lease --expect 25 posts expect_min; without it no expect_min is sent", async () => {
  const r = await cli("lease", "ios-sim", "--expect", "25", "--reason", "flows");
  expect(r.code).toBe(0);
  expect(posts.at(-1)).toEqual({ path: "/steps/1/lease", body: { resource: "ios-sim", reason: "flows", expect_min: 25 } });
  await cli("lease", "ios-sim");
  expect(posts.at(-1)!.body).toEqual({ resource: "ios-sim" });
});

test("task leases prints the lane block, then the table; --json stays the lease array", async () => {
  const r = await cli("leases");
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("tt local devices (capacity 1, device steps 2/2 running)");
  expect(r.stdout).toContain("expect ~25m (24m left)");
  expect(r.stdout).toContain("eta ~24m");
  expect(r.stdout).toContain("EXPECT");
  const j = await cli("leases", "--json");
  expect(JSON.parse(j.stdout)).toEqual([lease]);
});

test("task leases scopes lanes like the table: FOREMAN_TASK, --project, else every project", async () => {
  laneQueries.length = 0;
  await cli("leases");
  await cliEnv({}, "leases", "--project", "tt");
  const all = await cliEnv({}, "leases");
  expect(laneQueries).toEqual(["?task=T0001", "?project=tt", ""]);
  expect(all.stdout).toContain("tt local devices (capacity 1)");
  expect(all.stdout).toContain("other local devices (capacity 1)");
});
