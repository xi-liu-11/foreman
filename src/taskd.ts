// taskd: the Foreman scheduler daemon. Single writer to the SQLite store,
// HTTP API for the CLI and workers, and a deterministic tick loop that walks
// each task's pipeline. No LLM runs here.
//
// Resilience rules (see specs/research/crash-recovery-risks-in-taskd.md):
// - Results and heartbeats are fenced: only the current running attempt counts.
// - Any runner whose step is no longer running is told to stop on its next heartbeat.
// - Startup extends every running lease so a long taskd outage does not mass-expire.
// - Before expiring a lease, a report.json left by the runner is applied as its result.
// - Multi-write state changes run inside a transaction; herdr side effects come after.
// - Resume after an answer happens in the scheduler, not in the HTTP handler.
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { Store, CLOSED_STATUSES, type TaskRow, type StepRow, now } from "./db";
import { loadConfig, denyListFor, stepTimeoutMin, deviceResources, REPO_ROOT, RUNS_DIR, type ForemanConfig, type ProjectConfig } from "./config";
import { requestLease, releaseLease, releaseStepLeases, reconcileLeases, leaseView, devicePrompt } from "./leases";
import { pipelineFor, PIPELINES, type PipelineStep } from "./pipelines";
import * as herdr from "./herdr";
import * as git from "./git";
import { providerFor, ticketContext, type Ticket } from "./tickets";

export const cfg: ForemanConfig = loadConfig();
const store = new Store();
let herdrOk = false;
const cancelRequested = new Set<number>(); // step ids whose runner should stop
let ticking = false;

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "task";
const addSeconds = (sec: number) => new Date(Date.now() + sec * 1000).toISOString();
const tx = <T>(fn: () => T): T => store.db.transaction(fn)();

function project(task: TaskRow): ProjectConfig {
  const p = cfg.projects[task.project];
  if (!p) throw new Error(`project '${task.project}' is no longer in config.toml`);
  return p;
}
// Pipelines stored before T0035 have plan_qa without on_fail; read them as the loop.
const pipelineSteps = (task: TaskRow) => (JSON.parse(task.pipeline) as PipelineStep[]).map(s =>
  s.type === "agent" && s.name === "plan_qa" && !s.on_fail ? { ...s, on_fail: "plan", max_cycles_key: "max_plan_cycles" as const } : s);
const agentDefs = (steps: PipelineStep[]) => steps.flatMap(p => p.type === "parallel" ? p.children : p.type === "agent" ? [p] : []);
const runDirFor = (task: TaskRow, step: StepRow) => join(RUNS_DIR, task.id, `${step.name}-${step.attempt}`);
// R2: only the current running attempt of an active task may heartbeat or take resource leases.
const isLive = (step: StepRow) => {
  const task = store.getTask(step.task_id);
  return step.status === "running" && store.latestStep(step.task_id, step.name)?.id === step.id && Boolean(task && ["running", "queued", "blocked"].includes(task.status));
};

// ---------------------------------------------------------------- tickets
// Ticket side effects are best-effort: they are logged as events and never
// change a task's state. Workers reach the provider through /tickets routes.

const ticketCache = new Map<string, { at: number; t: Ticket }>();
async function fetchTicket(proj: ProjectConfig, ref: string, maxAgeMs = 60_000): Promise<Ticket | null> {
  const provider = providerFor(cfg, proj);
  if (!provider) return null;
  const key = `${proj.name}:${ref}`;
  const hit = ticketCache.get(key);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.t;
  const t = await provider.get(ref);
  ticketCache.set(key, { at: Date.now(), t });
  return t;
}

// Comment on the task's ticket and optionally move it to a configured state.
async function ticketHook(task: TaskRow, stage: "start" | "review" | "done" | "failed" | "note", body: string): Promise<void> {
  if (!task.ticket) return;
  const proj = project(task);
  let provider; try { provider = providerFor(cfg, proj); } catch (e: any) { store.event("ticket.error", { stage, error: e.message }, task.id); return; }
  if (!provider) return;
  try {
    await provider.comment(task.ticket, body);
    store.event("ticket.comment", { ref: task.ticket, body }, task.id);
    const state = stage === "failed" || stage === "note" ? undefined : proj.ticket_states[stage];
    if (state) {
      const name = await provider.transition(task.ticket, state);
      store.event("ticket.transition", { ref: task.ticket, state: name }, task.id);
    }
    ticketCache.delete(`${proj.name}:${task.ticket}`);
  } catch (e: any) {
    store.event("ticket.error", { stage, ref: task.ticket, error: e.message }, task.id);
    log(`ticket ${task.ticket} (${stage}) failed: ${e.message}`);
  }
}

// Failures of a step since the user last retried it. Blocked rows and resumed
// attempts do not count, so block/answer cycles never eat the retry budget.
function failureCount(task_id: string, name: string): number {
  const rows = store.stepsForTask(task_id).filter(s => s.name === name);
  let count = 0;
  for (const s of rows) {
    if (s.status === "failed") count++;
    if (s.resume_prompt?.startsWith("[user-retry]")) count = 0;
  }
  return count;
}

// ---------------------------------------------------------------- scheduler

async function expireLeases(): Promise<void> {
  for (const s of store.runningSteps()) {
    if (!s.lease_until || s.lease_until >= now()) continue;
    const task = store.getTask(s.task_id)!;
    // R4 fallback: the runner may have finished but failed to deliver its result.
    const reportPath = join(runDirFor(task, s), "report.json");
    if (existsSync(reportPath)) {
      try {
        const body = JSON.parse(readFileSync(reportPath, "utf8"));
        log(`lease expired for ${s.task_id}/${s.name}#${s.attempt}; applying report.json left by the runner`);
        store.event("step.result_recovered", { step: s.name, attempt: s.attempt }, s.task_id, s.id);
        await handleResult(s, body);
        continue;
      } catch (e: any) { log(`report.json unreadable for ${s.task_id}/${s.name}#${s.attempt}: ${e.message}`); }
    }
    log(`lease expired for ${s.task_id}/${s.name}#${s.attempt}`);
    store.updateStep(s.id, { status: "failed", finished_at: now(), error: "lease expired: runner stopped heartbeating" });
    store.event("step.lease_expired", { step: s.name, attempt: s.attempt }, s.task_id, s.id);
    releaseStepLeases(store, s.id, "heartbeat lease expired");
    cancelRequested.add(s.id);
    if (s.tab_id) await herdr.closeTab(s.tab_id, s.machine);
  }
}

export async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await expireLeases();
    try { reconcileLeases(store, p => cfg.projects[p]?.lease_max_minutes ?? cfg.defaults.lease_max_minutes); }
    catch (e: any) { log("reconcile resource leases failed:", e.message); store.event("scheduler.error", { error: `resource leases: ${e.message}` }); }
    for (const { id } of store.listTasks({ status: ["queued", "running", "blocked"] })) {
      // Earlier iterations await, so this task may have been closed since the listing.
      const task = store.getTask(id);
      if (!task || !["queued", "running", "blocked"].includes(task.status)) continue;
      try { await advance(task); } catch (e: any) { log(`advance ${task.id} failed:`, e.message); store.event("scheduler.error", { error: e.message }, task.id); }
    }
  } finally { ticking = false; }
}

function moveTo(task: TaskRow, name: string | null): TaskRow {
  store.updateTask(task.id, { current_step: name, status: "running" });
  store.event("task.step", { step: name }, task.id);
  return store.getTask(task.id)!;
}

async function advance(task: TaskRow): Promise<void> {
  const steps = pipelineSteps(task);
  if (task.current_step === "__end__") return finishTask(task);
  let idx = task.current_step ? steps.findIndex(s => s.name === task.current_step) : 0;
  if (idx < 0) return failTask(task, `current step '${task.current_step}' is not in the pipeline`);
  const ps = steps[idx];
  const next = () => advance(moveTo(task, steps[idx + 1]?.name ?? "__end__"));

  if (ps.type === "agent") {
    const latest = store.latestStep(task.id, ps.name);
    // A 'skipped' row was sent back by a review loop or a reject; run a fresh attempt.
    if (!latest || latest.status === "skipped") return createStep(task, ps.name, ps.role, (latest?.attempt ?? 0) + 1);
    return settle(task, latest, ps.role, ps.on_fail ? () => reviewed(task, ps, latest, steps, next) : next);
  }

  if (ps.type === "gate") {
    const latest = store.latestStep(task.id, ps.name);
    if (latest?.status === "done") return next();
    // A 'skipped' gate row was rejected; the revised work needs a fresh approval.
    if (!latest || latest.status === "skipped") {
      const label = gateLabel(task, ps);
      tx(() => {
        store.insertStep({ task_id: task.id, name: ps.name, role: "user", status: "gate", attempt: (latest?.attempt ?? 0) + 1 });
        store.updateTask(task.id, { status: "gate", rejection: null });
        store.event("task.gate", { gate: ps.name, label }, task.id);
      });
      await herdr.notify(`${task.id} needs approval`, `${label}: ${task.title}`, "request");
    }
    return;
  }

  if (ps.type === "parallel") {
    let allDone = true;
    for (const child of ps.children) {
      const latest = store.latestStep(task.id, child.name);
      // A 'skipped' row is a previous QA cycle; the new cycle needs a fresh attempt.
      if (!latest || latest.status === "skipped") { await createStep(task, child.name, child.role, (latest?.attempt ?? 0) + 1); allDone = false; continue; }
      if (latest.status !== "done") { await settle(task, latest, child.role, async () => {}); allDone = false; }
    }
    if (!allDone) return;
    const verdicts = ps.children.map(c => {
      const s = store.latestStep(task.id, c.name)!;
      const r = s.result ? JSON.parse(s.result) : {};
      return { name: c.name, verdict: r.verdict ?? "n/a" };
    });
    const failed = verdicts.filter(v => v.verdict === "fail");
    if (!failed.length) return next();
    const cycles = task.qa_cycles + 1;
    if (cycles > cfg.defaults[ps.max_cycles_key]) return failTask(task, `QA failed ${cycles} times; last failures: ${failed.map(f => f.name).join(", ")}`);
    const target = steps.find(s => s.name === ps.on_fail);
    if (!target || target.type !== "agent") return failTask(task, `on_fail target '${ps.on_fail}' is not an agent step`);
    const prev = store.latestStep(task.id, target.name);
    tx(() => {
      store.event("task.qa_fail", { cycle: cycles, failed: failed.map(f => f.name) }, task.id);
      store.updateTask(task.id, { qa_cycles: cycles, current_step: target.name, status: "queued" });
      // New attempt row so the target's latest status is 'queued', not 'done'.
      // QA_FEEDBACK is assembled in the context endpoint from the failed verdicts.
      store.insertStep({ task_id: task.id, name: target.name, role: target.role, status: "queued", attempt: (prev?.attempt ?? 0) + 1 });
      for (const c of ps.children) { const s = store.latestStep(task.id, c.name)!; store.updateStep(s.id, { status: "skipped" }); }
    });
    return advance(store.getTask(task.id)!);
  }

  if (ps.type === "system") {
    const latest = store.latestStep(task.id, ps.name);
    // A 'skipped' row (reject at a later gate) falls through to a fresh run below.
    if (latest?.status === "done") return next();
    if (latest?.status === "running") return;
    if (latest?.status === "failed" && failureCount(task.id, ps.name) >= cfg.defaults.max_attempts) {
      return failTask(task, `system step '${ps.name}' failed ${failureCount(task.id, ps.name)} times: ${latest.error}`);
    }
    return runSystem(task, ps, (latest?.attempt ?? 0) + 1);
  }
}

// A done review step with on_fail (plan_qa). A "fail" sends the target back with
// the findings (QA_FEEDBACK in the context endpoint) until max_cycles_key reviews
// have run; then the task moves on to the gate, whose label carries the warning.
// A "fail" never fails the task and never counts against max_attempts.
async function reviewed(task: TaskRow, ps: Extract<PipelineStep, { type: "agent" }>, latest: StepRow, steps: PipelineStep[], next: () => Promise<void>): Promise<void> {
  const r = latest.result ? JSON.parse(latest.result) : {};
  if (r.verdict !== "fail") return next();
  const cycle = task.plan_cycles + 1;
  const revising = cycle < cfg.defaults[ps.max_cycles_key ?? "max_plan_cycles"];
  const summary = String(r.summary ?? "");
  if (!revising) {
    // Emitted once: next() moves current_step to the gate in this same pass.
    store.event("task.plan_qa_fail", { cycle, revising: false, summary }, task.id, latest.id);
    return next();
  }
  const target = steps.find(s => s.name === ps.on_fail);
  if (!target || target.type !== "agent") return failTask(task, `on_fail target '${ps.on_fail}' is not an agent step`);
  const prev = store.latestStep(task.id, target.name);
  tx(() => {
    store.event("task.plan_qa_fail", { cycle, revising: true, summary }, task.id, latest.id);
    store.updateTask(task.id, { plan_cycles: cycle, current_step: target.name, status: "queued" });
    store.insertStep({ task_id: task.id, name: target.name, role: target.role, status: "queued", attempt: (prev?.attempt ?? 0) + 1 });
    store.updateStep(latest.id, { status: "skipped" });
  });
  return advance(store.getTask(task.id)!);
}

// The gate's label, plus a warning when the review before it (plan_qa) still fails.
function gateLabel(task: TaskRow, gate?: PipelineStep): string {
  const steps = pipelineSteps(task);
  const ps = gate ?? steps.find(s => s.name === task.current_step);
  if (!ps || ps.type !== "gate") return "";
  for (let i = steps.findIndex(s => s.name === ps.name) - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.type === "gate") break;
    if (s.type !== "agent" || !s.on_fail) continue;
    const rows = store.stepsForTask(task.id).filter(x => x.name === s.name && x.result);
    const last = rows[rows.length - 1];
    if (!last || JSON.parse(last.result!).verdict !== "fail") break;
    return `${ps.label} — plan QA still fails after ${rows.length} review(s); see ${task.feature_dir ?? "specs/<feature>"}/qa/plan-review.md`;
  }
  return ps.label;
}

// The step a reject at the gate at gateIdx sends work back to: the on_fail target
// of the nearest review before the gate, else the nearest agent step.
function rejectTarget(steps: PipelineStep[], gateIdx: number): { target: string; via: PipelineStep } | null {
  let fallback: PipelineStep | null = null;
  for (let i = gateIdx - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.type === "gate") break;
    if ((s.type === "agent" || s.type === "parallel") && s.on_fail) return { target: s.on_fail, via: s };
    if (s.type === "agent" && !fallback) fallback = s;
  }
  return fallback ? { target: fallback.name, via: fallback } : null;
}

// System steps run inside taskd: push and open the PR, or merge it.
async function runSystem(task: TaskRow, ps: Extract<PipelineStep, { type: "system" }>, attempt: number): Promise<void> {
  const proj = project(task);
  const step = tx(() => {
    const s = store.insertStep({ task_id: task.id, name: ps.name, role: "system", status: "running", attempt });
    store.updateTask(task.id, { status: "running" });
    store.event("step.started", { step: ps.name, attempt, system: true }, task.id, s.id);
    return s;
  });
  try {
    if (!task.worktree || !task.branch) throw new Error("task has no worktree");
    let summary: string;
    const handoffFile = task.feature_dir ? join(task.worktree, task.feature_dir, "handoff.md") : null;
    const handoff = handoffFile && existsSync(handoffFile) ? readFileSync(handoffFile, "utf8") : "";
    // "## Summary" section of the handoff, for ticket comments and commit messages.
    const handoffSummary = handoff.match(/## Summary\s*\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() ?? "";
    if (ps.action === "open_pr") {
      const url = await git.pushAndOpenPr(proj, task.worktree, task.branch, task.title, handoffFile);
      store.updateTask(task.id, { pr_url: url });
      summary = `PR opened: ${url}`;
      await herdr.notify(`${task.id} PR opened`, url, "done");
      // The handoff step already posted the plain-language update; this is the administrative line.
      await ticketHook(task, "note", `PR opened for review: ${url} (Foreman ${task.id})`);
    } else if (ps.action === "merge_direct") {
      const impl = [...store.stepsForTask(task.id)].reverse().find(s => s.name === "implement" && s.status === "done" && s.result);
      const implSummary = impl?.result ? JSON.parse(impl.result).summary ?? "" : "";
      const body = handoff || implSummary;
      const message = `${task.title}\n\n${body}\n\nForeman ${task.id}${task.ticket ? ` (${task.ticket})` : ""}, QA passed after ${task.qa_cycles + 1} cycle(s).`;
      summary = await git.mergeDirect(proj, task.worktree, task.branch, message, proj.squash);
      await git.removeWorktree(proj, task.worktree);
      await git.deleteBranch(proj, task.branch);
      await herdr.notify(`${task.id} merged`, summary, "done");
      await ticketHook(task, "done", `${handoffSummary || task.title}\n\nMerged to ${proj.base_branch} (Foreman ${task.id}).`);
    } else {
      if (!task.pr_url) throw new Error("no PR URL recorded; open_pr must run first");
      await git.mergePr(proj, task.worktree, task.pr_url);
      await git.removeWorktree(proj, task.worktree);
      summary = `Merged ${task.pr_url} and removed worktree`;
      await ticketHook(task, "done", `${handoffSummary || task.title}\n\nMerged ${task.pr_url} (Foreman ${task.id}).`);
    }
    tx(() => {
      store.updateStep(step.id, { status: "done", finished_at: now(), result: JSON.stringify({ status: "done", summary, verdict: "n/a", artifacts: [], notes_for_next: "" }) });
      store.event("step.done", { step: ps.name, attempt, summary }, task.id, step.id);
    });
    log(`system ${task.id}/${ps.name}: ${summary}`);
    setTimeout(tick, 50);
  } catch (e: any) {
    tx(() => {
      store.updateStep(step.id, { status: "failed", finished_at: now(), error: e.message });
      store.event("step.failed", { step: ps.name, attempt, error: e.message }, task.id, step.id);
    });
    log(`system ${task.id}/${ps.name} failed: ${e.message}`);
    // Let the user fix the cause (remote, auth, dirty tree) rather than hammering git.
    await failTask(task, `${ps.name}: ${e.message}`);
  }
}

// Decide what to do with the latest attempt row of an agent step.
async function settle(task: TaskRow, latest: StepRow, role: string, onDone: () => Promise<void>): Promise<void> {
  switch (latest.status) {
    case "done": return onDone();
    case "queued": return tryLaunch(task, latest);
    case "running": return;
    case "blocked": {
      // R6: resume lives here. Once every question on this attempt is answered, start the next attempt.
      if (store.openBlocks(task.id).some(b => b.step_id === latest.id)) return;
      const answered = store.blocksForStep(latest.id).filter(b => b.answer && b.answer !== "(task cancelled)" && b.answer !== "(task superseded)");
      if (!answered.length) return;
      const resume = `The user answered your question(s):\n\n${answered.map(x => `Q: ${x.question}\nA: ${x.answer}`).join("\n\n")}\n\nContinue the step from where you left off.`;
      await createStep(task, latest.name, role, latest.attempt + 1, latest.session_id, resume);
      if (latest.tab_id) await herdr.closeTab(latest.tab_id, latest.machine);
      return;
    }
    case "failed": {
      if (isStopped(task)) return;
      const failures = failureCount(task.id, latest.name);
      if (failures >= cfg.defaults.max_attempts) return failTask(task, `step '${latest.name}' failed ${failures} times: ${latest.error ?? "unknown error"}`);
      const resume = latest.session_id
        ? `Your previous attempt at this step ended without completing (${latest.error ?? "unknown error"}). Continue from where you left off; check the working tree and any tasks.md ticks before redoing work.`
        : null;
      return createStep(task, latest.name, role, latest.attempt + 1, latest.session_id, resume);
    }
    default: return; // gate, skipped
  }
}

async function createStep(task: TaskRow, name: string, role: string, attempt: number, session_id: string | null = null, resume_prompt: string | null = null): Promise<void> {
  const step = tx(() => {
    const s = store.insertStep({ task_id: task.id, name, role, status: "queued", attempt, session_id, resume_prompt, machine: project(task).machine ?? null });
    store.event("step.queued", { step: name, attempt }, task.id, s.id);
    store.updateTask(task.id, { status: "queued", current_step: task.current_step ?? name });
    return s;
  });
  await tryLaunch(store.getTask(task.id)!, step);
}

async function tryLaunch(task: TaskRow, step: StepRow): Promise<void> {
  const proj = project(task);
  if (store.runningCount() >= cfg.defaults.concurrency) return;
  if (store.runningCount(task.project) >= proj.concurrency) return;
  const cwd = task.worktree ?? proj.path;
  if (!existsSync(cwd)) { store.updateStep(step.id, { status: "failed", finished_at: now(), error: `cwd missing: ${cwd}` }); return; }

  tx(() => {
    store.updateStep(step.id, { status: "running", started_at: now(), lease_until: addSeconds(cfg.defaults.lease_sec), timeout_min: stepTimeoutMin(cfg.defaults, proj, step.name) });
    store.updateTask(task.id, { status: "running" });
  });
  const env: Record<string, string> = {
    FOREMAN_URL: `http://${cfg.server.bind === "0.0.0.0" ? "127.0.0.1" : cfg.server.bind}:${cfg.server.port}`,
    FOREMAN_TOKEN: cfg.server.token,
    FOREMAN_TASK: task.id,
    FOREMAN_STEP: String(step.id),
    FOREMAN_STEP_NAME: step.name,
  };
  // Spec Kit helpers resolve the feature from this when the checkout is a worktree.
  if (task.feature_dir && proj.speckit) env.SPECIFY_FEATURE = task.feature_dir.replace(/^specs\//, "");
  // Test hook: substitute a stub for the claude binary (see README, Testing).
  if (process.env.FOREMAN_CLAUDE_BIN) env.FOREMAN_CLAUDE_BIN = process.env.FOREMAN_CLAUDE_BIN;
  if (process.env.FOREMAN_HOME) env.FOREMAN_HOME = process.env.FOREMAN_HOME;
  const command = [join(REPO_ROOT, "bin", "foreman"), "run-step", String(step.id)];
  try {
    if (herdrOk) {
      const ws = await herdr.ensureWorkspace(`fm:${task.project}`, proj.path, proj.machine);
      const pane = await herdr.launchInTab({ workspace_id: ws, label: `${task.id} ${step.name}`, cwd, env, command, machine: proj.machine });
      store.updateStep(step.id, { workspace_id: pane.workspace_id, tab_id: pane.tab_id, pane_id: pane.pane_id });
    } else {
      // Fallback without herdr. Known limitation: the child shares taskd's process
      // group, so a Ctrl-C on taskd also interrupts it (macOS has no setsid).
      const runDir = join(RUNS_DIR, task.id, `${step.name}-${step.attempt}`);
      mkdirSync(runDir, { recursive: true });
      const out = Bun.file(join(runDir, "console.log"));
      Bun.spawn(command, { cwd, env: { ...process.env, ...env }, stdout: out, stderr: out, stdin: "ignore" }).unref();
    }
    store.event("step.started", { step: step.name, attempt: step.attempt, herdr: herdrOk }, task.id, step.id);
    log(`started ${task.id}/${step.name}#${step.attempt} (${herdrOk ? "herdr tab" : "background process"})`);
  } catch (e: any) {
    store.updateStep(step.id, { status: "failed", finished_at: now(), error: `launch failed: ${e.message}` });
    store.event("step.launch_failed", { error: e.message }, task.id, step.id);
  }
}

async function finishTask(task: TaskRow): Promise<void> {
  const steps = store.stepsForTask(task.id);
  const last = [...steps].reverse().find(s => s.status === "done" && s.result);
  const summary = last?.result ? JSON.parse(last.result).summary : "";
  tx(() => {
    store.updateTask(task.id, { status: "done", current_step: null, result: JSON.stringify({ summary }) });
    store.event("task.done", { summary }, task.id);
  });
  for (const s of steps) if (s.tab_id) await herdr.closeTab(s.tab_id, s.machine);
  await herdr.notify(`${task.id} done`, task.title, "done");
  log(`done ${task.id}`);
}

async function failTask(task: TaskRow, reason: string): Promise<void> {
  const running = store.stepsForTask(task.id).filter(s => s.status === "running");
  tx(() => {
    store.updateTask(task.id, { status: "failed", result: JSON.stringify({ error: reason }) });
    store.event("task.failed", { reason }, task.id);
    for (const s of running) releaseStepLeases(store, s.id, "task failed");
  });
  // R2: siblings still running (parallel QA) must stop.
  for (const s of running) cancelRequested.add(s.id);
  await herdr.notify(`${task.id} failed`, reason, "request");
  log(`failed ${task.id}: ${reason}`);
  await ticketHook(task, "failed", `Foreman ${task.id} failed: ${reason}`);
}

// Cancelled and superseded tasks ignore whatever their workers still report.
const isStopped = (t: TaskRow) => t.status === "cancelled" || t.status === "superseded";

// Shared by cancel and supersede. Caller holds the transaction.
function stopTask(task: TaskRow, why: "cancelled" | "superseded"): void {
  for (const b of store.openBlocks(task.id)) store.answerBlock(b.id, `(task ${why})`);
  for (const s of store.stepsForTask(task.id).filter(s => s.status === "running")) {
    releaseStepLeases(store, s.id, `task ${why}`);
    cancelRequested.add(s.id);
  }
}

const cannotSupersede = (t: TaskRow): string | null => ["failed", "cancelled", "gate", "blocked"].includes(t.status)
  ? null : `${t.id} is ${t.status}; only failed, cancelled, gate or blocked tasks can be closed as superseded`;

// Caller holds the transaction.
function markSuperseded(task: TaskRow, successorId: string): void {
  stopTask(task, "superseded");
  store.updateTask(task.id, { status: "superseded", superseded_by: successorId });
  store.event("task.superseded", { superseded_by: successorId, message: `superseded by ${successorId}` }, task.id);
  store.event("task.continues", { continues: task.id, message: `continues ${task.id}` }, successorId);
}

// Best-effort, after the commit. A shared ticket is covered by the successor's own comments.
async function noteContinued(task: TaskRow, successor: TaskRow): Promise<void> {
  if (task.ticket && task.ticket !== successor.ticket)
    await ticketHook(task, "note", `Continued as ${successor.id}`)
      .catch((e: any) => { store.event("ticket.error", { stage: "note", ref: task.ticket, error: e.message }, task.id); });
}

// ---------------------------------------------------------------- results

async function handleResult(step: StepRow, body: any): Promise<{ step_status: string; task_status: string }> {
  const task = store.getTask(step.task_id)!;
  const r = body.result ?? {};
  const so = r.structured_output ?? null;
  let status: "done" | "blocked" | "failed";
  let error: string | null = null;
  if (body.killed) { status = "failed"; error = String(body.killed); }
  else if (so?.status === "done" || so?.status === "blocked" || so?.status === "failed") { status = so.status; if (status === "failed") error = so.summary; }
  else if (r.is_error || body.exit_code !== 0) { status = "failed"; error = r.subtype ?? r.result ?? body.stderr_tail?.trim().split("\n").pop() ?? `exit ${body.exit_code}`; }
  else if (r.subtype && r.subtype !== "success") { status = "failed"; error = r.subtype; }
  else { status = "failed"; error = "worker ended without structured output"; }
  if (isStopped(task)) { status = "failed"; error = error ?? task.status; }

  tx(() => {
    store.updateStep(step.id, {
      status, finished_at: now(), error,
      session_id: body.session_id ?? step.session_id,
      result: so ? JSON.stringify(so) : null,
      cost_usd: Number(r.total_cost_usd ?? 0), turns: Number(r.num_turns ?? 0),
      lease_until: null,
    });
    store.event(`step.${status}`, { step: step.name, attempt: step.attempt, cost_usd: r.total_cost_usd ?? 0, turns: r.num_turns ?? 0, error, summary: so?.summary ?? null, verdict: so?.verdict ?? null }, task.id, step.id);
    const known = new Set(store.artifactsForTask(task.id).map(a => a.path));
    for (const a of so?.artifacts ?? []) if (a?.path && !known.has(a.path)) { store.insertArtifact(task.id, step.id, a.path, a.kind ?? "file", null); known.add(a.path); }
    if (status === "blocked") {
      // Only add a placeholder question when the worker never registered one (answered or open).
      if (!store.blocksForStep(step.id).length) store.insertBlock(task.id, step.id, so?.summary ?? "Worker reported blocked without a question.");
      if (!isStopped(task)) store.updateTask(task.id, { status: "blocked" });
    }
    releaseStepLeases(store, step.id, `step ${status}`);
  });
  cancelRequested.delete(step.id);

  if (status === "blocked" && store.openBlocks(task.id).length) {
    await herdr.notify(`${task.id} is blocked`, store.openBlocks(task.id).map(b => b.question).join(" | ").slice(0, 200), "request");
  } else if (status === "done" && step.tab_id) {
    await herdr.closeTab(step.tab_id, step.machine);
  }
  log(`result ${task.id}/${step.name}#${step.attempt}: ${status}${error ? " (" + error + ")" : ""}`);
  setTimeout(tick, 50);
  return { step_status: status, task_status: store.getTask(task.id)!.status };
}

async function stepContext(step: StepRow) {
  const task = store.getTask(step.task_id)!;
  const proj = project(task);
  let ticket = "";
  if (task.ticket) {
    try { const t = await fetchTicket(proj, task.ticket); if (t) ticket = ticketContext(t); }
    catch (e: any) { ticket = `## Linked ticket ${task.ticket}\n(could not be fetched: ${e.message})`; }
  }
  const ps = pipelineSteps(task);
  const def = agentDefs(ps).find(p => p.name === step.name);
  const promptName = def?.prompt ?? step.name;
  const promptFile = join(REPO_ROOT, "prompts", `${promptName}.md`);
  const step_prompt = existsSync(promptFile) ? readFileSync(promptFile, "utf8") : "";

  // QA_FEEDBACK: a pending user rejection, then the findings of the reviews that send work back to this step.
  let qaFeedback = "";
  const parts: string[] = [];
  let header = "";
  const rejection = task.rejection ? JSON.parse(task.rejection) as { gate: string; target: string; feedback: string } : null;
  if (rejection && rejection.target === step.name) {
    parts.push(`### The user rejected this at ${rejection.gate}\n${rejection.feedback}`);
    header = "The user sent this back with feedback. Address it, and any review findings below, before anything else:";
  }
  const lastResult = (name: string) => {
    const rows = store.stepsForTask(task.id).filter(s => s.name === name && s.result);
    const last = rows[rows.length - 1];
    return last?.result ? JSON.parse(last.result) : null;
  };
  for (const reviewer of ps.filter(p => (p.type === "parallel" || p.type === "agent") && p.on_fail === step.name)) {
    if (reviewer.type === "parallel" && task.qa_cycles > 0) {
      const found = reviewer.children.map(c => {
        const r = lastResult(c.name);
        return r ? `### ${c.name} (${r.verdict})\n${r.summary}\n${r.notes_for_next ?? ""}` : "";
      }).filter(Boolean);
      if (found.length) { parts.push(...found); header ||= `This is QA cycle ${task.qa_cycles}. Address the following QA findings before anything else:`; }
    } else if (reviewer.type === "agent") {
      const r = lastResult(reviewer.name);
      if (r?.verdict === "fail") {
        parts.push(`### ${reviewer.name} (fail)\n${r.summary}\n${r.notes_for_next ?? ""}\nFull review: ${task.feature_dir ?? "specs/<feature>"}/qa/plan-review.md`);
        header ||= `This is plan revision ${task.plan_cycles}. Address the following plan QA findings before anything else:`;
      }
    }
  }
  if (parts.length) qaFeedback = `\n\n${header}\n\n${parts.join("\n\n")}`;

  const prompt_vars: Record<string, string> = {
    TASK_ID: task.id, TASK_TITLE: task.title, STEP_NAME: step.name, ATTEMPT: String(step.attempt),
    PROJECT: task.project, CWD: task.worktree ?? proj.path, VERIFY: proj.verify,
    PROJECT_NOTES: proj.notes ? `- Project notes: ${proj.notes}` : "",
    SLUG: slugify(task.title), FEATURE: (task.feature_dir ?? "").replace(/^specs\//, ""), BASE_BRANCH: proj.base_branch,
    QA_CYCLE: String(task.qa_cycles + 1), QA_FEEDBACK: qaFeedback, PLAN_CYCLE: String(task.plan_cycles + 1),
    DEVICE_LEASES: devicePrompt(deviceResources(proj), step.role),
    TICKET: ticket, TICKET_REF: task.ticket ?? "",
    TICKET_HANDOFF: task.ticket
      ? `\nThen post the Summary and To verify sections as a comment on ticket ${task.ticket} with \`task ticket comment "<text>"\` (one quoted argument, markdown allowed)${proj.ticket_states.review ? ` and move it with \`task ticket transition "${proj.ticket_states.review}"\`` : ""}. The ticket's readers are not developers; write for them.`
      : "",
  };
  return { step, task, project: proj, defaults: cfg.defaults, deny: denyListFor(cfg, proj), prompt_vars, step_prompt };
}

// ---------------------------------------------------------------- HTTP API

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const bad = (msg: string, status = 400) => json({ error: msg }, status);

export async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (p === "/health") return json({ ok: true, herdr: herdrOk, running: store.runningCount() });
  // The dashboard page is static; it authenticates its own API calls with the token it was opened with.
  if (p === "/dashboard" || p === "/") return new Response(Bun.file(join(REPO_ROOT, "src", "dashboard.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
  if (req.headers.get("authorization") !== `Bearer ${cfg.server.token}`) return bad("unauthorized", 401);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const m = (re: RegExp) => p.match(re);
  let mm: RegExpMatchArray | null;

  if (p === "/projects" && req.method === "GET") return json(Object.values(cfg.projects));

  if (p === "/tasks" && req.method === "GET") {
    const status = url.searchParams.get("status")?.split(",").filter(Boolean);
    const tasks = store.listTasks({ status, project: url.searchParams.get("project") ?? undefined, all: url.searchParams.get("all") === "1" });
    return json(tasks.map(t => ({ ...t, gate_label: t.status === "gate" ? gateLabel(t) : null, open_blocks: store.openBlocks(t.id).length, cost_usd: store.stepsForTask(t.id).reduce((a, s) => a + s.cost_usd, 0) })));
  }
  if (p === "/tasks" && req.method === "POST") {
    const { project: projName, kind, priority, ticket, branch: existingBranch, start_at, continues } = body;
    let { title, brief } = body;
    if (!cfg.projects[projName]) return bad(`unknown project '${projName}'. Known: ${Object.keys(cfg.projects).join(", ") || "(none; add one to config.toml)"}`);
    const proj = cfg.projects[projName];
    if (continues) {
      const old = store.getTask(String(continues));
      if (!old) return bad(`no such task '${continues}'`);
      const refusal = cannotSupersede(old);
      if (refusal) return bad(refusal);
    }
    // A ticket can stand in for the title and brief.
    if (ticket && (!title || !brief)) {
      try {
        const t = await fetchTicket(proj, ticket);
        if (!t) return bad(`project '${projName}' has no ticket provider; give --title and --brief`);
        title ||= t.title; brief ||= `${t.description || t.title}\n\n(From ticket ${t.ref}: ${t.url})`;
      } catch (e: any) { return bad(`could not read ticket ${ticket}: ${e.message}`); }
    }
    if (!title || !brief) return bad("title and brief are required");
    let pipeline; try { pipeline = pipelineFor(kind, proj.speckit, { merge: proj.merge, merge_gate: proj.merge_gate, tickets: Boolean(proj.tickets) }); } catch (e: any) { return bad(e.message); }
    // --start-at skips earlier steps (for example a feature already specified and planned by hand).
    if (start_at && !pipeline.steps.some(s => s.name === start_at)) return bad(`no step '${start_at}' in the ${pipeline.kind} pipeline (${pipeline.steps.map(s => s.name).join(", ")})`);
    if (existingBranch && !pipeline.needs_worktree) return bad(`--branch only applies to pipelines that use a worktree`);
    const id = store.nextTaskId();
    let wt: git.WorktreeInfo | null = null;
    if (pipeline.needs_worktree) {
      try {
        const featureNumber = proj.speckit && !existingBranch ? store.nextFeatureNumber(projName, await git.highestFeatureNumber(proj.path)) : null;
        wt = await git.setupWorktree(cfg, proj, id, title, featureNumber, existingBranch ?? null);
        git.linkClaudeMemory(proj.path, wt.worktree);
      } catch (e: any) { return bad(`could not prepare worktree: ${e.message}`); }
    }
    let continued: TaskRow | null = null;
    let task: TaskRow;
    try { task = tx(() => {
      const t = store.insertTask({ id, project: projName, kind: pipeline.kind, title, brief, status: "queued", pipeline: JSON.stringify(pipeline.steps), current_step: start_at ?? null, priority: Number(priority ?? 5), branch: wt?.branch ?? null, worktree: wt?.worktree ?? null, feature_dir: wt?.feature_dir ?? null, ticket: ticket ?? null, pr_url: null, qa_cycles: 0, result: null });
      store.event("task.created", { kind: pipeline.kind, title, branch: wt?.branch ?? null, worktree: wt?.worktree ?? null, start_at: start_at ?? null, existing_branch: Boolean(existingBranch), continues: continues ?? null }, t.id);
      if (continues) {
        // setupWorktree awaited since the first check, so the task may have moved on.
        continued = store.getTask(String(continues))!;
        const refusal = cannotSupersede(continued);
        if (refusal) throw new Error(refusal);
        markSuperseded(continued, t.id);
      }
      return t;
    }); } catch (e: any) {
      if (!continues) throw e;
      return bad(`${e.message}${wt ? `; left the worktree at ${wt.worktree}` : ""}`);
    }
    log(`created ${task.id} [${kind}] ${title}`);
    setTimeout(tick, 50);
    void ticketHook(task, "start", `Foreman picked this up as ${task.id} (${pipeline.kind}): ${title}`);
    if (continued) await noteContinued(continued, task);
    return json(task, 201);
  }
  // Ticket routes: the project (or a task id, for workers) selects the provider.
  if ((mm = m(/^\/tickets(?:\/([^/]+))?(?:\/(comment|transition))?$/))) {
    const ref = mm[1] ? decodeURIComponent(mm[1]) : null;
    const taskId = (req.method === "GET" ? url.searchParams.get("task") : body.task) || null;
    const task = taskId ? store.getTask(taskId) : null;
    const projName = task?.project ?? (req.method === "GET" ? url.searchParams.get("project") : body.project);
    const proj = projName ? cfg.projects[projName] : undefined;
    if (!proj) return bad("project (or task) required");
    let provider; try { provider = providerFor(cfg, proj); } catch (e: any) { return bad(e.message); }
    if (!provider) return bad(`project '${proj.name}' has no ticket provider configured`);
    try {
      if (req.method === "GET" && ref) return json(await provider.get(ref));
      if (req.method === "GET") return json(await provider.list({ team: proj.ticket_team, states: url.searchParams.get("states")?.split(",").map(s => s.trim()).filter(Boolean) }));
      if (req.method === "POST" && !ref) {
        if (!body.title) return bad("title required");
        const t = await provider.create({ title: String(body.title), description: body.description ? String(body.description) : undefined, parent: body.parent ? String(body.parent) : undefined, team: proj.ticket_team });
        if (task) store.event("ticket.created", { ref: t.ref, url: t.url, title: t.title, parent: body.parent ?? null }, task.id, body.step_id ?? null);
        return json(t, 201);
      }
      if (req.method === "POST" && ref && mm[2] === "comment") {
        if (!body.body) return bad("body required");
        await provider.comment(ref, String(body.body));
        if (task) store.event("ticket.comment", { ref, body: body.body }, task.id, body.step_id ?? null);
        ticketCache.delete(`${proj.name}:${ref}`);
        return json({ ok: true });
      }
      if (req.method === "POST" && ref && mm[2] === "transition") {
        if (!body.state) return bad("state required");
        const state = await provider.transition(ref, String(body.state));
        if (task) store.event("ticket.transition", { ref, state }, task.id, body.step_id ?? null);
        ticketCache.delete(`${proj.name}:${ref}`);
        return json({ ok: true, state });
      }
    } catch (e: any) { return bad(e.message, 502); }
    return bad("not found", 404);
  }
  if ((mm = m(/^\/tasks\/([^/]+)$/)) && req.method === "GET") {
    const task = store.getTask(mm[1]); if (!task) return bad("no such task", 404);
    return json({ task: { ...task, gate_label: task.status === "gate" ? gateLabel(task) : null }, steps: store.stepsForTask(task.id), blocks: store.openBlocks(task.id), artifacts: store.artifactsForTask(task.id), leases: store.leasesForTask(task.id).map(r => leaseView(store, r)), events: store.eventsForTask(task.id, 50).reverse() });
  }
  if ((mm = m(/^\/tasks\/([^/]+)\/(cancel|close|approve|reject|retry|note|artifacts|blocks)$/)) && req.method === "POST") {
    const task = store.getTask(mm[1]); if (!task) return bad("no such task", 404);
    const action = mm[2];
    if (action === "cancel") {
      if (task.status === "superseded") return bad(`${task.id} is superseded by ${task.superseded_by}`);
      tx(() => {
        stopTask(task, "cancelled");
        store.updateTask(task.id, { status: "cancelled" }); store.event("task.cancelled", {}, task.id);
      });
      return json({ ok: true });
    }
    if (action === "close") {
      if (!body.superseded_by) return bad("superseded_by required");
      const refusal = cannotSupersede(task);
      if (refusal) return bad(refusal);
      const other = store.getTask(String(body.superseded_by));
      if (!other) return bad(`no such task '${body.superseded_by}'`);
      if (other.id === task.id) return bad(`${task.id} cannot be superseded by itself`);
      const seen = new Set<string>();
      for (let t: TaskRow | null = other; t && !seen.has(t.id); t = t.superseded_by ? store.getTask(t.superseded_by) : null) {
        if (t.id === task.id) return bad(`${other.id} is already superseded by ${task.id}; closing would make a cycle`);
        seen.add(t.id);
      }
      tx(() => markSuperseded(task, other.id));
      await noteContinued(task, other);
      return json({ ok: true, superseded_by: other.id });
    }
    if (action === "approve") {
      if (task.status !== "gate") return bad(`task is ${task.status}, not waiting at a gate`);
      const gate = store.stepsForTask(task.id).find(s => s.status === "gate"); if (!gate) return bad("no open gate step");
      tx(() => {
        store.updateStep(gate.id, { status: "done", finished_at: now() }); store.event("task.approved", { gate: gate.name }, task.id, gate.id);
        store.updateTask(task.id, { status: "running" });
      });
      setTimeout(tick, 50);
      return json({ ok: true, gate: gate.name });
    }
    if (action === "reject") {
      // Send the work before the gate back with the user's feedback (QA_FEEDBACK), then re-run everything up to the gate.
      if (task.status !== "gate") return bad(`task is ${task.status}, not waiting at a gate`);
      const gate = store.stepsForTask(task.id).find(s => s.status === "gate"); if (!gate) return bad("no open gate step");
      const feedback = String(body.feedback ?? "").trim();
      if (!feedback) return bad("feedback required");
      const steps = pipelineSteps(task);
      const gateIdx = steps.findIndex(s => s.name === gate.name);
      const found = gateIdx >= 0 ? rejectTarget(steps, gateIdx) : null;
      if (!found) return bad(`nothing before gate '${gate.name}' to send back`);
      const targetIdx = steps.findIndex(s => s.name === found.target);
      const target = steps[targetIdx];
      if (!target || target.type !== "agent") return bad(`reject target '${found.target}' is not an agent step`);
      tx(() => {
        store.event("note", { text: `Rejected at ${gate.name}: ${feedback}` }, task.id, gate.id);
        store.event("task.rejected", { gate: gate.name, target: target.name, feedback }, task.id, gate.id);
        store.updateStep(gate.id, { status: "skipped", finished_at: now() });
        const skip = (name: string) => { const s = store.latestStep(task.id, name); if (s && s.status !== "skipped") store.updateStep(s.id, { status: "skipped" }); };
        for (const s of steps.slice(targetIdx + 1, gateIdx)) {
          if (s.type === "parallel") s.children.forEach(c => skip(c.name));
          else if (s.type !== "gate") skip(s.name);
        }
        const prev = store.latestStep(task.id, target.name);
        store.insertStep({ task_id: task.id, name: target.name, role: target.role, status: "queued", attempt: (prev?.attempt ?? 0) + 1 });
        store.updateTask(task.id, {
          current_step: target.name, status: "queued",
          rejection: JSON.stringify({ gate: gate.name, target: target.name, feedback, at: now() }),
          ...(found.via.type === "parallel" ? { qa_cycles: 0 } : { plan_cycles: 0 }),
        });
      });
      setTimeout(tick, 50);
      return json({ ok: true, gate: gate.name, step: target.name });
    }
    if (action === "retry") {
      if (task.status !== "failed") return bad(`task is ${task.status}, not failed`);
      const steps = pipelineSteps(task);
      const cur = task.current_step ?? steps[0]?.name ?? null;
      // A failed system step (open_pr, merge) is simply re-run by the scheduler once the task is active again.
      if (steps.some(s => s.type === "system" && s.name === cur)) {
        tx(() => { store.updateTask(task.id, { status: "running", result: null }); store.event("task.retried", { steps: [cur], system: true }, task.id); });
        setTimeout(tick, 50);
        return json({ ok: true, step: cur });
      }
      const group = steps.find(s => s.type === "parallel" && s.name === task.current_step) as any;
      // R9: retrying at a parallel group re-queues the children whose latest row failed.
      const targets = group ? group.children.filter((c: any) => store.latestStep(task.id, c.name)?.status === "failed") : agentDefs(steps).filter(d => d.name === cur);
      if (!targets.length) return bad(`cannot retry at step '${task.current_step}'`);
      const failedTabs = store.stepsForTask(task.id).filter(s => s.tab_id && s.status === "failed");
      tx(() => {
        for (const def of targets) {
          const prev = store.latestStep(task.id, def.name);
          // Attempt numbers keep climbing so run directories never collide; the
          // "[user-retry]" marker resets the failure count for max_attempts.
          const resume = body.fresh || !prev?.session_id ? "[user-retry]" : "[user-retry] The user asked to retry this step. Continue from where you left off.";
          store.insertStep({ task_id: task.id, name: def.name, role: def.role, status: "queued", attempt: (prev?.attempt ?? 0) + 1, session_id: body.fresh ? null : prev?.session_id ?? null, resume_prompt: resume });
        }
        for (const s of failedTabs) store.updateStep(s.id, { tab_id: null });
        store.updateTask(task.id, { status: "queued", result: null }); store.event("task.retried", { steps: targets.map((t: any) => t.name), fresh: Boolean(body.fresh) }, task.id);
      });
      for (const s of failedTabs) await herdr.closeTab(s.tab_id!, s.machine);
      setTimeout(tick, 50);
      return json({ ok: true, step: targets.map((t: any) => t.name).join(", ") });
    }
    if (action === "note") { store.event("note", { text: String(body.text ?? "") }, task.id, body.step_id ?? null); return json({ ok: true }); }
    if (action === "artifacts") { return json(store.insertArtifact(task.id, body.step_id ?? null, String(body.path), String(body.kind ?? "file"), body.note ?? null), 201); }
    if (action === "blocks") {
      if (!body.question) return bad("question required");
      const b = store.insertBlock(task.id, Number(body.step_id), String(body.question));
      store.event("task.blocked", { question: body.question }, task.id, b.step_id);
      if (CLOSED_STATUSES.includes(task.status)) store.answerBlock(b.id, `(task ${task.status})`);
      return json(b, 201);
    }
  }
  if (p === "/blocks" && req.method === "GET") {
    const project = url.searchParams.get("project");
    const blocks = store.openBlocks().map(b => ({ ...b, task: store.getTask(b.task_id) }));
    return json(project ? blocks.filter(b => b.task?.project === project) : blocks);
  }
  if ((mm = m(/^\/blocks\/(\d+)\/answer$/)) && req.method === "POST") {
    const b = store.getBlock(Number(mm[1])); if (!b) return bad("no such block", 404);
    if (b.answer) return bad("already answered");
    if (!body.answer) return bad("answer required");
    tx(() => {
      store.answerBlock(b.id, String(body.answer));
      store.event("task.answered", { block: b.id, answer: body.answer }, b.task_id, b.step_id);
    });
    const remaining = store.openBlocks(b.task_id).filter(x => x.step_id === b.step_id).length;
    const step = store.getStep(b.step_id)!;
    setTimeout(tick, 50); // the scheduler creates the resume attempt once the step is blocked with no open questions
    return json({ ok: true, remaining, resumed: remaining === 0 && step.status === "blocked", note: step.status === "running" ? "worker still running; it will be resumed with this answer after it reports blocked" : undefined });
  }
  if ((mm = m(/^\/steps\/(\d+)\/context$/)) && req.method === "GET") {
    const step = store.getStep(Number(mm[1])); if (!step) return bad("no such step", 404);
    const s = { ...step, resume_prompt: step.resume_prompt?.replace(/^\[user-retry\]\s*/, "") || null };
    return json(await stepContext(s));
  }
  if ((mm = m(/^\/steps\/(\d+)\/heartbeat$/)) && req.method === "POST") {
    const step = store.getStep(Number(mm[1])); if (!step) return bad("no such step", 404);
    // R2: anything that is not the current running attempt of an active task must stop.
    const stale = !isLive(step);
    if (!stale) store.updateStep(step.id, { lease_until: addSeconds(cfg.defaults.lease_sec) });
    return json({ ok: true, cancel: stale || cancelRequested.has(step.id) });
  }
  if ((mm = m(/^\/steps\/(\d+)\/lease$/)) && req.method === "POST") {
    const step = store.getStep(Number(mm[1])); if (!step) return bad("no such step", 404);
    const resource = typeof body.resource === "string" ? body.resource.trim() : "";
    if (!resource) return bad("resource required");
    if (!isLive(step)) return json({ error: "step is not running" }, 409);
    const task = store.getTask(step.task_id)!;
    const proj = cfg.projects[task.project];
    const declared = proj?.resources.length ? deviceResources(proj) : [];
    const state = requestLease(store, task, step, resource, body.reason ? String(body.reason) : null, declared);
    if (state.warning) log(`${task.id}/${step.name}#${step.attempt}: ${state.warning}`);
    return json(state);
  }
  if ((mm = m(/^\/steps\/(\d+)\/release$/)) && req.method === "POST") {
    const step = store.getStep(Number(mm[1])); if (!step) return bad("no such step", 404);
    const resource = typeof body.resource === "string" ? body.resource.trim() : "";
    if (!resource) return bad("resource required");
    return json({ ok: true, ...releaseLease(store, step, resource) });
  }
  if (p === "/leases" && req.method === "GET") {
    const taskId = url.searchParams.get("task");
    const projName = url.searchParams.get("project") ?? (taskId ? store.getTask(taskId)?.project : undefined) ?? undefined;
    return json(store.listLeases({ project: projName }).map(r => leaseView(store, r)));
  }
  if ((mm = m(/^\/steps\/(\d+)\/result$/)) && req.method === "POST") {
    const step = store.getStep(Number(mm[1])); if (!step) return bad("no such step", 404);
    // R1: fence late results from attempts that have already been superseded.
    const current = store.latestStep(step.task_id, step.name);
    if (step.status !== "running" || current?.id !== step.id) {
      store.event("step.late_result", { step: step.name, attempt: step.attempt, status: step.status, session_id: body.session_id ?? null }, step.task_id, step.id);
      log(`late result ignored for ${step.task_id}/${step.name}#${step.attempt} (status ${step.status})`);
      return json({ error: "stale attempt; result recorded as late and ignored", step_status: step.status, task_status: store.getTask(step.task_id)!.status }, 409);
    }
    return json(await handleResult(step, body));
  }
  return bad("not found", 404);
}

// ---------------------------------------------------------------- main

// step_timeouts keys that name no agent step in any pipeline (likely typos).
export function unknownTimeoutKeys(c: ForemanConfig): { key: string; where: string }[] {
  const names = new Set<string>();
  for (const p of Object.values(PIPELINES)) for (const s of p.steps) {
    if (s.type === "agent") names.add(s.name);
    if (s.type === "parallel") for (const ch of s.children) names.add(ch.name);
  }
  const maps: [string, Record<string, number>][] = [["defaults", c.defaults.step_timeouts ?? {}],
    ...Object.values(c.projects).map(p => [`projects.${p.name}`, p.step_timeouts ?? {}] as [string, Record<string, number>])];
  return maps.flatMap(([where, m]) => Object.keys(m).filter(k => !names.has(k)).map(key => ({ key, where })));
}

export async function main(): Promise<void> {
  herdrOk = await herdr.herdrAvailable();
  // R3: a long outage must not expire every live lease on the first tick.
  const live = store.runningSteps();
  if (live.length) {
    for (const s of live) store.updateStep(s.id, { lease_until: addSeconds(cfg.defaults.lease_sec) });
    log(`startup: extended ${live.length} running lease(s) by ${cfg.defaults.lease_sec}s`);
  }
  for (const { key, where } of unknownTimeoutKeys(cfg)) log(`config: step_timeouts key '${key}' (${where}) matches no pipeline step`);
  const server = Bun.serve({
    hostname: cfg.server.bind, port: cfg.server.port,
    fetch: (req) => route(req).catch((e: any) => { log("request error:", e.message); return bad(e.message, 500); }),
  });
  log(`taskd listening on http://${cfg.server.bind}:${cfg.server.port} (herdr: ${herdrOk ? "yes" : "no, workers run as background processes"})`);
  log(`projects: ${Object.keys(cfg.projects).join(", ") || "(none configured)"}`);
  setInterval(tick, 2000);
  await tick();
  await new Promise(() => { void server; });
}
