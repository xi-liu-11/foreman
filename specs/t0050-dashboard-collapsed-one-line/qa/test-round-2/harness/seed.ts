const { Store } = await import("/Users/xi/git/.worktrees/foreman/fm-t0050-dashboard-collapsed-one-line/src/db.ts");
const { pipelineFor } = await import("/Users/xi/git/.worktrees/foreman/fm-t0050-dashboard-collapsed-one-line/src/pipelines.ts");
const s = new Store(); const H = process.env.FOREMAN_HOME!;
const P = JSON.stringify(pipelineFor("implement", true).steps);
const so = (v: string, sum: string) => JSON.stringify({ status: "done", verdict: v, summary: sum, artifacts: [], notes_for_next: "" });
const ago = (m: number) => new Date(Date.now() - m * 60000).toISOString();
let n = 0;
const T = (o: any) => s.insertTask({ id: `T${String(++n).padStart(4, "0")}`, project: "demo", kind: "implement", brief: "b", status: "running", pipeline: P, current_step: "implement", priority: 0, branch: null, worktree: null, feature_dir: "specs/f", ticket: null, pr_url: null, qa_cycles: 0, result: null, ...o });
const st = (t: any, name: string, status: string, o: any = {}) => { const r = s.insertStep({ task_id: t.id, name, role: "x", status, attempt: o.attempt ?? 1 }); s.updateStep(r.id, { started_at: ago(o.min ?? 5), cost_usd: o.cost ?? 0.4, lease_until: new Date(Date.now() + 864e5).toISOString(), ...(o.result ? { result: o.result } : {}) }); return r; };
const done = (t: any, names: string[]) => names.forEach(x => st(t, x, "done", { result: so("pass", `${x} ok`) }));
// T0001 merge gate with handoff.md (scenario 4, 11)
const m = T({ title: "Dashboard: collapsed one-line cards, Decision block separate from Activity", status: "gate", current_step: "merge_approved", worktree: `${H}/wt`, qa_cycles: 2, branch: "fm/t0001-dash" });
done(m, ["specify", "plan", "plan_qa", "implement"]); st(m, "review", "done", { result: so("pass", "No blocking findings. Two nits.") }); st(m, "test", "done", { result: so("pass", "161 tests pass. Smoke ok.") }); st(m, "handoff", "done", { result: so("n/a", "handoff written") }); st(m, "merge_approved", "gate");
// T0002 merge gate, worktree removed (scenario 5)
const g = T({ title: "Merge gate with worktree gone", status: "gate", current_step: "merge_approved", worktree: `${H}/gone`, qa_cycles: 1 });
done(g, ["specify", "plan", "plan_qa", "implement", "review", "test"]); st(g, "handoff", "done", { result: so("n/a", "Fallback summary from the handoff step. Second sentence.") }); st(g, "merge_approved", "gate");
// T0003 plan gate after max revisions (scenario 6)
const p = T({ title: "Retry policy for flaky device steps", status: "gate", current_step: "plan_approved", worktree: `${H}/wt2`, feature_dir: "specs/g" });
s.updateTask(p.id, { plan_cycles: 2 });
st(p, "specify", "done", { result: so("n/a", "spec") }); st(p, "plan", "done", { result: so("n/a", "Plan v1.") }); st(p, "plan_qa", "done", { result: so("fail", "C1 open.") });
st(p, "plan", "done", { attempt: 2, result: so("n/a", "Add a retry budget per step class. Backoff 30s.") }); st(p, "plan_qa", "done", { attempt: 2, result: so("fail", "C1 HIGH still open. H2 medium.") }); st(p, "plan_approved", "gate");
// T0004 blocked (scenario 7, 11)
const b = T({ title: "Choose the lane policy for <script>alert(1)</script> devices", status: "blocked", current_step: "plan" });
const bs = st(b, "plan", "blocked"); s.insertBlock(b.id, bs.id, "Which grant order should the lane use? \"quotes\" & amp\n(A) FIFO by request time\n(B) Priority, then FIFO\n(C) <script>alert('x')</script> shortest hold first");
// T0005 failed (scenario 8)
const f = T({ title: "Migrate tickets provider to v2 API", status: "failed", current_step: "implement", result: JSON.stringify({ error: "step 'implement' failed 3 times: lease expired: runner stopped heartbeating" }) });
st(f, "plan", "done", { result: so("n/a", "p") }); st(f, "implement", "failed", { attempt: 1 }); st(f, "implement", "failed", { attempt: 2 }); st(f, "implement", "failed", { attempt: 3 });
// T0006..T0015: ten running tasks; lanes: holders + waiters
const titles = ["Add the widget to the settings page with a very long title that should be ellipsised nicely at the end", "Fix flaky lease test", "Ticket sync for Linear states", "Spec Kit numbering for features", "Device lane metrics", "Budget overrun alerts", "Herdr tab reuse on retry", "Cost report per project", "Worktree cleanup after merge", "Smoke harness port isolation"];
const ids: any = {};
titles.forEach((title, i) => { const t = T({ title, current_step: i % 3 ? "implement" : "qa" }); ids[i] = t; done(t, ["specify", "plan", "plan_qa"]);
  if (i % 3) st(t, "implement", "running", { min: 3 + i * 4 });
  else { st(t, "implement", "done", { result: so("n/a", "x") }); const ts = st(t, "test", "running", { min: 7 + i });
    const res = i === 0 ? "sim-a" : i === 3 ? "sim-a" : i === 6 ? "phone-a" : "phone-a";
    const l = s.insertLease({ project: "demo", machine: "local", resource: res, task_id: t.id, step_id: ts.id, reason: "ui flows", expect_min: 20 });
    if (i === 0 || i === 6) s.grantLease(l.id); }
  s.event("note", { text: `note for ${title}` }, t.id); });
for (let i = 0; i < 4; i++) T({ title: `Done task ${i}`, status: "done", current_step: null });
console.log("seeded", n);
