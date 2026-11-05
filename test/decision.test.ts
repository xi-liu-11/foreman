import { test, expect, afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `fm-dec-${name}-`)));
const home = tmp("home");
process.env.FOREMAN_HOME = home;
// A herdr that always fails, so gate notifications neither reach the real herdr nor stall a tick.
const bin = tmp("bin");
writeFileSync(join(bin, "herdr"), "#!/bin/sh\nexit 1\n");
chmodSync(join(bin, "herdr"), 0o755);
const savedPath = process.env.PATH;
process.env.PATH = `${bin}:${savedPath}`;
const { Store } = await import("../src/db");
const { route, cfg } = await import("../src/taskd");
const { DB_PATH } = await import("../src/config");
// Workers run with FOREMAN_HOME pointing at the live home; never seed that DB.
if (![tmpdir(), realpathSync(tmpdir())].some(d => DB_PATH.startsWith(d))) throw new Error(`refusing to run against ${DB_PATH}`);
const { pipelineFor } = await import("../src/pipelines");
const { buildDecision, mdSection, firstSentence, lead, safeRead } = await import("../src/decision");
import type { TaskRow, StepRow, BlockRow, ArtifactRow } from "../src/db";
import type { DecisionInput } from "../src/decision";

afterAll(() => { process.env.PATH = savedPath; });

const FULL = pipelineFor("implement", true, { merge: "pr", merge_gate: true, tickets: false }).steps;
const LITE = pipelineFor("implement", false, { merge: "pr", merge_gate: true, tickets: false }).steps;
const so = (verdict: string, summary: string) => JSON.stringify({ status: "done", verdict, summary, artifacts: [], notes_for_next: "" });

// ---------------------------------------------------------------- unit: hand-built rows

let sid = 0;
function task(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "T9001", project: "p", kind: "implement", title: "a task", brief: "b", status: "gate", pipeline: JSON.stringify(FULL),
    current_step: "merge_approved", priority: 0, branch: null, worktree: null, feature_dir: "specs/f", ticket: null, pr_url: null,
    superseded_by: null, qa_cycles: 0, plan_cycles: 0, rejection: null, result: null, created_at: "x", updated_at: "x", ...over,
  };
}
function step(name: string, over: Partial<StepRow> = {}): StepRow {
  return {
    id: ++sid, task_id: "T9001", name, role: "r", status: "done", attempt: 1, session_id: null, resume_prompt: null, workspace_id: null,
    tab_id: null, pane_id: null, machine: null, started_at: null, finished_at: null, lease_until: null, result: null, error: null,
    cost_usd: 0, turns: 0, timeout_min: null, created_at: "x", ...over,
  };
}
const block = (id: number, question: string): BlockRow => ({ id, task_id: "T9001", step_id: 1, question, answer: null, created_at: "x", answered_at: null });
const artifact = (path: string): ArtifactRow => ({ id: ++sid, task_id: "T9001", step_id: null, path, kind: "report", note: null, created_at: "x" });
const input = (over: Partial<DecisionInput>): DecisionInput => ({ task: task(), steps: [], blocks: [], artifacts: [], pipeline: FULL, gateLabel: "Approve merge", maxPlanCycles: 3, ...over });

const HANDOFF = `# Handoff

## Summary
Cards collapse to one line. The Decision block is separate.

## Risk
- **Low**: page only, \`taskd\` restart needed.

## Follow-ups
None.
`;
const qaSteps = () => [
  step("handoff", { result: so("n/a", "handoff step summary"), cost_usd: 0.5 }),
  step("review", { result: so("fail", "R1 broken") }),
  step("review", { attempt: 2, result: so("pass", "Looks good. Minor nits."), cost_usd: 1 }),
  step("test", { result: so("pass", "All tests pass."), cost_usd: 0.25 }),
];

test("merge gate reads handoff.md through a relative artifact path", () => {
  const wt = tmp("wt");
  mkdirSync(join(wt, "docs"), { recursive: true });
  writeFileSync(join(wt, "docs/handoff.md"), HANDOFF.replace("None.", "- Add a CLI flag\n- Tidy CSS"));
  const d = buildDecision(input({ task: task({ worktree: wt, qa_cycles: 1 }), steps: qaSteps(), artifacts: [artifact("docs/handoff.md")] }))!;
  expect(d.kind).toBe("merge");
  expect(d.source).toBe("file");
  expect(d.lead).toBe("Merge: Cards collapse to one line.");
  expect(d.sections.map(s => s.heading)).toEqual(["Summary", "Risk", "Follow-ups"]);
  expect(d.sections[2].body).toContain("Add a CLI flag");
  expect(d.verdicts).toEqual([{ step: "review", verdict: "pass", summary: "Looks good." }, { step: "test", verdict: "pass", summary: "All tests pass." }]);
  expect(d.facts).toEqual([{ label: "QA rounds", value: "2" }, { label: "Cost", value: "$1.75" }]);
  expect(d.commands).toEqual(["task approve T9001", 'task reject T9001 "<feedback>"']);
});

test("merge gate falls back to feature_dir/handoff.md, and Follow-ups 'None.' is omitted", () => {
  const wt = tmp("wt");
  mkdirSync(join(wt, "specs/f"), { recursive: true });
  writeFileSync(join(wt, "specs/f/handoff.md"), HANDOFF);
  const d = buildDecision(input({ task: task({ worktree: wt }), steps: qaSteps() }))!;
  expect(d.source).toBe("file");
  expect(d.sections.map(s => s.heading)).toEqual(["Summary", "Risk"]);
  expect(d.sections[1].format).toBe("markdown");
});

test("merge gate with no worktree uses the handoff step summary and never reads", () => {
  let reads = 0;
  const d = buildDecision(input({ steps: qaSteps(), artifacts: [artifact("specs/f/handoff.md")] }), () => { reads++; return null; })!;
  expect(reads).toBe(0);
  expect(d.source).toBe("summary");
  expect(d.sections).toEqual([{ heading: "Handoff summary", body: "handoff step summary", format: "text" }]);
  expect(d.lead).toBe("Merge: handoff step summary");
});

test("merge gate with a gone worktree falls back without throwing", () => {
  const d = buildDecision(input({ task: task({ worktree: "/nonexistent/fm-dec-gone" }), steps: qaSteps() }))!;
  expect(d.source).toBe("summary");
  expect(safeRead("/nonexistent/x")).toBeNull();
  expect(safeRead("relative/path")).toBeNull();
});

test("plan gate (lite, no plan_qa)", () => {
  const d = buildDecision(input({
    task: task({ current_step: "plan_approved", pipeline: JSON.stringify(LITE) }), pipeline: LITE, gateLabel: "Approve the plan",
    steps: [step("plan", { result: so("n/a", "Split the card. Add a builder.") })],
  }))!;
  expect(d.kind).toBe("plan");
  expect(d.title).toBe("Approve the plan");
  expect(d.lead).toBe("Plan: Split the card.");
  expect(d.warning).toBeNull();
  expect(d.verdicts).toEqual([]);
  expect(d.findings).toEqual([]);
  expect(d.commands[0]).toBe("task approve T9001");
});

const planSteps = () => [
  step("plan", { result: so("n/a", "first plan") }),
  step("plan_qa", { status: "skipped", result: so("fail", "C1 HIGH") }),
  step("plan", { attempt: 2, result: so("n/a", "Revised plan. More.") }),
  step("plan_qa", { attempt: 2, result: so("fail", "C1 still HIGH. Details.") }),
];

test("plan gate after max revisions lists the findings from plan-review.md", () => {
  const wt = tmp("wt");
  mkdirSync(join(wt, "specs/f/qa"), { recursive: true });
  writeFileSync(join(wt, "specs/f/qa/plan-review.md"), "# Plan review\n\nIntro text.\n\n- C1 HIGH: retry path missing\n- **H2** medium: naming\n| M3 | low | typo |\n- not a finding\n");
  const d = buildDecision(input({ task: task({ current_step: "plan_approved", worktree: wt }), steps: planSteps(), gateLabel: "Approve the plan — …" }))!;
  expect(d.warning).toBe("Plan QA still fails after 2 review(s) (max 3).");
  expect(d.findings).toEqual(["C1 HIGH: retry path missing", "**H2** medium: naming", "M3 · low · typo"]);
  expect(d.title).toBe("Approve the plan");
  expect(d.verdicts).toEqual([{ step: "plan_qa", verdict: "fail", summary: "C1 still HIGH." }]);
  expect(d.lead).toBe("Plan: Revised plan.");
});

test("plan gate after max revisions with the report missing says so", () => {
  const d = buildDecision(input({ task: task({ current_step: "plan_approved", worktree: tmp("wt") }), steps: planSteps() }))!;
  expect(d.warning).toContain("still fails");
  expect(d.findings).toEqual([]);
  expect(d.facts).toContainEqual({ label: "Report", value: "specs/f/qa/plan-review.md (not readable)" });
});

test("open question keeps newlines and gives the answer command", () => {
  const q = "Which layout?\n(A) one line\n(B) two lines\n(C) <script>x</script>";
  const d = buildDecision(input({ task: task({ status: "blocked", current_step: "implement" }), blocks: [block(17, q)] }))!;
  expect(d.kind).toBe("question");
  expect(d.lead).toBe("Question: Which layout?");
  expect(d.sections).toEqual([{ heading: "Block 17", body: q, format: "text" }]);
  expect(d.commands).toEqual(['task answer 17 "<text>"']);
});

test("question takes precedence over a gate", () => {
  expect(buildDecision(input({ blocks: [block(3, "\n\nfirst real line\nsecond")] }))!.lead).toBe("Question: first real line");
});

test("failed at a single step shows step and attempt", () => {
  const d = buildDecision(input({
    task: task({ status: "failed", current_step: "implement", result: JSON.stringify({ error: "step 'implement' failed 3 times: boom. More." }) }),
    steps: [step("implement", { status: "failed" }), step("implement", { attempt: 3, status: "failed" })],
  }))!;
  expect(d.kind).toBe("failed");
  expect(d.lead).toBe("Failed: step 'implement' failed 3 times: boom.");
  expect(d.facts.slice(0, 2)).toEqual([{ label: "Step", value: "implement" }, { label: "Attempt", value: "#3" }]);
  expect(d.commands).toEqual(["task retry T9001", "task retry T9001 --fresh"]);
});

test("failed at the qa group shows the failed child", () => {
  const d = buildDecision(input({
    task: task({ status: "failed", current_step: "qa", result: JSON.stringify({ error: "QA failed 4 times; last failures: test" }) }),
    steps: [step("review", { attempt: 4, result: so("pass", "ok") }), step("test", { attempt: 4, result: so("fail", "red") })],
  }))!;
  expect(d.facts.slice(0, 2)).toEqual([{ label: "Step", value: "qa" }, { label: "Attempt", value: "test#4" }]);
});

test("failed with an unparsable result does not throw", () => {
  expect(buildDecision(input({ task: task({ status: "failed", current_step: "x", result: "{nope" }) }))!.lead).toBe("Failed: unknown error");
});

test("running task has no decision", () => {
  expect(buildDecision(input({ task: task({ status: "running", current_step: "implement" }) }))).toBeNull();
});

test("lead is cut to 120 chars with an ellipsis, on one line", () => {
  const l = lead("Merge", "word ".repeat(60));
  expect(l.length).toBe(120);
  expect(l.endsWith("…")).toBe(true);
  expect(lead("Q", "a\n  b")).toBe("Q: a b");
});

test("mdSection and firstSentence edge cases", () => {
  expect(mdSection(HANDOFF, "summary")).toBe("Cards collapse to one line. The Decision block is separate.");
  expect(mdSection(HANDOFF, "Follow")).toBe("None.");
  expect(mdSection(HANDOFF, "Missing")).toBeNull();
  expect(mdSection("## Summary\n\n## Risk\nx", "Summary")).toBeNull();
  expect(mdSection("## Summary\n### Sub\ntext\n# Top\nafter", "Summary")).toBe("### Sub\ntext");
  expect(firstSentence("One. Two.")).toBe("One.");
  expect(firstSentence("v1.2 is out\nnext")).toBe("v1.2 is out");
  expect(firstSentence("- bullet text")).toBe("bullet text");
  expect(firstSentence("")).toBe("");
});

// ---------------------------------------------------------------- route: GET /tasks/:id and /dashboard

const store = new Store();
const headers = { authorization: `Bearer ${cfg.server.token}`, "content-type": "application/json" };
async function get(path: string) { return route(new Request(`http://x${path}`, { headers })); }
const seed = (id: string, over: Partial<TaskRow>) => store.insertTask({
  id, project: "dec", kind: "implement", title: id, brief: "b", status: "running", pipeline: JSON.stringify(FULL), current_step: "implement",
  priority: 0, branch: null, worktree: null, feature_dir: "specs/f", ticket: null, pr_url: null, qa_cycles: 0, result: null, ...over,
});

test("GET /tasks/:id has decision null for a running task", async () => {
  const t = seed("DEC1", {});
  store.insertStep({ task_id: t.id, name: "implement", role: "developer", status: "running", attempt: 1 });
  const body: any = await (await get(`/tasks/${t.id}`)).json();
  expect("decision" in body).toBe(true);
  expect(body.decision).toBeNull();
});

test("GET /tasks/:id builds a merge decision from the worktree's handoff.md", async () => {
  const wt = tmp("wt");
  mkdirSync(join(wt, "specs/f"), { recursive: true });
  writeFileSync(join(wt, "specs/f/handoff.md"), HANDOFF);
  const t = seed("DEC2", { status: "gate", current_step: "merge_approved", worktree: wt });
  store.insertStep({ task_id: t.id, name: "merge_approved", role: "system", status: "gate", attempt: 1 });
  const body: any = await (await get(`/tasks/${t.id}`)).json();
  expect(body.decision.kind).toBe("merge");
  expect(body.decision.lead.startsWith("Merge: ")).toBe(true);
  expect(body.task.gate_label).toBe("Approve merge");
});

test("GET /dashboard serves the page with the collapse controls and Decision block", async () => {
  const res = await get("/dashboard");
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  const html = await res.text();
  expect(html).toContain("data-expand");
  expect(html).toContain("Decision");
});
