import { test, expect, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `fm-sup-${name}-`)));
const home = tmp("home");
process.env.FOREMAN_HOME = home;
const { Store } = await import("../src/db");
const { REPO_ROOT } = await import("../src/config");
const { route, cfg } = await import("../src/taskd");
import type { TaskRow, TaskStatus } from "../src/db";
import type { ProjectConfig } from "../src/config";

// Seeded through a second handle on taskd's default DB. Bun shares modules between
// test files, so config.toml is not re-read: projects are registered on the exported
// cfg. Concurrency 0 keeps tryLaunch from ever spawning a worker.
const store = new Store();
const token = cfg.server.token;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const P = "sup-test", GIT = "sup-git", TICKETS = "sup-tickets";

function mkProject(name: string, over: Partial<ProjectConfig> = {}): void {
  cfg.projects[name] = { name, path: home, base_branch: "main", verify: "inspect", speckit: false, deny: [], concurrency: 0, merge: "direct", merge_gate: false, squash: true, ticket_states: {}, resources: [], lease_max_minutes: 60, ...over };
}
mkProject(P);

const savedWorktrees = cfg.defaults.worktrees;
const savedTickets = cfg.tickets.linear;
const savedClaudeDir = process.env.CLAUDE_CONFIG_DIR;
const savedFetch = globalThis.fetch;
afterAll(() => {
  server.stop(true);
  for (const name of [P, GIT, TICKETS, "sup-gone", "sup-ls", "sup-inbox"]) delete cfg.projects[name];
  cfg.defaults.worktrees = savedWorktrees;
  cfg.tickets.linear = savedTickets;
  globalThis.fetch = savedFetch;
  if (savedClaudeDir === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedClaudeDir;
});

let tid = 0;
function mkTask(status: TaskStatus, over: Partial<TaskRow> = {}): TaskRow {
  return store.insertTask({
    id: `S${++tid}`, project: P, kind: "research", title: `task ${tid}`, brief: "b", status,
    pipeline: "[]", current_step: null, priority: 0, branch: null, worktree: null, feature_dir: null,
    ticket: null, pr_url: null, qa_cycles: 0, result: null, ...over,
  });
}
function mkBlocked(over: Partial<TaskRow> = {}) {
  const task = mkTask("blocked", over);
  const step = store.insertStep({ task_id: task.id, name: "plan", role: "architect", status: "blocked", attempt: 1 });
  return { task, step, block: store.insertBlock(task.id, step.id, `question on ${task.id}`) };
}
function mkRunning() {
  const task = mkTask("blocked");
  return { task, step: store.insertStep({ task_id: task.id, name: "plan", role: "architect", status: "running", attempt: 1 }) };
}

async function post(path: string, body: unknown = {}): Promise<{ status: number; body: any }> {
  const res = await route(new Request(`http://x${path}`, { method: "POST", headers, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}
const close = (id: string, other: string) => post(`/tasks/${id}/close`, { superseded_by: other });
const events = (id: string, type: string) => store.eventsForTask(id, 100).filter(e => e.type === type);
const taskSeq = () => (store.db.query("SELECT value FROM meta WHERE key = 'task_seq'").get() as { value: string } | null)?.value ?? null;

function expectSuperseded(id: string, other: string): void {
  const t = store.getTask(id)!;
  expect(t.status).toBe("superseded");
  expect(t.superseded_by).toBe(other);
  const [gone, ...moreGone] = events(id, "task.superseded");
  expect(moreGone).toEqual([]);
  expect(JSON.parse(gone.data).message).toBe(`superseded by ${other}`);
  const on = events(other, "task.continues").filter(e => JSON.parse(e.data).continues === id);
  expect(on.length).toBe(1);
  expect(JSON.parse(on[0].data).message).toBe(`continues ${id}`);
}

// ---------------------------------------------------------------- status transition

for (const status of ["failed", "cancelled", "gate", "blocked"] as TaskStatus[]) {
  test(`a ${status} task closes as superseded`, async () => {
    const old = mkTask(status), next = mkTask("running");
    const r = await close(old.id, next.id);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, superseded_by: next.id });
    expectSuperseded(old.id, next.id);
    expect(store.getTask(next.id)!.status).toBe("running");
  });
}

test("closing a blocked task answers its open questions", async () => {
  const { task, block } = mkBlocked();
  expect((await close(task.id, mkTask("running").id)).status).toBe(200);
  expect(store.getBlock(block.id)!.answer).toBe("(task superseded)");
  expect(store.openBlocks(task.id)).toEqual([]);
});

test("closing releases a running step's lease and its heartbeat says cancel", async () => {
  const { task, step } = mkRunning();
  const lease = await post(`/steps/${step.id}/lease`, { resource: "sup-sim" });
  expect(lease.body.granted).toBe(true);
  expect(store.leasesForTask(task.id).length).toBe(1);
  expect((await post(`/steps/${step.id}/heartbeat`)).body.cancel).toBe(false);
  expect((await close(task.id, mkTask("running").id)).status).toBe(200);
  expect(store.leasesForTask(task.id)).toEqual([]);
  expect((await post(`/steps/${step.id}/heartbeat`)).body.cancel).toBe(true);
});

for (const reported of ["blocked", "done"]) {
  test(`a late ${reported} result leaves the task superseded and fails the step`, async () => {
    const { task, step } = mkRunning();
    const next = mkTask("running");
    expect((await close(task.id, next.id)).status).toBe(200);
    const r = await post(`/steps/${step.id}/result`, { exit_code: 0, result: { structured_output: { status: reported, summary: "late" } } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ step_status: "failed", task_status: "superseded" });
    expect(store.getStep(step.id)!.error).toBe("superseded");
    expect(store.getTask(task.id)!.status).toBe("superseded");
    expect(store.openBlocks(task.id)).toEqual([]);
  });
}

test("a task block from a worker of a superseded task is answered at once", async () => {
  const { task, step } = mkRunning();
  expect((await close(task.id, mkTask("running").id)).status).toBe(200);
  const r = await post(`/tasks/${task.id}/blocks`, { question: "still there?", step_id: step.id });
  expect(r.status).toBe(201);
  expect(store.getBlock(r.body.id)!.answer).toBe("(task superseded)");
  expect(store.openBlocks(task.id)).toEqual([]);
});

test("the tick creates no step for a superseded task whose questions were closed", async () => {
  const pipeline = JSON.stringify([{ type: "agent", name: "plan", role: "architect", prompt: "plan_lite" }]);
  const { task } = mkBlocked({ pipeline, current_step: "plan" });
  // The control proves a tick ran: its answered question starts a new attempt.
  const control = mkBlocked({ pipeline, current_step: "plan" });
  expect((await close(task.id, mkTask("running").id)).status).toBe(200);
  expect((await post(`/blocks/${control.block.id}/answer`, { answer: "yes" })).status).toBe(200);
  for (let i = 0; i < 100 && store.stepsForTask(control.task.id).length < 2; i++) await Bun.sleep(20);
  expect(store.stepsForTask(control.task.id).length).toBe(2);
  expect(store.stepsForTask(task.id).length).toBe(1);
  expect(store.getTask(task.id)!.status).toBe("superseded");
});

// ---------------------------------------------------------------- refusals

for (const status of ["queued", "running", "done"] as TaskStatus[]) {
  test(`a ${status} task is refused`, async () => {
    const old = mkTask(status), next = mkTask("running");
    const r = await close(old.id, next.id);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain(`${old.id} is ${status}`);
    expect(store.getTask(old.id)!.status).toBe(status);
    expect(store.getTask(old.id)!.superseded_by).toBeNull();
    expect(events(old.id, "task.superseded")).toEqual([]);
    expect(events(next.id, "task.continues")).toEqual([]);
  });
}

test("an already superseded task is refused and keeps its pointer", async () => {
  const old = mkTask("failed"), first = mkTask("running"), second = mkTask("running");
  expect((await close(old.id, first.id)).status).toBe(200);
  expect((await close(old.id, second.id)).status).toBe(400);
  expectSuperseded(old.id, first.id);
  expect(events(second.id, "task.continues")).toEqual([]);
});

test("a missing superseded_by, an unknown task and the task itself are refused", async () => {
  const old = mkTask("failed");
  const missing = await post(`/tasks/${old.id}/close`);
  expect(missing.status).toBe(400);
  const unknown = await close(old.id, "S-none");
  expect(unknown.status).toBe(400);
  expect(unknown.body.error).toBe("no such task 'S-none'");
  const self = await close(old.id, old.id);
  expect(self.status).toBe(400);
  expect(store.getTask(old.id)!.status).toBe("failed");
  expect(store.getTask(old.id)!.superseded_by).toBeNull();
  expect(events(old.id, "task.superseded")).toEqual([]);
});

test("closing an unknown task is a 404", async () => {
  expect((await close("S-none", mkTask("running").id)).status).toBe(404);
});

test("a cycle is refused, directly and through a chain", async () => {
  const a = mkTask("failed"), b = mkTask("failed"), c = mkTask("failed");
  expect((await close(a.id, b.id)).status).toBe(200);
  const direct = await close(b.id, a.id);
  expect(direct.status).toBe(400);
  expect(direct.body.error).toContain("cycle");
  expect((await close(b.id, c.id)).status).toBe(200);
  const chain = await close(c.id, a.id);
  expect(chain.status).toBe(400);
  expect(chain.body.error).toContain("cycle");
  expect(store.getTask(c.id)!.status).toBe("failed");
  expect(store.getTask(c.id)!.superseded_by).toBeNull();
});

test("task cancel and task retry refuse a superseded task", async () => {
  const old = mkTask("failed"), next = mkTask("running");
  expect((await close(old.id, next.id)).status).toBe(200);
  expect((await post(`/tasks/${old.id}/cancel`)).status).toBe(400);
  expect((await post(`/tasks/${old.id}/retry`)).status).toBe(400);
  expectSuperseded(old.id, next.id);
  expect(events(old.id, "task.cancelled")).toEqual([]);
});

test("task cancel still closes questions and stops running steps", async () => {
  const { task, block } = mkBlocked();
  const running = store.insertStep({ task_id: task.id, name: "other", role: "architect", status: "running", attempt: 1 });
  expect((await post(`/tasks/${task.id}/cancel`)).status).toBe(200);
  expect(store.getTask(task.id)!.status).toBe("cancelled");
  expect(store.getBlock(block.id)!.answer).toBe("(task cancelled)");
  expect((await post(`/steps/${running.id}/heartbeat`)).body.cancel).toBe(true);
});

// ---------------------------------------------------------------- migration

test("the migration adds superseded_by to an old database and keeps its rows", () => {
  const path = join(tmp("migrate"), "old.db");
  const old = new Database(path, { create: true });
  old.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, brief TEXT NOT NULL, status TEXT NOT NULL, pipeline TEXT NOT NULL, current_step TEXT, priority INTEGER NOT NULL DEFAULT 5, branch TEXT, worktree TEXT, feature_dir TEXT, ticket TEXT, qa_cycles INTEGER NOT NULL DEFAULT 0, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO tasks (id, project, kind, title, brief, status, pipeline, created_at, updated_at) VALUES ('T0001', 'p', 'research', 't', 'b', 'failed', '[]', 'x', 'x');`);
  old.close();
  for (let i = 0; i < 2; i++) {
    const migrated = new Store(path);
    const row = migrated.getTask("T0001")!;
    expect(row.status).toBe("failed");
    expect(row.superseded_by).toBeNull();
    migrated.db.close();
  }
});

// ---------------------------------------------------------------- --continues

const createBody = (over: Record<string, unknown>) => ({ project: P, kind: "research", title: "the successor", brief: "b", ...over });

test("--continues creates the task and closes the failed one", async () => {
  const old = mkTask("failed");
  const r = await post("/tasks", createBody({ continues: old.id }));
  expect(r.status).toBe(201);
  expectSuperseded(old.id, r.body.id);
  expect(JSON.parse(events(r.body.id, "task.created")[0].data).continues).toBe(old.id);
});

test("--continues with an unknown or running task creates nothing", async () => {
  const running = mkTask("running");
  const seq = taskSeq();
  const unknown = await post("/tasks", createBody({ continues: "S-none" }));
  expect(unknown.status).toBe(400);
  expect(unknown.body.error).toBe("no such task 'S-none'");
  const refused = await post("/tasks", createBody({ continues: running.id }));
  expect(refused.status).toBe(400);
  expect(refused.body.error).toContain(`${running.id} is running`);
  expect(taskSeq()).toBe(seq);
  expect(store.getTask(running.id)!.status).toBe("running");
  expect(store.getTask(running.id)!.superseded_by).toBeNull();
});

// A repo with a branch held by a worktree at the path Foreman computes for it.
async function mkRepo() {
  const repo = tmp("repo");
  cfg.defaults.worktrees = tmp("worktrees");
  process.env.CLAUDE_CONFIG_DIR = tmp("claude");
  mkProject(GIT, { path: repo });
  const git = async (cwd: string, ...args: string[]) => {
    const proc = Bun.spawn(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdout: "ignore", stderr: "ignore" });
    expect(await proc.exited).toBe(0);
  };
  await git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "a.txt"), "a\n");
  await git(repo, "add", "a.txt");
  await git(repo, "commit", "-qm", "init");
  await git(repo, "branch", "feature-x");
  const worktree = join(cfg.defaults.worktrees, GIT, "feature-x");
  await git(repo, "worktree", "add", "-q", worktree, "feature-x");
  const old = mkTask("failed", { project: GIT, kind: "implement", branch: "feature-x", worktree });
  const body = (over: Record<string, unknown> = {}) => createBody({ project: GIT, kind: "implement", branch: "feature-x", start_at: "implement", continues: old.id, ...over });
  return { repo, worktree, old, body };
}

test("--branch --start-at --continues adopts the old worktree", async () => {
  const { worktree, old, body } = await mkRepo();
  const r = await post("/tasks", body());
  expect(r.status).toBe(201);
  expect(r.body.worktree).toBe(worktree);
  expect(r.body.branch).toBe("feature-x");
  expect(r.body.current_step).toBe("implement");
  expectSuperseded(old.id, r.body.id);
  expect(existsSync(join(worktree, "a.txt"))).toBe(true);
});

test("--continues with a missing branch or a dirty worktree leaves the old task alone", async () => {
  const { worktree, old, body } = await mkRepo();
  const missing = await post("/tasks", body({ branch: "no-such-branch" }));
  expect(missing.status).toBe(400);
  expect(missing.body.error).toContain("no-such-branch");
  const dirt = join(worktree, "dirt.txt");
  writeFileSync(dirt, "x\n");
  const dirty = await post("/tasks", body());
  expect(dirty.status).toBe(400);
  expect(dirty.body.error).toContain("uncommitted changes");
  rmSync(dirt);
  expect(store.getTask(old.id)!.status).toBe("failed");
  expect(store.getTask(old.id)!.superseded_by).toBeNull();
  expect(events(old.id, "task.superseded")).toEqual([]);
});

test("--continues refuses a task that moved on while the worktree was being set up", async () => {
  const { worktree, old, body } = await mkRepo();
  const shim = join(tmp("git-shim"), "git");
  writeFileSync(shim, `#!/bin/sh\nsleep 0.2\nexec git "$@"\n`);
  chmodSync(shim, 0o755);
  process.env.FOREMAN_GIT_BIN = shim;
  const before = store.listTasks({ project: GIT, all: true }).length;
  try {
    const pending = post("/tasks", body());
    await Bun.sleep(50);
    store.updateTask(old.id, { status: "running" });
    const r = await pending;
    expect(r.status).toBe(400);
    expect(r.body.error).toContain(`${old.id} is running`);
    expect(r.body.error).toContain(worktree);
  } finally { delete process.env.FOREMAN_GIT_BIN; }
  expect(store.listTasks({ project: GIT, all: true }).length).toBe(before);
  expect(store.getTask(old.id)!.status).toBe("running");
  expect(store.getTask(old.id)!.superseded_by).toBeNull();
  expect(events(old.id, "task.superseded")).toEqual([]);
});

// ---------------------------------------------------------------- tickets

// tickets.ts reads FOREMAN_LINEAR_URL once at load, so fetch itself is stubbed.
async function withLinear(fn: (comments: { issue: string; body: string }[]) => Promise<void>, failComments = false): Promise<void> {
  const comments: { issue: string; body: string }[] = [];
  mkProject(TICKETS, { tickets: "linear", ticket_states: { start: "Started", review: "Review", done: "Done" } });
  cfg.tickets.linear = { api_key: "test" };
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const { query, variables } = JSON.parse(String(init.body));
    const data = (d: unknown) => new Response(JSON.stringify({ data: d }));
    if (query.includes("issue(id:")) return data({ issue: { id: variables.id, identifier: variables.id, title: "t", url: "u", state: { name: "s" }, team: { id: "team" } } });
    if (query.includes("commentCreate")) {
      if (failComments) return new Response(JSON.stringify({ errors: [{ message: "boom" }] }));
      comments.push({ issue: variables.issueId, body: variables.body });
      return data({ commentCreate: { success: true } });
    }
    throw new Error(`unexpected linear call: ${query}`);
  }) as typeof fetch;
  try { await fn(comments); } finally { globalThis.fetch = savedFetch; }
}
const ticketed = (status: TaskStatus, ticket: string | null) => mkTask(status, { project: TICKETS, ticket });

test("different tickets: one comment on the old ticket and no transition", () => withLinear(async comments => {
  const old = ticketed("failed", "SUP-1"), next = ticketed("running", "SUP-2");
  expect((await close(old.id, next.id)).status).toBe(200);
  expect(comments).toEqual([{ issue: "SUP-1", body: `Continued as ${next.id}` }]);
  expect(events(old.id, "ticket.transition")).toEqual([]);
  expect(events(old.id, "ticket.error")).toEqual([]);
}));

test("a successor without a ticket still gets the comment on the old ticket", () => withLinear(async comments => {
  const old = ticketed("failed", "SUP-1"), next = ticketed("running", null);
  expect((await close(old.id, next.id)).status).toBe(200);
  expect(comments).toEqual([{ issue: "SUP-1", body: `Continued as ${next.id}` }]);
}));

test("a shared ticket or no ticket gets no comment", () => withLinear(async comments => {
  expect((await close(ticketed("failed", "SUP-1").id, ticketed("running", "SUP-1").id)).status).toBe(200);
  expect((await close(ticketed("failed", null).id, ticketed("running", "SUP-2").id)).status).toBe(200);
  expect(comments).toEqual([]);
}));

test("--continues posts the comment too", () => withLinear(async comments => {
  const old = ticketed("failed", "SUP-1");
  const r = await post("/tasks", createBody({ project: TICKETS, continues: old.id }));
  expect(r.status).toBe(201);
  expect(comments).toEqual([{ issue: "SUP-1", body: `Continued as ${r.body.id}` }]);
}));

test("a provider error leaves the task superseded and records ticket.error", () => withLinear(async comments => {
  const old = ticketed("failed", "SUP-1"), next = ticketed("running", "SUP-2");
  expect((await close(old.id, next.id)).status).toBe(200);
  expectSuperseded(old.id, next.id);
  expect(comments).toEqual([]);
  expect(JSON.parse(events(old.id, "ticket.error")[0].data).error).toContain("boom");
}, true));

test("an old task whose project left the config still closes", async () => {
  mkProject("sup-gone");
  const old = mkTask("failed", { project: "sup-gone", ticket: "SUP-1" }), next = mkTask("running");
  delete cfg.projects["sup-gone"];
  expect((await close(old.id, next.id)).status).toBe(200);
  expectSuperseded(old.id, next.id);
  expect(JSON.parse(events(old.id, "ticket.error")[0].data).error).toContain("no longer in config.toml");
});

// ---------------------------------------------------------------- CLI

// A Foreman worker inherits live values for all of these, so every one is
// overridden: never reach the real taskd.
const requests: string[] = [];
const server = Bun.serve({
  port: 0,
  fetch: req => {
    const url = new URL(req.url);
    requests.push(url.pathname + url.search);
    return route(req);
  },
});

async function cli(...args: string[]) {
  requests.length = 0;
  const proc = Bun.spawn([process.execPath, join(REPO_ROOT, "src", "cli.ts"), ...args], {
    env: { ...process.env, FOREMAN_URL: server.url.origin, FOREMAN_TOKEN: token, FOREMAN_CLI_NAME: "task", FOREMAN_HOME: home },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

test("task close closes the task and reports it", async () => {
  const old = mkTask("failed"), next = mkTask("running");
  const { stdout, code } = await cli("close", old.id, "--superseded-by", next.id);
  expect(code).toBe(0);
  expect(stdout.trim()).toBe(`closed ${old.id} as superseded by ${next.id}`);
  expectSuperseded(old.id, next.id);
});

test("task close prints the refusal and exits 1", async () => {
  const old = mkTask("running"), next = mkTask("running");
  const { stderr, code } = await cli("close", old.id, "--superseded-by", next.id);
  expect(code).toBe(1);
  expect(stderr).toContain(`${old.id} is running`);
});

for (const args of [[], ["--superseded-by"], ["--superseded-by", ""]]) {
  test(`task close ${JSON.stringify(args)} exits 1 and makes no request`, async () => {
    const { stdout, stderr, code } = await cli("close", "S-any", ...args);
    expect(code).toBe(1);
    expect(stderr).toContain("error: --superseded-by <id> required");
    expect(stdout).toBe("");
    expect(requests).toEqual([]);
  });
}

test("task create --continues closes the old task", async () => {
  const old = mkTask("failed");
  const { stdout, code } = await cli("create", "--project", P, "--kind", "research", "--title", "cli successor", "--brief", "b", "--continues", old.id, "--json");
  expect(code).toBe(0);
  expectSuperseded(old.id, JSON.parse(stdout).id);
});

test("task create --continues with no value exits 1 and makes no request", async () => {
  const { stderr, code } = await cli("create", "--project", P, "--kind", "research", "--title", "t", "--brief", "b", "--continues");
  expect(code).toBe(1);
  expect(stderr).toContain("error: --continues requires a task id");
  expect(requests).toEqual([]);
});

const LS = "sup-ls";
const statusColumn = (line: string, width: number) => line.slice(7, 7 + width);

test("task ls --all prints the full pointer and widens the column for it", async () => {
  mkProject(LS);
  const old = mkTask("failed", { project: LS }), done = mkTask("done", { project: LS }), next = mkTask("running");
  expect((await close(old.id, next.id)).status).toBe(200);
  const { stdout, code } = await cli("ls", "--all", "--project", LS);
  expect(code).toBe(0);
  const [head, ...rows] = stdout.trimEnd().split("\n");
  const label = `superseded→${next.id}`;
  expect(statusColumn(head, label.length).trimEnd()).toBe("STATUS");
  expect(statusColumn(rows.find(r => r.startsWith(old.id))!, label.length)).toBe(label);
  expect(statusColumn(rows.find(r => r.startsWith(done.id))!, label.length).trimEnd()).toBe("done");
});

test("a listing with no superseded row keeps the 9-wide column", async () => {
  const project = "sup-plain";
  const failed = mkTask("failed", { project });
  const { stdout } = await cli("ls", "--all", "--project", project);
  const [head, row] = stdout.trimEnd().split("\n");
  expect(head.startsWith(`ID     STATUS    PROJECT`)).toBe(true);
  expect(row.startsWith(`${failed.id.padEnd(6)} failed    ${project}`)).toBe(true);
});

test("task show prints the pointer under the status line and --json carries it", async () => {
  const old = mkTask("failed"), next = mkTask("running");
  expect((await close(old.id, next.id)).status).toBe(200);
  const lines = (await cli("show", old.id)).stdout.split("\n");
  const i = lines.findIndex(l => l.startsWith("status: superseded"));
  expect(i).toBeGreaterThan(-1);
  expect(lines[i + 1]).toBe(`superseded by: ${next.id}`);
  expect(JSON.parse((await cli("show", old.id, "--json")).stdout).task.superseded_by).toBe(next.id);
  expect((await cli("show", next.id)).stdout).not.toContain("superseded by:");
});

test("task ls and task inbox leave out superseded tasks", async () => {
  const project = "sup-inbox";
  mkProject(project);
  const fromBlocked = mkBlocked({ project }), fromGate = mkTask("gate", { project, current_step: "plan" }), next = mkTask("running");
  const before = JSON.parse((await cli("inbox", "--project", project, "--json")).stdout);
  expect(before.blocks.length).toBe(1);
  expect(before.gates.length).toBe(1);
  for (const id of [fromBlocked.task.id, fromGate.id]) expect((await close(id, next.id)).status).toBe(200);
  expect((await cli("inbox", "--project", project)).stdout.trim()).toBe("inbox empty");
  expect((await cli("ls", "--project", project)).stdout.trim()).toBe("no tasks");
  expect((await cli("ls", "--all", "--project", project)).stdout).toContain(`superseded→${next.id}`);
});

test("task --help documents close and --continues", async () => {
  const { stdout, code } = await cli("--help");
  expect(code).toBe(0);
  expect(stdout).toContain("task close <id> --superseded-by <other>");
  expect(stdout).toContain("[--continues <id>]");
});
