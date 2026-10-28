// Pipeline templates. A pipeline is a list of named steps. The scheduler walks
// it in order; "parallel" groups run their children together; "gate" steps
// wait for `task approve`; "system" steps are run by the scheduler itself.
// No LLM decides routing: the task kind (and whether the project uses Spec Kit) does.
export type PipelineStep =
  | { type: "agent"; name: string; role: string; prompt: string }
  | { type: "gate"; name: string; label: string }
  | { type: "parallel"; name: string; children: { name: string; role: string; prompt: string }[]; on_fail: string; max_cycles_key: "max_qa_cycles" }
  | { type: "system"; name: string; action: "open_pr" | "merge" | "merge_direct" };

export interface Pipeline {
  kind: string;
  description: string;
  needs_worktree: boolean;
  steps: PipelineStep[];
}

const QA: PipelineStep = {
  type: "parallel", name: "qa", on_fail: "implement", max_cycles_key: "max_qa_cycles",
  children: [
    { name: "review", role: "qa-reviewer", prompt: "review" },
    { name: "test", role: "test-analyst", prompt: "test" },
  ],
};
// The handoff step writes specs/<feature>/handoff.md (PR body or merge message,
// plain-language summary and verify steps) and updates the linked ticket.
const HANDOFF: PipelineStep = { type: "agent", name: "handoff", role: "developer", prompt: "handoff" };
const QA_AND_PR: PipelineStep[] = [
  QA,
  HANDOFF,
  { type: "system", name: "open_pr", action: "open_pr" },
  { type: "gate", name: "merge_approved", label: "Approve merge" },
  { type: "system", name: "merge", action: "merge" },
];

export interface MergeOptions { merge: "pr" | "direct"; merge_gate: boolean; tickets: boolean }

// Direct-merge projects skip the PR. The handoff step stays whenever someone
// reads it before the merge (a gate) or a ticket needs the plain-language update.
function tailFor(o: MergeOptions): PipelineStep[] {
  if (o.merge === "pr") return QA_AND_PR;
  const steps: PipelineStep[] = [QA];
  if (o.merge_gate || o.tickets) steps.push(HANDOFF);
  if (o.merge_gate) steps.push({ type: "gate", name: "merge_approved", label: "Approve merge to base branch" });
  steps.push({ type: "system", name: "merge", action: "merge_direct" });
  return steps;
}

export const PIPELINES: Record<string, Pipeline> = {
  research: {
    kind: "research",
    description: "Investigate a question and write a cited report under specs/research/.",
    needs_worktree: false,
    steps: [{ type: "agent", name: "research", role: "researcher", prompt: "research" }],
  },
  design: {
    kind: "design",
    description: "Produce a solution design with options and a recommendation under specs/design/.",
    needs_worktree: false,
    steps: [{ type: "agent", name: "design", role: "architect", prompt: "design" }],
  },
  triage: {
    kind: "triage",
    description: "Investigate a bug or issue, reproduce it, and write a triage report with a proposed fix.",
    needs_worktree: false,
    steps: [{ type: "agent", name: "triage", role: "test-analyst", prompt: "triage" }],
  },
  implement: {
    kind: "implement",
    description: "Spec Kit feature on its own worktree: specify, plan, plan QA, gate, implement, review and test loop, PR, merge gate.",
    needs_worktree: true,
    steps: [
      { type: "agent", name: "specify", role: "architect", prompt: "specify" },
      { type: "agent", name: "plan", role: "architect", prompt: "plan" },
      { type: "agent", name: "plan_qa", role: "qa-reviewer", prompt: "plan_qa" },
      { type: "gate", name: "plan_approved", label: "Approve the plan" },
      { type: "agent", name: "implement", role: "developer", prompt: "implement" },
      ...QA_AND_PR,
    ],
  },
  implement_lite: {
    kind: "implement_lite",
    description: "Same loop for projects without Spec Kit: plan, gate, implement, review and test loop, PR, merge gate.",
    needs_worktree: true,
    steps: [
      { type: "agent", name: "plan", role: "architect", prompt: "plan_lite" },
      { type: "gate", name: "plan_approved", label: "Approve the plan" },
      { type: "agent", name: "implement", role: "developer", prompt: "implement_lite" },
      ...QA_AND_PR,
    ],
  },
};

// `implement` resolves to the Spec Kit or lite variant depending on the project,
// and its tail to PR or direct merge depending on the project's merge mode.
export function pipelineFor(kind: string, speckit = true, opts: MergeOptions = { merge: "pr", merge_gate: true, tickets: false }): Pipeline {
  if (kind === "implement" && !speckit) kind = "implement_lite";
  const p = PIPELINES[kind];
  if (!p) throw new Error(`Unknown task kind '${kind}'. Known: ${Object.keys(PIPELINES).filter(k => k !== "implement_lite").join(", ")}`);
  if (!p.needs_worktree) return p;
  const i = p.steps.indexOf(QA);
  return { ...p, steps: [...p.steps.slice(0, i), ...tailFor(opts)] };
}
