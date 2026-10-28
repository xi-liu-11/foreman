// Seeds a throwaway FOREMAN_HOME for the route/CLI smoke (scenarios 8, 10).
// Each live step is the only step of its own running task so isLive() holds.
const { Store } = await import("../../../../src/db");
const store = new Store(process.argv[2]);
const far = new Date(Date.now() + 3600_000).toISOString();
const pipeline = JSON.stringify([{ type: "agent", name: "test", role: "test-analyst" }]);
const mk = (id: string, project: string, tstatus: any, sstatus: any, machine: string | null = null) => {
  store.insertTask({ id, project, kind: "feature", title: id, brief: "b", status: tstatus, pipeline, current_step: "test", priority: 0, branch: null, worktree: null, feature_dir: null, ticket: null, pr_url: null, qa_cycles: 0, result: null });
  const s = store.insertStep({ task_id: id, name: "test", role: "test-analyst", status: sstatus, attempt: 1, machine });
  store.updateStep(s.id, { lease_until: far, started_at: new Date().toISOString() });
  console.log(`${id} step=${s.id}`);
};
mk("T0001", "P", "running", "running");
mk("T0002", "P", "running", "running");
mk("T0003", "P", "running", "running");
mk("T0004", "P", "done", "done");          // fencing: finished step
mk("T0005", "P", "cancelled", "running");  // fencing: step row running, task cancelled
mk("T0006", "P", "running", "running", "mini");
mk("T0007", "Q", "running", "running");
