// QA fixture (T0048 test round 1): an isolated taskd route server with one
// device lane held (expect 25 min) and two waiters, for a dashboard screenshot.
// Usage: bun dashboard-fixture.ts <port>   (FOREMAN_HOME is set to a temp dir)
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.FOREMAN_HOME = realpathSync(mkdtempSync(join(tmpdir(), "fm-qa-dash-")));
const { Store } = await import(join(import.meta.dir, "../../../../src/db"));
const { route, cfg } = await import(join(import.meta.dir, "../../../../src/taskd"));
const { requestLease } = await import(join(import.meta.dir, "../../../../src/leases"));
const P = "tackle-tally";
const groups = [{ name: "devices", members: ["ios-sim", "android-emu"], capacity: 1 }];
cfg.projects = { [P]: { name: P, path: "/nonexistent", base_branch: "main", verify: "inspect", speckit: true, deny: [], concurrency: 3, merge: "direct", merge_gate: false, squash: true, ticket_states: {}, resources: ["android-emu", "ios-sim"], lease_max_minutes: 45, resource_groups: groups, device_steps: ["implement", "test"], device_steps_running: 2 } as any };
const store = new Store();
const mk = (id: string, step: string, qa: number, title: string) => {
  const t = store.insertTask({ id, project: P, kind: "implement", title, brief: "b", status: "running", pipeline: "[]", current_step: step, priority: 5, branch: null, worktree: null, feature_dir: null, ticket: null, pr_url: null, qa_cycles: qa, result: null });
  const s = store.insertStep({ task_id: id, name: step, role: step === "test" ? "test-analyst" : "developer", status: "running", attempt: 1 });
  store.updateStep(s.id, { started_at: new Date(Date.now() - 10 * 60_000).toISOString() });
  return { t, s: store.getStep(s.id)! };
};
const a = mk("T0101", "test", 1, "Scoreboard export");
const b = mk("T0102", "implement", 0, "Offline sync");
const c = mk("T0103", "test", 0, "Roster editor");
const opts = (expect_min: number | null) => ({ expect_min, groupsOf: (p: string) => p === P ? groups : [], fallbackMin: 45 });
requestLease(store, a.t, a.s, "ios-sim", "full matrix", ["android-emu", "ios-sim"], opts(25));
store.db.run("UPDATE resource_leases SET granted_at = ? WHERE task_id = 'T0101'", [new Date(Date.now() - 6 * 60_000).toISOString()]);
requestLease(store, b.t, b.s, "android-emu", "touched flows", ["android-emu", "ios-sim"], opts(15));
requestLease(store, c.t, c.s, "ios-sim", "full matrix", ["android-emu", "ios-sim"], opts(20));
Bun.serve({ port: Number(process.argv[2] ?? 7791), hostname: "127.0.0.1", fetch: req => route(req) });
console.log(`token=${cfg.server.token}`);
