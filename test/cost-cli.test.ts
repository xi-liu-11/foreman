import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Cost display through the real CLI against a stub taskd.
const home = realpathSync(mkdtempSync(join(tmpdir(), "fm-costcli-")));
const REPO_ROOT = join(import.meta.dir, "..");
let todayStatus = 200;
const today = {
  day: "2026-11-05",
  total: { usd: 12.34, estimated: 2, unknown: 0, steps: 5 },
  projects: {
    "tackle-tally": { usd: 2.34, estimated: 2, unknown: 0, steps: 2 },
    foreman: { usd: 10, estimated: 0, unknown: 0, steps: 3 },
  },
};
const task = (id: string, cost_usd: number, cost_estimated: number, cost_unknown: number) => ({
  id, project: "foreman", kind: "implement", title: `task ${id}`, status: "running", current_step: "implement",
  created_at: new Date().toISOString(), cost_usd, cost_estimated, cost_unknown, open_blocks: 0, superseded_by: null, rejection: null,
});
const tasks = [task("T0001", 3.05, 1, 0), task("T0002", 0, 0, 1), task("T0003", 1, 0, 0)];
const step = (id: number, name: string, cost_usd: number, turns: number, est: number, unk: number) => ({
  id, name, attempt: 1, status: "done", role: "worker", started_at: new Date().toISOString(), cost_usd, turns, cost_estimated: est, cost_unknown: unk, result: null, error: null,
});
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === "/tasks") return Response.json(tasks);
    if (p === "/tasks/T0001") return Response.json({
      task: { ...tasks[0], qa_cycles: 0, brief: "b", result: null },
      steps: [step(1, "plan", 0.05, 2, 1, 0), step(2, "implement", 0, 4, 0, 1), step(3, "qa", 1.5, 7, 0, 0)],
      blocks: [], leases: [], artifacts: [], events: [],
    });
    if (p === "/costs/today") return todayStatus === 200 ? Response.json(today) : new Response("not found", { status: 404 });
    return new Response("not found", { status: 404 });
  },
});
afterAll(() => server.stop(true));

async function cli(...args: string[]) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^FOREMAN_(TASK|STEP|STEP_NAME|RUN_DIR)$/.test(k)));
  const proc = Bun.spawn([process.execPath, join(REPO_ROOT, "src", "cli.ts"), ...args], {
    env: { ...base, FOREMAN_URL: server.url.origin, FOREMAN_TOKEN: "costcli", FOREMAN_CLI_NAME: "task", FOREMAN_HOME: home },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}
const line = (s: string, id: string) => s.split("\n").find(l => l.startsWith(id)) ?? "";

test("ls shows estimated, unknown and plain costs", async () => {
  todayStatus = 200;
  const r = await cli("ls");
  expect(r.code).toBe(0);
  expect(line(r.stdout, "T0001")).toContain("~$3.05");
  expect(line(r.stdout, "T0002")).toContain("$?");
  expect(line(r.stdout, "T0003")).toContain(" $1.00 ");
});

test("show marks estimated and unknown steps", async () => {
  const r = await cli("show", "T0001");
  expect(r.code).toBe(0);
  const plan = r.stdout.split("\n").find(l => l.includes("plan") && l.includes("#1")) ?? "";
  expect(plan).toContain("~$0.05 ~2t");
  const impl = r.stdout.split("\n").find(l => l.includes("implement") && l.includes("#1")) ?? "";
  expect(impl).toContain("$? 4t");
  const qa = r.stdout.split("\n").find(l => l.includes("qa") && l.includes("#1")) ?? "";
  expect(qa).toContain("$1.50 7t");
});

test("ls footer, overall and per project", async () => {
  todayStatus = 200;
  const r = await cli("ls");
  const last = r.stdout.trimEnd().split("\n").pop();
  expect(last).toBe("today: ~$12.34 (2 estimated) · foreman $10.00 · tackle-tally ~$2.34 (2 estimated)");
  const p = await cli("ls", "--project", "tackle-tally");
  expect(p.stdout.trimEnd().split("\n").pop()).toBe("today: ~$2.34 (2 estimated)");
  const none = await cli("ls", "--project", "nope");
  expect(none.stdout).toContain("today: $0.00");
  expect(none.stdout).not.toContain("foreman $");
});

test("no footer and exit 0 when /costs/today fails", async () => {
  todayStatus = 404;
  const r = await cli("ls");
  expect(r.code).toBe(0);
  expect(r.stdout).not.toContain("today:");
  expect(line(r.stdout, "T0001")).toContain("~$3.05");
});

test("ls --json is the unchanged array", async () => {
  todayStatus = 200;
  const r = await cli("ls", "--json");
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual(tasks);
  expect(r.stdout).not.toContain("today:");
});
