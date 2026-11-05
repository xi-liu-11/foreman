import { test, expect, afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `fm-cacc-${name}-`)));
const home = tmp("home");
process.env.FOREMAN_HOME = home;
const claudeDir = tmp("claude");
const savedClaude = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = claudeDir;
// A herdr that always fails, so notifications neither reach the real herdr nor stall a tick.
const bin = tmp("bin");
writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 1\n");
chmodSync(join(bin, "herdr"), 0o755);
const savedPath = process.env.PATH;
process.env.PATH = `${bin}:${savedPath}`;
const { DB_PATH, RUNS_DIR } = await import("../src/config");
if (![tmpdir(), realpathSync(tmpdir())].some(d => DB_PATH.startsWith(d))) throw new Error(`refusing to run against ${DB_PATH}`);
const { Store } = await import("../src/db");
const { route, cfg, tick } = await import("../src/taskd");
const { pipelineFor } = await import("../src/pipelines");
import type { StepRow } from "../src/db";

const store = new Store();
const headers = { authorization: `Bearer ${cfg.server.token}`, "content-type": "application/json" };
const P = "cost-acc", P2 = "cost-acc-2";
const projCfg = (name: string) => ({ name, path: home, base_branch: "main", verify: "inspect" as const, speckit: false, deny: [], concurrency: 0, merge: "direct" as const, merge_gate: true, squash: true, ticket_states: {}, resources: [], lease_max_minutes: 60, resource_groups: [], device_steps: [], device_steps_running: 1 });
cfg.projects[P] = projCfg(P);
cfg.projects[P2] = projCfg(P2);
afterAll(() => {
  delete cfg.projects[P]; delete cfg.projects[P2];
  process.env.PATH = savedPath;
  if (savedClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = savedClaude;
  for (const d of [claudeDir, bin]) rmSync(d, { recursive: true, force: true });
});

const PIPELINE = pipelineFor("implement", false, { merge: "direct", merge_gate: true, tickets: false }).steps;
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
let tid = 0;
function newTask(project = P): string {
  const id = `CA${++tid}`;
  store.insertTask({
    id, project, kind: "implement", title: `costs ${tid}`, brief: "b", status: "running",
    pipeline: JSON.stringify(PIPELINE), current_step: "implement", priority: 0, branch: null, worktree: `/fake/wt/${id}`,
    feature_dir: null, ticket: null, pr_url: null, qa_cycles: 0, result: null,
  });
  return id;
}
function attempt(task_id: string, session_id: string | null, machine: string | null = null): StepRow {
  const n = store.stepsForTask(task_id).length + 1;
  const s = store.insertStep({ task_id, name: "implement", role: "developer", status: "running", attempt: n, session_id, machine });
  store.updateStep(s.id, { started_at: ago(10) });
  return store.getStep(s.id)!;
}
async function report(step: StepRow, body: object): Promise<StepRow> {
  const res = await route(new Request(`http://x/steps/${step.id}/result`, { method: "POST", headers, body: JSON.stringify(body) }));
  expect(res.status).toBe(200);
  return store.getStep(step.id)!;
}
const result = (session_id: string, total_cost_usd: number, num_turns: number) => ({
  exit_code: 0, session_id,
  result: { type: "result", total_cost_usd, num_turns, structured_output: { status: "failed", verdict: "n/a", summary: "x", notes_for_next: "", artifacts: [] } },
});
const killed = (session_id: string | null) => ({ exit_code: 143, killed: "timeout after 90 min", session_id, result: null });

// A session log for the task's worktree: two opus messages (one duplicated) inside the window, one before it.
// Priced at the defaults: m1 = 1000*4 + 2000*20 = 44000 / 1e6; m2 = 10000*0.2 + 1000*8 = 10000 / 1e6.
const EST = 0.054;
function writeLog(task_id: string, sid: string, dir = `-fake-wt-${task_id}`) {
  const d = join(claudeDir, "projects", dir);
  mkdirSync(d, { recursive: true });
  const row = (id: string, ts: string, usage: object) => JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model: "claude-opus-5-5", usage } });
  writeFileSync(join(d, `${sid}.jsonl`), [
    row("old", ago(60), { input_tokens: 99999, output_tokens: 99999 }),
    row("m1", ago(5), { input_tokens: 1000, output_tokens: 10 }),
    row("m1", ago(5), { input_tokens: 1000, output_tokens: 2000 }),
    row("m2", ago(4), { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 10000, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 } }),
  ].join("\n") + "\n");
}

test("AS-1/2/3: first attempt, resumed attempt, new session mid-task", async () => {
  const t = newTask();
  const a1 = await report(attempt(t, null), result("S1", 7.84, 5));
  expect(a1.cost_usd).toBeCloseTo(7.84, 9);
  expect(a1.session_cost_usd).toBe(7.84);
  expect([a1.cost_estimated, a1.cost_unknown]).toEqual([0, 0]);
  const a2 = await report(attempt(t, "S1"), result("S1", 19.16, 10));
  expect(a2.cost_usd).toBeCloseTo(11.32, 9);
  expect(a2.session_cost_usd).toBe(19.16);
  expect(a2.turns).toBe(10);
  const a3 = await report(attempt(t, null), result("S2", 6.77, 146));
  expect(a3.cost_usd).toBeCloseTo(6.77, 9);
  expect(a3.session_cost_usd).toBe(6.77);
  const ev = store.eventsForTask(t, 100).find(e => e.type === "step.failed" && e.step_id === a2.id)!;
  expect(JSON.parse(ev.data)).toMatchObject({ session_cost_usd: 19.16, estimated: false, unknown: false });
  expect(JSON.parse(ev.data).cost_usd).toBeCloseTo(11.32, 9);
  const res = await route(new Request(`http://x/tasks?all=1&project=${P}`, { headers }));
  const row = (await res.json() as any[]).find(x => x.id === t);
  expect(row.cost_usd).toBeCloseTo(7.84 + 11.32 + 6.77, 9);
  expect([row.cost_estimated, row.cost_unknown]).toEqual([0, 0]);
});

test("AS-4/5: kill with a local session log is estimated; the resumed attempt subtracts it", async () => {
  const t = newTask();
  const a1 = await report(attempt(t, null), result("S4", 2, 3));
  writeLog(t, "S4");
  const k = await report(attempt(t, "S4"), killed("S4"));
  expect(k.status).toBe("failed");
  expect(k.cost_estimated).toBe(1);
  expect(k.cost_unknown).toBe(0);
  expect(k.cost_usd).toBeCloseTo(EST, 9);
  expect(k.turns).toBe(2);
  expect(k.session_cost_usd!).toBeCloseTo(a1.session_cost_usd! + EST, 9);
  const r = await report(attempt(t, "S4"), result("S4", 3, 4));
  expect(r.cost_usd).toBeCloseTo(3 - 2 - EST, 9);
  expect(r.cost_estimated).toBe(0);
  const row = (await (await route(new Request(`http://x/tasks?all=1&project=${P}`, { headers }))).json() as any[]).find(x => x.id === t);
  expect(row.cost_usd).toBeCloseTo(3, 9);
  expect(row.cost_estimated).toBe(1);
});

test("AS-6: kill with no session log (or no session id) is unknown, and the next resume absorbs it", async () => {
  const t = newTask();
  const a1 = await report(attempt(t, null), result("S6", 5, 3));
  const k = await report(attempt(t, "S6"), killed("S6"));
  expect([k.cost_usd, k.turns, k.cost_estimated, k.cost_unknown]).toEqual([0, 0, 0, 1]);
  expect(k.session_cost_usd).toBe(a1.session_cost_usd);
  const r = await report(attempt(t, "S6"), result("S6", 8, 2));
  expect(r.cost_usd).toBeCloseTo(3, 9);
  const t2 = newTask();
  const n = await report(attempt(t2, null), killed(null));
  expect([n.cost_usd, n.cost_unknown, n.session_cost_usd]).toEqual([0, 1, null]);
  const row = (await (await route(new Request(`http://x/tasks?all=1&project=${P}`, { headers }))).json() as any[]).find(x => x.id === t2);
  expect([row.cost_usd, row.cost_estimated, row.cost_unknown]).toEqual([0, 0, 1]);
});

test("remote machine: runner usage is priced; no usage is unknown; an unpriced model is unknown", async () => {
  const t = newTask();
  const usage = { models: { "claude-sonnet-5-5-20261101": { input: 1e6, output: 1e5, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 } }, api_calls: 7 };
  writeLog(t, "SR"); // present locally, but a remote step never reads taskd's own logs
  const a = await report(attempt(t, "SR", "mini"), { ...killed("SR"), usage });
  expect(a.cost_usd).toBeCloseTo(3, 9);
  expect([a.turns, a.cost_estimated, a.cost_unknown]).toEqual([7, 1, 0]);
  const b = await report(attempt(t, "SR", "mini"), killed("SR"));
  expect([b.cost_usd, b.cost_unknown]).toEqual([0, 1]);
  const c = await report(attempt(t, "SR", "mini"), { ...killed("SR"), usage: { models: { "gpt-9": usage.models["claude-sonnet-5-5-20261101"] }, api_calls: 1 } });
  expect([c.cost_usd, c.cost_estimated, c.cost_unknown]).toEqual([0, 0, 1]);
});

test("AS-7: lease expiry estimates from the log, via steps.session_id or the transcript init line", async () => {
  const t1 = newTask();
  writeLog(t1, "S7a");
  const s1 = attempt(t1, "S7a");
  const t2 = newTask();
  writeLog(t2, "S7b");
  const s2 = attempt(t2, null);
  const runDir = join(RUNS_DIR, t2, "implement-1");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "transcript.jsonl"), JSON.stringify({ type: "system", subtype: "init", session_id: "S7b", model: "claude-opus-5-5" }) + "\n");
  const t3 = newTask();
  const s3 = attempt(t3, null);
  for (const s of [s1, s2, s3]) store.updateStep(s.id, { lease_until: ago(1) });
  await tick();
  for (const s of [s1, s2]) {
    const row = store.getStep(s.id)!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("lease expired");
    expect(row.cost_estimated).toBe(1);
    expect(row.cost_usd).toBeCloseTo(EST, 9);
    expect(row.turns).toBe(2);
  }
  const r3 = store.getStep(s3.id)!;
  expect(r3.error).toContain("lease expired");
  expect([r3.cost_usd, r3.cost_unknown]).toEqual([0, 1]);
});

test("T0057 AS-2: a result recovered from transcript.jsonl records the per-attempt delta", async () => {
  const t = newTask();
  const s1 = await report(attempt(t, "S57a"), result("S57a", 3, 2));
  expect(s1.session_cost_usd).toBe(3);
  const s2 = attempt(t, "S57a");
  const runDir = join(RUNS_DIR, t, `implement-${s2.attempt}`);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "transcript.jsonl"), [
    { type: "system", subtype: "init", session_id: "S57a", model: "claude-opus-5-5" },
    { ...result("S57a", 5, 4).result, session_id: "S57a" },
  ].map(e => JSON.stringify(e)).join("\n") + "\n");
  store.updateStep(s2.id, { lease_until: ago(1), launch_started_at: ago(10), launched_at: ago(10), runner_seen_at: ago(2) });
  await tick();
  const row = store.getStep(s2.id)!;
  expect(row.status).toBe("failed");
  expect([row.cost_usd, row.session_cost_usd, row.turns, row.cost_estimated, row.cost_unknown]).toEqual([2, 5, 4, 0, 0]);
  const recovered = store.eventsForTask(t, 100).filter(e => e.type === "step.result_recovered" && e.step_id === s2.id);
  expect(recovered.map(e => JSON.parse(e.data).source)).toEqual(["transcript"]);
});

test("T0057 AS-3: an attempt whose runner never started costs a known zero, even with a session log", async () => {
  const t = newTask();
  writeLog(t, "S57b");
  const s = attempt(t, "S57b");
  store.updateStep(s.id, { lease_until: ago(1), launch_started_at: ago(12), launched_at: ago(11) });
  await tick();
  const row = store.getStep(s.id)!;
  expect(row.status).toBe("failed");
  expect(row.error).toStartWith("runner never started");
  expect(store.eventsForTask(t, 100).filter(e => e.type === "step.never_started" && e.step_id === s.id)).toHaveLength(1);
  expect([row.cost_usd, row.turns, row.cost_estimated, row.cost_unknown, row.session_cost_usd]).toEqual([0, 0, 0, 0, null]);
});

test("AS-10: /costs/today counts only steps finished today, per project and overall", async () => {
  const before = await (await route(new Request("http://x/costs/today", { headers }))).json() as any;
  const a = newTask(P), b = newTask(P2);
  const fin = (task: string, cost: number, finished_at: string, estimated = 0, unknown = 0) => {
    const s = store.insertStep({ task_id: task, name: "review", role: "reviewer", status: "done", attempt: 1 });
    store.updateStep(s.id, { cost_usd: cost, finished_at, cost_estimated: estimated, cost_unknown: unknown });
  };
  const d = new Date();
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  fin(a, 10, new Date(midnight.getTime() + 1000).toISOString());
  fin(a, 100, new Date(midnight.getTime() - 1000).toISOString()); // yesterday
  fin(b, 2, now(), 1);
  fin(b, 0, now(), 0, 1);
  const res = await route(new Request("http://x/costs/today", { headers }));
  expect(res.status).toBe(200);
  const body = await res.json() as any;
  expect(body.day).toBe(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  const pa = body.projects[P], pb = body.projects[P2];
  const pa0 = before.projects[P] ?? { usd: 0, estimated: 0, unknown: 0, steps: 0 };
  expect(pa.usd - pa0.usd).toBeCloseTo(10, 9);
  expect(pa.steps - pa0.steps).toBe(1);
  expect(pb).toEqual({ usd: 2, estimated: 1, unknown: 1, steps: 2 });
  const sum = Object.values<any>(body.projects).reduce((x, p) => x + p.usd, 0);
  expect(body.total.usd).toBeCloseTo(sum, 9);
  expect(body.total.estimated).toBe(Object.values<any>(body.projects).reduce((x, p) => x + p.estimated, 0));
});

const now = () => new Date().toISOString();
