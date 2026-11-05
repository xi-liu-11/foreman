import { test, expect, spyOn, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import type { Defaults, ProjectConfig, ForemanConfig } from "../src/config";

const tmp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `fm-sto-${name}-`)));
const home = tmp("home");
process.env.FOREMAN_HOME = home;
const bin = tmp("bin");
writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 1\n");
chmodSync(join(bin, "herdr"), 0o755);
const savedPath = process.env.PATH;
process.env.PATH = `${bin}:${savedPath}`;
const { parseStepTimeouts, stepTimeoutMin, DB_PATH, REPO_ROOT } = await import("../src/config");
if (![tmpdir(), realpathSync(tmpdir())].some(d => DB_PATH.startsWith(d))) throw new Error(`refusing to run against ${DB_PATH}`);
const { Store } = await import("../src/db");
const { route, cfg, unknownTimeoutKeys } = await import("../src/taskd");

// Budget resolution (AS-1 to AS-6): project map, then defaults map, then step_timeout_min.
const defaults = (step_timeouts: Record<string, number> = {}) => ({ step_timeout_min: 90, step_timeouts }) as Defaults;
const proj = (name: string, step_timeouts?: Record<string, number>) =>
  ({ name, path: "/x", base_branch: "main", verify: "inspect", speckit: false, deny: [], concurrency: 1, merge: "direct", merge_gate: false, squash: true, ticket_states: {}, resources: [], lease_max_minutes: 45, step_timeouts }) as ProjectConfig;

test("global only: every step gets step_timeout_min", () => {
  expect(stepTimeoutMin(defaults(), proj("a"), "test")).toBe(90);
  expect(stepTimeoutMin(defaults(), undefined, "implement")).toBe(90);
});

test("defaults map overrides the global", () => {
  expect(stepTimeoutMin(defaults({ test: 150 }), proj("a"), "test")).toBe(150);
  expect(stepTimeoutMin(defaults({ test: 150 }), proj("a"), "implement")).toBe(90);
});

test("project map overrides defaults; another project inherits the defaults map", () => {
  const d = defaults({ test: 150 });
  const tt = proj("tackle-tally", { implement: 120, test: 180 });
  expect(stepTimeoutMin(d, tt, "test")).toBe(180);
  expect(stepTimeoutMin(d, tt, "implement")).toBe(120);
  expect(stepTimeoutMin(d, proj("other", {}), "test")).toBe(150);
});

test("unknown step falls back to the global", () => {
  expect(stepTimeoutMin(defaults({ test: 150 }), proj("a", { implement: 120 }), "no_such_step")).toBe(90);
});

test("project map lacking the step uses the defaults map", () => {
  expect(stepTimeoutMin(defaults({ test: 150, review: 30 }), proj("a", { implement: 120 }), "review")).toBe(30);
});

test("inline table and sub-table parse to the same map", () => {
  const inline = Bun.TOML.parse(`[projects.a]\nstep_timeouts = { implement = 120, test = 180 }\n`) as any;
  const sub = Bun.TOML.parse(`[projects.a.step_timeouts]\nimplement = 120\ntest = 180\n`) as any;
  const a = parseStepTimeouts(inline.projects.a.step_timeouts, "projects.a");
  expect(a).toEqual({ implement: 120, test: 180 });
  expect(parseStepTimeouts(sub.projects.a.step_timeouts, "projects.a")).toEqual(a);
});

test("invalid entries are dropped with a warning; non-object gives {}", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const raw = Bun.TOML.parse(`[defaults]\nstep_timeouts = { a = 0, b = -5, c = "x", test = 150 }\n`) as any;
    expect(parseStepTimeouts(raw.defaults.step_timeouts, "defaults")).toEqual({ test: 150 });
    expect(warn).toHaveBeenCalledTimes(3);
    expect(String(warn.mock.calls[0][0])).toContain("defaults.step_timeouts.a");
    warn.mockClear();
    expect(parseStepTimeouts(42, "projects.x")).toEqual({});
    expect(parseStepTimeouts("x", "projects.x")).toEqual({});
    expect(parseStepTimeouts([1], "projects.x")).toEqual({});
    expect(parseStepTimeouts(undefined, "projects.x")).toEqual({});
    expect(String(warn.mock.calls[0][0])).toContain("projects.x");
  } finally { warn.mockRestore(); }
});

// AS-10: a database from before T0045 opens unchanged and gains a null timeout_min.
test("old steps table migrates: rows load unchanged, timeout_min null, then round-trips", () => {
  const path = join(tmp("mig"), "old.db");
  const old = new Database(path, { create: true });
  old.exec(`
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, project TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, brief TEXT NOT NULL,
  status TEXT NOT NULL, pipeline TEXT NOT NULL, current_step TEXT, priority INTEGER NOT NULL DEFAULT 5,
  branch TEXT, worktree TEXT, feature_dir TEXT, ticket TEXT, qa_cycles INTEGER NOT NULL DEFAULT 0,
  rejection TEXT, result TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  name TEXT NOT NULL, role TEXT NOT NULL,
  status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
  session_id TEXT, resume_prompt TEXT,
  workspace_id TEXT, tab_id TEXT, pane_id TEXT, machine TEXT,
  started_at TEXT, finished_at TEXT, lease_until TEXT,
  result TEXT, error TEXT,
  cost_usd REAL NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);`);
  old.run(`INSERT INTO tasks (id, project, kind, title, brief, status, pipeline, created_at, updated_at) VALUES ('OLD1', 'p', 'implement', 't', 'b', 'failed', '[]', 'c', 'u')`);
  old.run(`INSERT INTO steps (task_id, name, role, status, attempt, error, cost_usd, turns, started_at, created_at) VALUES ('OLD1', 'test', 'test-analyst', 'failed', 2, 'timeout after 90 min', 4.5, 77, 's', 'c')`);
  const before = old.query("SELECT * FROM steps").get() as any;
  old.close();
  const store = new Store(path);
  const after = store.getStep(before.id)!;
  // T0054 adds launch_started_at, launched_at and runner_seen_at the same way.
  // T0055 cost columns are added too; the migration copies cost_usd into session_cost_usd.
  const { session_cost_usd, cost_estimated, cost_unknown, ...rest } = after;
  const added = { timeout_min: undefined, launch_started_at: undefined, launched_at: undefined, runner_seen_at: undefined };
  expect({ ...rest, ...added }).toEqual({ ...before, ...added });
  expect([session_cost_usd, cost_estimated, cost_unknown]).toEqual([4.5, 0, 0]);
  expect(after.timeout_min).toBeNull();
  expect([after.launch_started_at, after.launched_at, after.runner_seen_at]).toEqual([null, null, null]);
  expect(store.getTask("OLD1")!.title).toBe("t");
  store.updateStep(before.id, { timeout_min: 120 });
  expect(store.getStep(before.id)!.timeout_min).toBe(120);
});

// AS-4: a step_timeouts key that names no pipeline step is reported.
test("unknownTimeoutKeys reports typos, not real step names", () => {
  const c = { ...cfg, defaults: { ...cfg.defaults, step_timeouts: { test: 150, review: 20 } },
    projects: { tt: { ...proj("tt", { tests: 5, implement: 120, handoff: 10 }) } } } as ForemanConfig;
  expect(unknownTimeoutKeys(c)).toEqual([{ key: "tests", where: "projects.tt" }]);
});

// AS-9: task show prints the budget on running steps only.
test("task show prints budget= for running steps with a recorded budget", async () => {
  const store = new Store();
  const P = "sto-proj";
  cfg.projects[P] = { ...proj(P), path: home, concurrency: 0 };
  const server = Bun.serve({ port: 0, fetch: req => route(req) });
  try {
    store.insertTask({
      id: "STO1", project: P, kind: "implement", title: "budgets", brief: "b", status: "running",
      pipeline: "[]", current_step: "qa", priority: 0, branch: null, worktree: null,
      feature_dir: null, ticket: null, pr_url: null, qa_cycles: 0, result: null,
    });
    const add = (name: string, status: "running" | "done" | "failed" | "queued", timeout_min: number | null) => {
      const s = store.insertStep({ task_id: "STO1", name, role: "test-analyst", status, attempt: 1 });
      store.updateStep(s.id, { timeout_min });
    };
    add("implement", "done", 120);
    add("test", "running", 180);
    add("review", "running", null);
    add("pr", "failed", 90);
    add("handoff", "queued", 150);
    const proc = Bun.spawn([process.execPath, join(REPO_ROOT, "src", "cli.ts"), "show", "STO1"], {
      env: { ...process.env, FOREMAN_URL: server.url.origin, FOREMAN_TOKEN: cfg.server.token, FOREMAN_CLI_NAME: "task", FOREMAN_HOME: home },
      stdout: "pipe", stderr: "pipe",
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(out.match(/budget=/g)?.length).toBe(1);
    expect(out).toMatch(/test .*running.* budget=180min/);
  } finally { server.stop(true); delete cfg.projects[P]; }
});

afterAll(() => { process.env.PATH = savedPath; });

// AS-8: the runner's kill timer and error text use step.timeout_min, and fall
// back to defaults.step_timeout_min when the column is null (pre-T0045 rows).
// Budgets are fractional minutes so the fake worker (slow mode, 12 s) is killed fast.
test("runner kills at step.timeout_min, or the global when null", async () => {
  const store = new Store();
  const P = "sto-run";
  cfg.projects[P] = { ...proj(P), path: home, concurrency: 0 };
  writeFileSync(join(home, "mode"), "slow");
  const savedGlobal = cfg.defaults.step_timeout_min;
  cfg.defaults.step_timeout_min = 0.04; // 2.4 s
  const server = Bun.serve({ port: 0, fetch: req => route(req) });
  const run = async (id: string, timeout_min: number | null) => {
    store.insertTask({
      // The pipeline must hold the step: a tick fails a task whose current step is missing, and the
      // runner's check-in (T0054) then tells it to stop before it writes report.json.
      id, project: P, kind: "research", title: "runner budget", brief: "b", status: "running",
      pipeline: JSON.stringify([{ type: "agent", name: "research", role: "researcher", prompt: "" }]), current_step: "research", priority: 0, branch: null, worktree: null,
      feature_dir: null, ticket: null, pr_url: null, qa_cycles: 0, result: null,
    });
    const s = store.insertStep({ task_id: id, name: "research", role: "researcher", status: "running", attempt: 1 });
    store.updateStep(s.id, { timeout_min, started_at: new Date().toISOString() });
    const proc = Bun.spawn([process.execPath, join(REPO_ROOT, "src", "cli.ts"), "run-step", String(s.id)], {
      env: { ...process.env, FOREMAN_URL: server.url.origin, FOREMAN_TOKEN: cfg.server.token, FOREMAN_HOME: home,
        FOREMAN_CLAUDE_BIN: join(REPO_ROOT, "test", "fake-claude.sh"), FOREMAN_TASK: id, FOREMAN_STEP: String(s.id), FOREMAN_STEP_NAME: "research" },
      stdout: "ignore", stderr: "ignore",
    });
    await proc.exited;
    const report = JSON.parse(readFileSync(join(home, "runs", id, "research-1", "report.json"), "utf8"));
    return { killed: report.killed, row: store.getStep(s.id)! };
  };
  try {
    const recorded = await run("STO2", 0.02); // 1.2 s
    expect(recorded.killed).toBe("timeout after 0.02 min");
    expect(recorded.row.status).toBe("failed");
    expect(recorded.row.error).toBe("timeout after 0.02 min");
    const legacy = await run("STO3", null);
    expect(legacy.killed).toBe("timeout after 0.04 min");
    expect(legacy.row.error).toBe("timeout after 0.04 min");
  } finally {
    server.stop(true); delete cfg.projects[P]; cfg.defaults.step_timeout_min = savedGlobal;
    writeFileSync(join(home, "mode"), "done");
  }
}, 60000);
