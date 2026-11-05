// The Decision block (T0050): what the user is asked to decide for a task at a
// gate, with an open question, or failed. Built from rows taskd already loads;
// the only I/O is reading handoff.md / plan-review.md, which never throws.
import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { TaskRow, StepRow, BlockRow, ArtifactRow } from "./db";
import type { PipelineStep } from "./pipelines";

export interface DecisionSection { heading: string; body: string; format: "markdown" | "text" }
export interface Decision {
  kind: "question" | "failed" | "merge" | "plan" | "gate";
  lead: string;
  title: string;
  warning: string | null;
  facts: { label: string; value: string }[];
  verdicts: { step: string; verdict: string; summary: string }[];
  sections: DecisionSection[];
  findings: string[];
  source: "file" | "summary" | null;
  commands: string[];
}
export interface DecisionInput {
  task: TaskRow; steps: StepRow[]; blocks: BlockRow[]; artifacts: ArtifactRow[];
  pipeline: PipelineStep[]; gateLabel: string; maxPlanCycles: number;
}

const MAX_READ = 64 * 1024;
const LEAD_MAX = 120;

// Reads at most 64 KB of an absolute path; null on any error.
export function safeRead(absPath: string): string | null {
  let fd: number | null = null;
  try {
    if (!isAbsolute(absPath) || !existsSync(absPath) || !statSync(absPath).isFile()) return null;
    fd = openSync(absPath, "r");
    const buf = Buffer.alloc(MAX_READ);
    const n = readSync(fd, buf, 0, MAX_READ, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch { return null; }
  finally { if (fd !== null) try { closeSync(fd); } catch {} }
}

// Body of the "## <name>…" section (case-insensitive prefix) up to the next "# " or "## " heading.
export function mdSection(md: string, name: string): string | null {
  const lines = md.split(/\r?\n/);
  const want = name.toLowerCase();
  const start = lines.findIndex(l => /^##\s+/.test(l) && l.replace(/^##\s+/, "").trim().toLowerCase().startsWith(want));
  if (start < 0) return null;
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) { if (/^#{1,2}\s/.test(l)) break; out.push(l); }
  const body = out.join("\n").trim();
  return body || null;
}

// Up to the first ". " or newline, trimmed; markdown bullet/heading markers dropped.
export function firstSentence(s: string): string {
  const t = String(s ?? "").trim().replace(/^(#{1,6}\s+|[-*]\s+)/, "");
  const nl = t.indexOf("\n"); const line = nl < 0 ? t : t.slice(0, nl);
  const dot = line.indexOf(". ");
  return (dot < 0 ? line : line.slice(0, dot + 1)).trim();
}

export function lead(prefix: string, s: string): string {
  const full = `${prefix}: ${String(s ?? "").replace(/\s+/g, " ").trim()}`;
  return full.length <= LEAD_MAX ? full : full.slice(0, LEAD_MAX - 1).trimEnd() + "…";
}

const parse = (s: string | null): any => { if (!s) return null; try { return JSON.parse(s); } catch { return null; } };
const latestWithResult = (steps: StepRow[], name: string) => [...steps].reverse().find(s => s.name === name && s.result) ?? null;

// The review (on_fail agent step) between the previous gate and gateName, when its last verdict is "fail".
export function failingReview(pipeline: PipelineStep[], gateName: string, steps: StepRow[]): { step: string; reviews: number; last: StepRow } | null {
  for (let i = pipeline.findIndex(s => s.name === gateName) - 1; i >= 0; i--) {
    const s = pipeline[i];
    if (s.type === "gate") break;
    if (s.type !== "agent" || !s.on_fail) continue;
    const rows = steps.filter(x => x.name === s.name && x.result);
    const last = rows[rows.length - 1];
    if (!last || parse(last.result)?.verdict !== "fail") return null;
    return { step: s.name, reviews: rows.length, last };
  }
  return null;
}

const FINDING = /^\s*(?:[-*]|\d+\.|\|)\s*(?:\*\*)?\[?\b[A-Z]{1,3}\d{1,3}\b/;
function findingLines(md: string): string[] {
  const lines = md.split(/\r?\n/).map(l => l.trimEnd());
  const hits = lines.filter(l => FINDING.test(l));
  // Drop the list marker and table pipes: the dashboard renders each finding as its own bullet.
  return (hits.length ? hits : lines.filter(l => l.trim())).slice(0, 15)
    .map(l => l.trim().replace(/^[-*]\s+/, "").replace(/^\|\s*|\s*\|$/g, "").replace(/\s*\|\s*/g, " · ").trim());
}

const verdictOf = (row: StepRow | null) => {
  const r = parse(row?.result ?? null);
  return row && r ? { step: row.name, verdict: String(r.verdict ?? row.status), summary: firstSentence(String(r.summary ?? "")) } : null;
};

export function buildDecision(input: DecisionInput, read: (absPath: string) => string | null = safeRead): Decision | null {
  const { task, steps, blocks, artifacts, pipeline } = input;
  const id = task.id;
  const cost = "$" + steps.reduce((a, s) => a + (s.cost_usd || 0), 0).toFixed(2);
  const base = { warning: null, facts: [], verdicts: [], sections: [], findings: [], source: null } as Pick<Decision, "warning" | "facts" | "verdicts" | "sections" | "findings" | "source">;
  const gateCmds = [`task approve ${id}`, `task reject ${id} "<feedback>"`];

  if (blocks.length) {
    const first = blocks[0].question.split(/\r?\n/).find(l => l.trim()) ?? "";
    return {
      ...base, kind: "question", title: "Open question", lead: lead("Question", first),
      facts: blocks.map(b => ({ label: "Block", value: String(b.id) })),
      sections: blocks.map(b => ({ heading: `Block ${b.id}`, body: b.question, format: "text" as const })),
      commands: blocks.map(b => `task answer ${b.id} "<text>"`),
    };
  }

  if (task.status === "failed") {
    const error = String(parse(task.result)?.error ?? "unknown error");
    const group = pipeline.find(s => s.name === task.current_step);
    let row: StepRow | null = null;
    if (group?.type === "parallel") {
      const names = new Set(group.children.map(c => c.name));
      row = [...steps].reverse().find(s => names.has(s.name) && (s.status === "failed" || parse(s.result)?.verdict === "fail")) ?? null;
    }
    row ??= [...steps].reverse().find(s => s.name === task.current_step) ?? null;
    const facts = [{ label: "Step", value: String(task.current_step ?? "?") }];
    if (row) facts.push({ label: "Attempt", value: row.name === task.current_step ? `#${row.attempt}` : `${row.name}#${row.attempt}` });
    facts.push({ label: "Cost", value: cost });
    return {
      ...base, kind: "failed", title: "Failed", lead: lead("Failed", firstSentence(error)), facts,
      sections: [{ heading: "Error", body: error, format: "text" }],
      commands: [`task retry ${id}`, `task retry ${id} --fresh`],
    };
  }

  if (task.status !== "gate") return null;
  const title = input.gateLabel || String(task.current_step ?? "gate");

  if (task.current_step === "merge_approved") {
    const sections: DecisionSection[] = [];
    let source: Decision["source"] = "summary";
    const art = [...artifacts].reverse().find(a => a.path.endsWith("handoff.md"));
    const path = !task.worktree ? null
      : art ? (isAbsolute(art.path) ? art.path : join(task.worktree, art.path))
      : join(task.worktree, task.feature_dir ?? "", "handoff.md");
    const md = path ? read(path) : null;
    const summary = md ? mdSection(md, "Summary") : null;
    if (md && summary) {
      source = "file";
      sections.push({ heading: "Summary", body: summary, format: "markdown" });
      const risk = mdSection(md, "Risk");
      if (risk) sections.push({ heading: "Risk", body: risk, format: "markdown" });
      const fu = mdSection(md, "Follow-up");
      const fuLines = fu ? fu.split(/\r?\n/).filter(l => l.trim()).slice(0, 5) : [];
      if (fuLines.length && !/^none\.?$/i.test(fuLines.join(" ").trim())) sections.push({ heading: "Follow-ups", body: fuLines.join("\n"), format: "markdown" });
    } else {
      const h = parse(latestWithResult(steps, "handoff")?.result ?? null);
      sections.push({ heading: "Handoff summary", body: String(h?.summary ?? "(no handoff summary)"), format: "text" });
    }
    const verdicts = [verdictOf(latestWithResult(steps, "review")), verdictOf(latestWithResult(steps, "test"))].filter(v => v !== null);
    const leadText = firstSentence(sections[0].body);
    return {
      ...base, kind: "merge", title, lead: lead("Merge", leadText || task.title), source, sections, verdicts,
      facts: [{ label: "QA rounds", value: String(task.qa_cycles + 1) }, { label: "Cost", value: cost }],
      commands: gateCmds,
    };
  }

  if (task.current_step === "plan_approved") {
    const plan = parse(latestWithResult(steps, "plan")?.result ?? null);
    const planSummary = String(plan?.summary ?? "(no plan summary)");
    const qa = verdictOf(latestWithResult(steps, "plan_qa"));
    const facts = [{ label: "Cost", value: cost }];
    let warning: string | null = null;
    let findings: string[] = [];
    const fr = failingReview(pipeline, "plan_approved", steps);
    if (fr) {
      warning = `Plan QA still fails after ${fr.reviews} review(s) (max ${input.maxPlanCycles}).`;
      const rel = join(task.feature_dir ?? "specs/<feature>", "qa", "plan-review.md");
      const report = task.worktree ? read(join(task.worktree, rel)) : null;
      if (report) findings = findingLines(report);
      else facts.push({ label: "Report", value: `${rel} (not readable)` });
    }
    return {
      // The gate label already carries the "still fails" note; keep it once, as the warning line.
      ...base, kind: "plan", title: warning ? title.split(" — ")[0] : title, lead: lead("Plan", firstSentence(planSummary)), warning, facts, findings,
      verdicts: qa ? [qa] : [], sections: [{ heading: "Plan", body: planSummary, format: "text" }], source: "summary",
      commands: gateCmds,
    };
  }

  return { ...base, kind: "gate", title, lead: lead("Gate", title), facts: [{ label: "Cost", value: cost }], commands: gateCmds };
}
