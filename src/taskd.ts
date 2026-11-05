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
// - The heartbeat lease is armed when the launch returns or the runner checks in, not before;
//   until then the step has launch_grace_sec. Attempts whose runner never started are not
//   counted against max_attempts (launch_attempts_max bounds them instead).
// - A tick gap longer than 2 x heartbeat_sec (host sleep, stall) extends every running lease.
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Store, CLOSED_STATUSES, type TaskRow, type StepRow, now } from "./db";
import { loadConfig, denyListFor, stepTimeoutMin, deviceResources, REPO_ROOT, RUNS_DIR, type ForemanConfig, type ProjectConfig } from "./config";
import { requestLease, releaseLease, releaseStepLeases, reconcileLeases, leaseView, devicePrompt, dispatchView, laneViews, laneStatusForTask, type GroupsOf } from "./leases";
import { dispatchVerdict } from "./lane";
import { pipelineFor, PIPELINES, type PipelineStep } from "./pipelines";
import { buildDecision, failingReview } from "./decision";
import * as herdr from "./herdr";
import * as git from "./git";
import { providerFor, ticketContext, type Ticket } from "./tickets";
import { deltaCost, priceUsage, sessionLogPath, sessionUsage, type Usage } from "./costs";

export const cfg: ForemanConfig = loadConfig();
const store = new Store();
let herdrOk = false;
const cancelRequested = new Set<number>(); // step ids whose runner should stop
let ticking = false;
let lastTickStart: number | null = null; // wall time the previous tick started (stall detection)
// Launches in flight (herdr calls), outside the tick. The step is already 'running', so concurrency counts it.
const launching = new Map<number, Promise<void>>();
herdr.setTimeoutSec(cfg.defaults.herdr_timeout_sec);

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "task";
const addSeconds = (sec: number) => new Date(Date.now() + sec * 1000).toISOString();
const tx = <T>(fn: () => T): T => store.db.transaction(fn)();
// Device lane (T0048): each project's resource groups, and the fallback hold for ETAs and overdue.
const groupsOf: GroupsOf = p => cfg.projects[p]?.resource_groups ?? [];
const leaseMaxMin = (p: string) => cfg.projects[p]?.lease_max_minutes ?? cfg.defaults.lease_max_minutes;
// Queued step id -> why dispatch is holding it back; step.deferred is emitted once per step and reason.
const deferred = new Map<number, string>();

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
// A failed attempt whose runner never checked in: not counted against max_attempts.
const NEVER_STARTED = "runner never started";
const isNeverStarted = (s: StepRow) => s.status === "failed" && !s.runner_seen_at && Boolean(s.error?.startsWith(NEVER_STARTED));
const secsSince = (iso: string, to = Date.now()) => Math.round((to - Date.parse(iso)) / 1000);

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
    if (s.status === "failed" && !isNeverStarted(s)) count++;
    if (s.resume_prompt?.startsWith("[user-retry]")) count = 0;
  }
  return count;
}

// Trailing run of never-started attempts of a step, back to (and including) the last user retry.
function neverStartedStreak(task_id: string, name: string): number {
  const rows = store.stepsForTask(task_id).filter(s => s.name === name);
  let n = 0;
  for (let i = rows.length - 1; i >= 0 && isNeverStarted(rows[i]); i--) {
    n++;
    if (rows[i].resume_prompt?.startsWith("[user-retry]")) break;
  }
  return n;
}

// ---------------------------------------------------------------- scheduler

// The runner's final result event, if the last parseable line of transcript.jsonl is one.
// The run dir is per attempt, so this can only be this attempt's result.
function resultFromTranscript(runDir: string): any | null {
  const path = join(runDir, "transcript.jsonl");
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let ev: any;
    try { ev = JSON.parse(lines[i]); } catch { continue; } // truncated line
    return ev?.type === "result" ? ev : null;
  }
  return null;
}

async function expireLeases(): Promise<void> {
  for (const s of store.runningSteps()) {
    if (!s.lease_until || s.lease_until >= now()) continue;
    const task = store.getTask(s.task_id)!;
    const runDir = runDirFor(task, s);
    // R4 fallback: the runner may have finished but failed to deliver its result.
    const reportPath = join(runDir, "report.json");
    if (existsSync(reportPath)) {
      try {
        const body = JSON.parse(readFileSync(reportPath, "utf8"));
        log(`lease expired for ${s.task_id}/${s.name}#${s.attempt}; applying report.json left by the runner`);
        store.event("step.result_recovered", { step: s.name, attempt: s.attempt, source: "report" }, s.task_id, s.id);
        await handleResult(s, body);
        continue;
      } catch (e: any) { log(`report.json unreadable for ${s.task_id}/${s.name}#${s.attempt}: ${e.message}`); }
    }
    // The run finished but its tab died (or the host slept) before report.json was written.
    const ev = resultFromTranscript(runDir);
    if (ev) {
      const body = { exit_code: 0, killed: null, session_id: ev.session_id ?? s.session_id, result: ev, stderr_tail: "", run_dir: runDir, recovered_from: "transcript" };
      try { writeFileSync(reportPath, JSON.stringify(body, null, 2)); } catch (e: any) { log(`could not write ${reportPath}: ${e.message}`); }
      log(`lease expired for ${s.task_id}/${s.name}#${s.attempt}; applying the result event from transcript.jsonl`);
      store.event("step.result_recovered", { step: s.name, attempt: s.attempt, source: "transcript" }, s.task_id, s.id);
      await handleResult(s, body);
      continue;
    }
    // Rows launched before T0054 have no launch_started_at and keep the old classification.
    let error = "lease expired: runner stopped heartbeating";
    if (!s.runner_seen_at && s.launch_started_at) {
      error = s.launched_at
        ? `${NEVER_STARTED}: no check-in within ${cfg.defaults.lease_sec}s of launch (launch took ${secsSince(s.launch_started_at, Date.parse(s.launched_at))}s)`
        : `${NEVER_STARTED}: launch timed out after ${secsSince(s.launch_started_at)}s`;
    }
    const never = error.startsWith(NEVER_STARTED);
    // A never-started attempt ran nothing, so its cost is a known zero (no estimate, no session total).
    const cost: StepCost = never ? { cost_usd: 0, turns: 0, session_cost_usd: null, cost_estimated: 0, cost_unknown: 0 } : stepCost(s, {});
    log(`lease expired for ${s.task_id}/${s.name}#${s.attempt}: ${error}`);
    tx(() => {
      store.updateStep(s.id, { status: "failed", finished_at: now(), error, ...cost });
      store.event(never ? "step.never_started" : "step.lease_expired", { step: s.name, attempt: s.attempt, ...(never ? { error } : {}) }, s.task_id, s.id);
      releaseStepLeases(store, s.id, "heartbeat lease expired", groupsOf);
    });
    cancelRequested.add(s.id);
    // Bounded by the herdr timeout; not awaited so one dead tab cannot hold the tick.
    if (s.tab_id) void herdr.closeTab(s.tab_id, s.machine);
  }
}

// Shared by startup (R3) and tick-gap recovery. Returns how many leases moved.
function extendRunningLeases(newUntil: (s: StepRow) => string): number {
  const live = store.runningSteps();
  tx(() => { for (const s of live) store.updateStep(s.id, { lease_until: newUntil(s) }); });
  return live.length;
}

export async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    // S5: a long gap since the last tick (host sleep, or a stalled tick) is not the runners' fault.
    const start = Date.now();
    const gap = lastTickStart === null ? 0 : start - lastTickStart;
    lastTickStart = start;
    if (gap > 2 * cfg.defaults.heartbeat_sec * 1000) {
      const extended = extendRunningLeases(s => new Date((s.lease_until ? Date.parse(s.lease_until) : start) + gap).toISOString());
      const gap_sec = Math.round(gap / 1000);
      log(`tick gap ${gap_sec}s (host sleep or stall): extended ${extended} lease(s)`);
      store.event("taskd.stall", { gap_sec, extended });
    }
    await expireLeases();
    for (const id of deferred.keys()) if (store.getStep(id)?.status !== "queued") deferred.delete(id);
    try { reconcileLeases(store, leaseMaxMin, groupsOf); }
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
  const fr = failingReview(steps, ps.name, store.stepsForTask(task.id));
  return fr ? `${ps.label} — plan QA still fails after ${fr.reviews} review(s); see ${task.feature_dir ?? "specs/<feature>"}/qa/plan-review.md` : ps.label;
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
      if (isNeverStarted(latest)) {
        // Nothing ran, so relaunch the same attempt content: same session and resume prompt.
        const streak = neverStartedStreak(task.id, latest.name);
        if (streak >= cfg.defaults.launch_attempts_max) return failTask(task, `step '${latest.name}' could not start a runner ${streak} times: ${latest.error}`);
        return createStep(task, latest.name, role, latest.attempt + 1, latest.session_id, latest.resume_prompt?.replace(/^\[user-retry\]\s*/, "") || null);
      }
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
  // Concurrency is the blocker now, not the device lane: drop any held-back reason so task ls does not name the lane.
  if (store.runningCount() >= cfg.defaults.concurrency || store.runningCount(task.project) >= proj.concurrency) { deferred.delete(step.id); return; }
  // Device lane: hold device steps back so device-free work and better-ranked device steps go first.
  const free = Math.min(cfg.defaults.concurrency - store.runningCount(), proj.concurrency - store.runningCount(task.project));
  const verdict = dispatchVerdict(
    { step_id: step.id, task_id: task.id, name: step.name, priority: task.priority, qa_cycles: task.qa_cycles, created_at: step.created_at },
    dispatchView(store, task.project, proj, free));
  if (!verdict.launch) {
    if (deferred.get(step.id) !== verdict.reason) {
      deferred.set(step.id, verdict.reason);
      store.event("step.deferred", { step: step.name, reason: verdict.reason }, task.id, step.id);
    }
    return;
  }
  deferred.delete(step.id);
  const cwd = task.worktree ?? proj.path;
  if (!existsSync(cwd)) { store.updateStep(step.id, { status: "failed", finished_at: now(), error: `cwd missing: ${cwd}` }); return; }

  // S1: the heartbeat lease is not armed yet; the launch has launch_grace_sec to return.
  const startedAt = now();
  tx(() => {
    store.updateStep(step.id, { status: "running", started_at: startedAt, launch_started_at: startedAt, lease_until: addSeconds(cfg.defaults.launch_grace_sec), timeout_min: stepTimeoutMin(cfg.defaults, proj, step.name) });
    store.updateTask(task.id, { status: "running" });
  });
  // S4: herdr can take minutes under load; the tick must not wait for it.
  launching.set(step.id, launch(task, step, proj, cwd).finally(() => launching.delete(step.id)));
}

async function launch(task: TaskRow, step: StepRow, proj: ProjectConfig, cwd: string): Promise<void> {
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
  const viaHerdr = herdrOk;
  try {
    let pane: herdr.HerdrPane | null = null;
    if (viaHerdr) {
      const ws = await herdr.ensureWorkspace(`fm:${task.project}`, proj.path, proj.machine);
      pane = await herdr.launchInTab({ workspace_id: ws, label: `${task.id} ${step.name}`, cwd, env, command, machine: proj.machine });
    } else {
      // Fallback without herdr. Known limitation: the child shares taskd's process
      // group, so a Ctrl-C on taskd also interrupts it (macOS has no setsid).
      const runDir = join(RUNS_DIR, task.id, `${step.name}-${step.attempt}`);
      mkdirSync(runDir, { recursive: true });
      const out = Bun.file(join(runDir, "console.log"));
      Bun.spawn(command, { cwd, env: { ...process.env, ...env }, stdout: out, stderr: out, stdin: "ignore" }).unref();
    }
    const fresh = store.getStep(step.id);
    if (!fresh || !isLive(fresh)) {
      // Expired, cancelled or failed while the launch was in flight; its runner would only be told to stop.
      if (pane) void herdr.closeTab(pane.tab_id, proj.machine);
      log(`launch of ${task.id}/${step.name}#${step.attempt} returned after the step stopped being live; closed the new tab`);
      return;
    }
    store.updateStep(step.id, {
      launched_at: now(), lease_until: addSeconds(cfg.defaults.lease_sec),
      ...(pane ? { workspace_id: pane.workspace_id, tab_id: pane.tab_id, pane_id: pane.pane_id } : {}),
    });
    store.event("step.started", { step: step.name, attempt: step.attempt, herdr: viaHerdr }, task.id, step.id);
    log(`started ${task.id}/${step.name}#${step.attempt} (${viaHerdr ? "herdr tab" : "background process"}, launch took ${secsSince(fresh.launch_started_at ?? fresh.started_at ?? now())}s)`);
  } catch (e: any) {
    const fresh = store.getStep(step.id);
    if (!fresh || !isLive(fresh)) return;
    const error = `${NEVER_STARTED}: ${e.message}`;
    tx(() => {
      store.updateStep(step.id, { status: "failed", finished_at: now(), error });
      store.event("step.never_started", { step: step.name, attempt: step.attempt, error }, task.id, step.id);
      store.event("step.launch_failed", { error: e.message }, task.id, step.id);
      releaseStepLeases(store, step.id, "launch failed", groupsOf);
    });
    log(`launch failed for ${task.id}/${step.name}#${step.attempt}: ${e.message}`);
  }
  setTimeout(tick, 50);
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
    for (const s of running) releaseStepLeases(store, s.id, "task failed", groupsOf);
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
    releaseStepLeases(store, s.id, `task ${why}`, groupsOf);
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

// Heuristic only (T0047): a forced "failed" result whose summary says work was
// still going usually means the worker ended its turn while waiting.
const EARLY_END = /still running|waiting for|incomplete|not finished/i;
export const EARLY_END_NOTE = "step ended early (work still running?)";
export function endedEarly(summary: unknown): boolean {
  return typeof summary === "string" && EARLY_END.test(summary);
}

type StepCost = Pick<StepRow, "cost_usd" | "turns" | "session_cost_usd" | "cost_estimated" | "cost_unknown">;

// The session id an attempt ran under: reported, recorded at launch, or the
// init event of its stream transcript.
function attemptSessionId(task: TaskRow, step: StepRow, body: any): string | null {
  if (body.session_id) return String(body.session_id);
  if (step.session_id) return step.session_id;
  try {
    for (const line of readFileSync(join(runDirFor(task, step), "transcript.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const ev = JSON.parse(line);
      if (ev.type === "system" && ev.subtype === "init" && ev.session_id) return String(ev.session_id);
    }
  } catch {}
  return null;
}

// What an attempt cost (T0055). Claude's total_cost_usd is cumulative over a
// session, so a result records the delta over earlier attempts of the session.
// Without a result the cost is estimated from the session log (the runner's
// usage, or taskd reads the log itself for a local step), else marked unknown.
function stepCost(step: StepRow, body: any): StepCost {
  const task = store.getTask(step.task_id)!;
  const r = body.result ?? {};
  const sid = attemptSessionId(task, step, body);
  const prev = sid ? store.prevSessionCost(sid, step.id) : 0;
  if (typeof r.total_cost_usd === "number") {
    const raw = r.total_cost_usd;
    return { cost_usd: deltaCost(raw, prev), session_cost_usd: raw, turns: Number(r.num_turns ?? 0), cost_estimated: 0, cost_unknown: 0 };
  }
  const unknown: StepCost = { cost_usd: 0, turns: 0, session_cost_usd: sid ? prev : null, cost_estimated: 0, cost_unknown: 1 };
  let usage: Usage | null = body.usage?.models ? body.usage : null;
  if (!usage && !step.machine && sid) {
    try {
      const proj = cfg.projects[task.project];
      const path = sessionLogPath(task.worktree ?? proj?.path ?? "", sid);
      if (path) usage = sessionUsage(path, { from: step.started_at ?? step.created_at, to: now() });
    } catch (e: any) { log(`cost estimate failed for ${task.id}/${step.name}#${step.attempt}: ${e.message}`); }
  }
  if (!usage) return unknown;
  const priced = priceUsage(usage, cfg.pricing);
  if (!("usd" in priced)) { log(`cost unknown for ${task.id}/${step.name}#${step.attempt}: no price for ${priced.unpriced.join(", ")}`); return unknown; }
  return { cost_usd: priced.usd, turns: usage.api_calls, session_cost_usd: sid ? prev + priced.usd : null, cost_estimated: 1, cost_unknown: 0 };
}

async function handleResult(step: StepRow, body: any): Promise<{ step_status: string; task_status: string }> {
  const task = store.getTask(step.task_id)!;
  const r = body.result ?? {};
  const so = r.structured_output ?? null;
  let status: "done" | "blocked" | "failed";
  let error: string | null = null;
  if (body.killed) { status = "failed"; error = String(body.killed); }
  else if (so?.status === "done" || so?.status === "blocked" || so?.status === "failed") {
    status = so.status;
    if (status === "failed") {
      error = so.summary;
      if (endedEarly(so.summary)) { error = `${EARLY_END_NOTE}: ${so.summary}`; log(`${task.id}/${step.name}#${step.attempt}: ${EARLY_END_NOTE}`); }
    }
  }
  else if (r.is_error || body.exit_code !== 0) { status = "failed"; error = r.subtype ?? r.result ?? body.stderr_tail?.trim().split("\n").pop() ?? `exit ${body.exit_code}`; }
  else if (r.subtype && r.subtype !== "success") { status = "failed"; error = r.subtype; }
  else { status = "failed"; error = "worker ended without structured output"; }
  if (isStopped(task)) { status = "failed"; error = error ?? task.status; }

  const cost = stepCost(step, body);
  tx(() => {
    store.updateStep(step.id, {
      status, finished_at: now(), error,
      session_id: body.session_id ?? step.session_id,
      result: so ? JSON.stringify(so) : null,
      ...cost,
      lease_until: null,
    });
    store.event(`step.${status}`, { step: step.name, attempt: step.attempt, cost_usd: cost.cost_usd, session_cost_usd: cost.session_cost_usd, estimated: Boolean(cost.cost_estimated), unknown: Boolean(cost.cost_unknown), turns: cost.turns, error, summary: so?.summary ?? null, verdict: so?.verdict ?? null }, task.id, step.id);
    const known = new Set(store.artifactsForTask(task.id).map(a => a.path));
    for (const a of so?.artifacts ?? []) if (a?.path && !known.has(a.path)) { store.insertArtifact(task.id, step.id, a.path, a.kind ?? "file", null); known.add(a.path); }
    if (status === "blocked") {
      // Only add a placeholder question when the worker never registered one (answered or open).
      if (!store.blocksForStep(step.id).length) store.insertBlock(task.id, step.id, so?.summary ?? "Worker reported blocked without a question.");
      if (!isStopped(task)) store.updateTask(task.id, { status: "blocked" });
    }
    releaseStepLeases(store, step.id, `step ${status}`, groupsOf);
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
    DEVICE_LEASES: devicePrompt(deviceResources(proj), step.role, proj.resource_groups),
    TICKET: ticket, TICKET_REF: task.ticket ?? "",
    TICKET_HANDOFF: task.ticket
      ? `\nThen post the Summary and To verify sections as a comment on ticket ${task.ticket} with \`task ticket comment "<text>"\` (one quoted argument, markdown allowed)${proj.ticket_states.review ? ` and move it with \`task ticket transition "${proj.ticket_states.review}"\`` : ""}. The ticket's readers are not developers; write for them.`
      : "",
  };
  return { step, task, project: proj, defaults: cfg.defaults, deny: denyListFor(cfg, proj), prompt_vars, step_prompt };
}

// ---------------------------------------------------------------- HTTP API

// Device lane state of a task for task ls: waiting in a lane, or held back at dispatch.
function laneOf(t: TaskRow): { state: "waiting"; position: number; of: number } | { state: "deferred"; reason: string } | null {
  // A stopped task can keep a queued step row and a stale held-back entry; its real status wins.
  if (!["queued", "running", "blocked"].includes(t.status)) return null;
  const w = laneStatusForTask(store, t.id, groupsOf);
  if (w) return { state: "waiting", ...w };
  const q = store.stepsForTask(t.id).find(s => s.status === "queued" && deferred.has(s.id));
  return q ? { state: "deferred", reason: deferred.get(q.id)! } : null;
}

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
    return json(tasks.map(t => {
      let cost_usd = 0, cost_estimated = 0, cost_unknown = 0;
      for (const s of store.stepsForTask(t.id)) { cost_usd += s.cost_usd; cost_estimated += s.cost_estimated; cost_unknown += s.cost_unknown; }
      return { ...t, gate_label: t.status === "gate" ? gateLabel(t) : null, open_blocks: store.openBlocks(t.id).length, cost_usd, cost_estimated, cost_unknown, lane: laneOf(t) };
    }));
  }
  // Step costs finished on taskd's local calendar day, overall and per project.
  if (p === "/costs/today" && req.method === "GET") {
    const d = new Date();
    const from = new Date(d.getFullYear(), d.getMonth(), d.getDate()), to = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
    const day = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}-${String(from.getDate()).padStart(2, "0")}`;
    const total = { usd: 0, estimated: 0, unknown: 0, steps: 0 };
    const projects: Record<string, typeof total> = {};
    for (const { project: name, ...c } of store.costsBetween(from.toISOString(), to.toISOString())) {
      projects[name] = c;
      total.usd += c.usd; total.estimated += c.estimated; total.unknown += c.unknown; total.steps += c.steps;
    }
    return json({ day, total, projects });
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
    const steps = store.stepsForTask(task.id), blocks = store.openBlocks(task.id), artifacts = store.artifactsForTask(task.id);
    const gate_label = task.status === "gate" ? gateLabel(task) : null;
    let decision = null;
    try { decision = buildDecision({ task, steps, blocks, artifacts, pipeline: pipelineSteps(task), gateLabel: gate_label ?? "", maxPlanCycles: cfg.defaults.max_plan_cycles }); }
    catch (e: any) { log(`decision ${task.id} failed:`, e.message); }
    return json({ task: { ...task, gate_label }, decision, steps, blocks, artifacts, leases: store.leasesForTask(task.id).map(r => leaseView(store, r, groupsOf, leaseMaxMin(r.project))), events: store.eventsForTask(task.id, 50).reverse() });
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
    if (!stale) store.updateStep(step.id, { lease_until: addSeconds(cfg.defaults.lease_sec), runner_seen_at: now() });
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
    let expect_min: number | null = null;
    if (body.expect_min !== undefined && body.expect_min !== null) {
      const e = Number(body.expect_min);
      if (typeof body.expect_min === "boolean" || !Number.isFinite(e) || e <= 0 || e > 1440) return bad("expect_min must be minutes > 0");
      expect_min = Math.ceil(e);
    }
    const state = requestLease(store, task, step, resource, body.reason ? String(body.reason) : null, declared, { expect_min, groupsOf, fallbackMin: leaseMaxMin(task.project) });
    if (state.warning) log(`${task.id}/${step.name}#${step.attempt}: ${state.warning}`);
    return json(state);
  }
  if ((mm = m(/^\/steps\/(\d+)\/release$/)) && req.method === "POST") {
    const step = store.getStep(Number(mm[1])); if (!step) return bad("no such step", 404);
    const resource = typeof body.resource === "string" ? body.resource.trim() : "";
    if (!resource) return bad("resource required");
    return json({ ok: true, ...releaseLease(store, step, resource, "released", groupsOf) });
  }
  if (p === "/leases" && req.method === "GET") {
    const taskId = url.searchParams.get("task");
    const projName = url.searchParams.get("project") ?? (taskId ? store.getTask(taskId)?.project : undefined) ?? undefined;
    return json(store.listLeases({ project: projName }).map(r => leaseView(store, r, groupsOf, leaseMaxMin(r.project))));
  }
  if (p === "/lanes" && req.method === "GET") {
    const taskId = url.searchParams.get("task");
    const projName = url.searchParams.get("project") ?? (taskId ? store.getTask(taskId)?.project : undefined) ?? null;
    const names = projName ? [projName] : Object.keys(cfg.projects);
    const projects = Object.fromEntries(names.filter(n => cfg.projects[n]?.resource_groups.length).map(n => {
      const pc = cfg.projects[n]!;
      return [n, { device_steps: pc.device_steps, device_steps_running: pc.device_steps_running, device_running: store.runningStepsOf(n).filter(s => pc.device_steps.includes(s.name)).length }];
    }));
    return json({ lanes: laneViews(store, groupsOf, names, leaseMaxMin), projects });
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
function agentStepNames(): Set<string> {
  const names = new Set<string>();
  for (const p of Object.values(PIPELINES)) for (const s of p.steps) {
    if (s.type === "agent") names.add(s.name);
    if (s.type === "parallel") for (const ch of s.children) names.add(ch.name);
  }
  return names;
}
export function unknownTimeoutKeys(c: ForemanConfig): { key: string; where: string }[] {
  const names = agentStepNames();
  const maps: [string, Record<string, number>][] = [["defaults", c.defaults.step_timeouts ?? {}],
    ...Object.values(c.projects).map(p => [`projects.${p.name}`, p.step_timeouts ?? {}] as [string, Record<string, number>])];
  return maps.flatMap(([where, m]) => Object.keys(m).filter(k => !names.has(k)).map(key => ({ key, where })));
}

// device_steps names that match no agent step in any pipeline (likely typos).
export function unknownDeviceSteps(c: ForemanConfig): { key: string; where: string }[] {
  const names = agentStepNames();
  return Object.values(c.projects).flatMap(p => p.device_steps.filter(k => !names.has(k)).map(key => ({ key, where: `projects.${p.name}` })));
}

// For tests only.
export const testHooks = {
  setHerdrOk(v: boolean) { herdrOk = v; },
  setLastTickStart(ms: number | null) { lastTickStart = ms; },
  launchesSettled: () => Promise.allSettled([...launching.values()]),
};

export async function main(): Promise<void> {
  herdrOk = await herdr.herdrAvailable();
  // R3: a long outage must not expire every live lease on the first tick.
  const extended = extendRunningLeases(() => addSeconds(cfg.defaults.lease_sec));
  if (extended) log(`startup: extended ${extended} running lease(s) by ${cfg.defaults.lease_sec}s`);
  for (const { key, where } of unknownTimeoutKeys(cfg)) log(`config: step_timeouts key '${key}' (${where}) matches no pipeline step`);
  for (const { key, where } of unknownDeviceSteps(cfg)) log(`config: device_steps '${key}' (${where}) matches no pipeline step`);
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
