import { test, expect, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Acceptance scenarios 3 and 7 through the real CLI: `task reject`, `task inbox`,
// `task show`, `task ls` and `task --help`, against route() on a local server.
const tmp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `fm-rjc-${name}-`)));
const home = tmp("home");
process.env.FOREMAN_HOME = home;
const bin = tmp("bin");
writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 1\n");
chmodSync(join(bin, "herdr"), 0o755);
const savedPath = process.env.PATH;
process.env.PATH = `${bin}:${savedPath}`;
const { Store } = await import("../src/db");
const { route, cfg } = await import("../src/taskd");
const { DB_PATH, REPO_ROOT } = await import("../src/config");
if (![tmpdir(), realpathSync(tmpdir())].some(d => DB_PATH.startsWith(d))) throw new Error(`refusing to run against ${DB_PATH}`);
const { pipelineFor } = await import("../src/pipelines");
import type { TaskRow, StepStatus } from "../src/db";
import type { PipelineStep } from "../src/pipelines";

const store = new Store();
const P = "rjc-speckit";
cfg.projects[P] = { name: P, path: home, base_branch: "main", verify: "inspect", speckit: true, deny: [], concurrency: 0, merge: "direct", merge_gate: true, squash: true, ticket_states: {}, resources: [], lease_max_minutes: 60 };
const server = Bun.serve({ port: 0, fetch: req => route(req) });
afterAll(() => { server.stop(true); delete cfg.projects[P]; process.env.PATH = savedPath; });

const PIPELINE = pipelineFor("implement", true, { merge: "direct", merge_gate: true, tickets: false }).steps;
const LEGACY = PIPELINE.map(s => s.type === "agent" && s.name === "plan_qa" ? { type: "agent", name: "plan_qa", role: "qa-reviewer", prompt: "plan_qa" } : s) as PipelineStep[];
const so = (verdict: string, summary: string) => ({ status: "done", verdict, summary, notes_for_next: "", artifacts: [] });
function row(task: TaskRow, name: string, status: StepStatus, result?: object, role = "architect") {
  const s = store.insertStep({ task_id: task.id, name, role, status, attempt: (store.latestStep(task.id, name)?.attempt ?? 0) + 1 });
  if (result) store.updateStep(s.id, { result: JSON.stringify(result), finished_at: "x" });
}
async function cli(...args: string[]) {
  const proc = Bun.spawn([process.execPath, join(REPO_ROOT, "src", "cli.ts"), ...args], {
    env: { ...process.env, FOREMAN_URL: server.url.origin, FOREMAN_TOKEN: cfg.server.token, FOREMAN_CLI_NAME: "task", FOREMAN_HOME: home },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

// T0034's shape: legacy pipeline, plan_qa #1 failed, waiting at plan_approved.
const t = store.insertTask({
  id: "RJC1", project: P, kind: "implement", title: "legacy gated plan", brief: "b", status: "gate",
  pipeline: JSON.stringify(LEGACY), current_step: "plan_approved", priority: 0, branch: null, worktree: null,
  feature_dir: "specs/041-thing", ticket: null, pr_url: null, qa_cycles: 0, result: null,
});
row(t, "specify", "done", so("n/a", "specified"));
row(t, "plan", "done", so("n/a", "planned"));
row(t, "plan_qa", "done", so("fail", "U1 HIGH: undo is unspecified"), "qa-reviewer");
row(t, "plan_approved", "gate", undefined, "user");
const WARN = "Approve the plan — plan QA still fails after 1 review(s); see specs/041-thing/qa/plan-review.md";

test("task --help lists task reject", async () => {
  const r = await cli("--help");
  expect(r.stdout + r.stderr).toContain(`task reject <id> "<feedback>"`);
});

test("before the reject: inbox shows the gate label and both hints, show prints plan cycles and the label", async () => {
  const inbox = await cli("inbox", "--project", P);
  expect(inbox.code).toBe(0);
  expect(inbox.stdout).toContain("gates:");
  expect(inbox.stdout).toContain(`RJC1 legacy gated plan waiting at plan_approved (${WARN}): task approve RJC1 | task reject RJC1 "<feedback>"`);
  expect(inbox.stdout).not.toContain("revising:");
  const show = await cli("show", "RJC1");
  expect(show.code).toBe(0);
  expect(show.stdout).toContain("plan cycles: 0");
  expect(show.stdout).toContain(`gate: ${WARN}`);
  for (const s of ["specify", "plan", "plan_qa", "plan_approved"]) expect(show.stdout).toContain(s);
});

test("task reject without feedback exits non-zero and changes nothing", async () => {
  const r = await cli("reject", "RJC1");
  expect(r.code).not.toBe(0);
  expect(r.stderr).toContain("usage: task reject");
  expect(store.getTask("RJC1")!.status).toBe("gate");
});

test("task reject re-queues the plan; inbox, ls, show and /tasks report it as revising", async () => {
  const r = await cli("reject", "RJC1", "Please address U1");
  expect(r.code).toBe(0);
  expect(r.stdout.trim()).toBe("rejected at plan_approved; revising plan");

  const inbox = await cli("inbox", "--project", P);
  expect(inbox.stdout).not.toContain("gates:");
  expect(inbox.stdout).toContain("revising:");
  expect(inbox.stdout).toContain("RJC1 legacy gated plan — rejected at plan_approved, revising plan");
  const json = JSON.parse((await cli("inbox", "--project", P, "--json")).stdout);
  expect(json.gates).toEqual([]);
  expect(json.revising.map((x: any) => x.id)).toEqual(["RJC1"]);

  const ls = await cli("ls", "--project", P);
  expect(ls.stdout).toMatch(/RJC1\s+rejected, revising\s+rjc-speckit/);

  const show = await cli("show", "RJC1");
  expect(show.stdout).toContain("rejected at plan_approved, revising: Please address U1");

  const res = await route(new Request(`http://x/tasks?project=${P}`, { headers: { authorization: `Bearer ${cfg.server.token}` } }));
  const listed = (await res.json() as any[]).find(x => x.id === "RJC1");
  expect(JSON.parse(listed.rejection)).toMatchObject({ gate: "plan_approved", target: "plan", feedback: "Please address U1" });
  expect(["queued", "running"]).toContain(listed.status);
});

test("task reject on a task that is not at a gate reports the error", async () => {
  const r = await cli("reject", "RJC1", "again");
  expect(r.code).not.toBe(0);
  expect(r.stdout + r.stderr).toContain("not waiting at a gate");
});
