// Structured output every worker must end with. The harness enforces it via --json-schema.
export const WORKER_RESULT_SCHEMA = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["done", "blocked", "failed"], description: "done = step complete; blocked = waiting on a `task block` question; failed = could not complete" },
    summary: { type: "string", description: "What was done and what the next worker needs to know. Written for someone who did not see this session." },
    verdict: { type: "string", enum: ["pass", "fail", "n/a"], description: "For review/test/QA steps only: pass or fail. Otherwise n/a." },
    artifacts: { type: "array", items: { type: "object", properties: { path: { type: "string" }, kind: { type: "string" } }, required: ["path", "kind"] } },
    notes_for_next: { type: "string", description: "Short handoff notes for the following step, or empty." },
  },
  required: ["status", "summary", "verdict", "artifacts", "notes_for_next"],
} as const;

export interface WorkerResult {
  status: "done" | "blocked" | "failed";
  summary: string;
  verdict: "pass" | "fail" | "n/a";
  artifacts: { path: string; kind: string }[];
  notes_for_next: string;
}
