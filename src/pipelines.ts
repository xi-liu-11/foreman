// Pipeline templates. A pipeline is a list of named steps. The scheduler walks
// it in order; "parallel" groups run their children together; "gate" steps
// wait for `task approve`. No LLM decides routing: the task kind does.
export type PipelineStep =
  | { type: "agent"; name: string; role: string; prompt: string }
  | { type: "gate"; name: string; label: string }
  | { type: "parallel"; name: string; children: { name: string; role: string; prompt: string }[]; on_fail: string; max_cycles_key: "max_qa_cycles" }
  | { type: "system"; name: string; action: "open_pr" | "merge" };

export interface Pipeline {
  kind: string;
  description: string;
  needs_worktree: boolean;
  steps: PipelineStep[];
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
    description: "Spec Kit feature pipeline: specify, plan, QA the plan, implement, review and test loop, PR.",
    needs_worktree: true,
    steps: [
      { type: "agent", name: "specify", role: "architect", prompt: "specify" },
      { type: "agent", name: "plan", role: "architect", prompt: "plan" },
      { type: "agent", name: "plan_qa", role: "qa-reviewer", prompt: "plan_qa" },
      { type: "gate", name: "plan_approved", label: "Approve the plan" },
      { type: "agent", name: "implement", role: "developer", prompt: "implement" },
      {
        type: "parallel", name: "qa", on_fail: "implement", max_cycles_key: "max_qa_cycles",
        children: [
          { name: "review", role: "qa-reviewer", prompt: "review" },
          { name: "test", role: "test-analyst", prompt: "test" },
        ],
      },
      { type: "agent", name: "pr", role: "developer", prompt: "pr" },
      { type: "system", name: "open_pr", action: "open_pr" },
      { type: "gate", name: "merge_approved", label: "Approve merge" },
      { type: "system", name: "merge", action: "merge" },
    ],
  },
};

export function pipelineFor(kind: string): Pipeline {
  const p = PIPELINES[kind];
  if (!p) throw new Error(`Unknown task kind '${kind}'. Known: ${Object.keys(PIPELINES).join(", ")}`);
  return p;
}
