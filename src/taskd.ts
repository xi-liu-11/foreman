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
import { Store, type TaskRow, type StepRow, now } from "./db";
import { loadConfig, denyListFor, REPO_ROOT, RUNS_DIR, type ForemanConfig, type ProjectConfig } from "./config";
import { pipelineFor, type PipelineStep } from "./pipelines";
import * as herdr from "./herdr";
import * as git from "./git";

const cfg: ForemanConfig = loadConfig();
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
const pipelineSteps = (task: TaskRow) => JSON.parse(task.pipeline) as PipelineStep[];
const agentDefs = (steps: PipelineStep[]) => steps.flatMap(p => p.type === "parallel" ? p.children : p.type === "agent" ? [p] : []);
const runDirFor = (task: TaskRow, step: StepRow) => join(RUNS_DIR, task.id, `${step.name}-${step.attempt}`);

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
    cancelRequested.add(s.id);
    if (s.tab_id) await herdr.closeTab(s.tab_id, s.machine);
  }
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await expireLeases();
    for (const task of store.listTasks({ status: ["queued", "running", "blocked"] })) {
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
    if (!latest) return createStep(task, ps.name, ps.role, 1);
    return settle(task, latest, ps.role, next);
  }

  if (ps.type === "gate") {
    const latest = store.latestStep(task.id, ps.name);
    if (latest?.status === "done") return next();
    if (!latest) {
      tx(() => {
        store.insertStep({ task_id: task.id, name: ps.name, role: "user", status: "gate", attempt: 1 });
        store.updateTask(task.id, { status: "gate" });
        store.event("task.gate", { gate: ps.name, label: ps.label }, task.id);
      });
      await herdr.notify(`${task.id} needs approval`, `${ps.label}: ${task.title}`, "request");
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
    if (latest?.status === "done") return next();
    if (latest?.status === "running") return;
    if (latest?.status === "failed" && failureCount(task.id, ps.name) >= cfg.defaults.max_attempts) {
      return failTask(task, `system step '${ps.name}' failed ${failureCount(task.id, ps.name)} times: ${latest.error}`);
    }
    return runSystem(task, ps, (latest?.attempt ?? 0) + 1);
  }
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
    if (ps.action === "open_pr") {
      const bodyFile = task.feature_dir ? join(task.worktree, task.feature_dir, "pr.md") : null;
      const url = await git.pushAndOpenPr(proj, task.worktree, task.branch, task.title, bodyFile);
      store.updateTask(task.id, { pr_url: url });
      summary = `PR opened: ${url}`;
      await herdr.notify(`${task.id} PR opened`, url, "done");
    } else {
      if (!task.pr_url) throw new Error("no PR URL recorded; open_pr must run first");
      await git.mergePr(proj, task.worktree, task.pr_url);
      await git.removeWorktree(proj, task.worktree);
      summary = `Merged ${task.pr_url} and removed worktree`;
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
      const answered = store.blocksForStep(latest.id).filter(b => b.answer && b.answer !== "(task cancelled)");
      if (!answered.length) return;
      const resume = `The user answered your question(s):\n\n${answered.map(x => `Q: ${x.question}\nA: ${x.answer}`).join("\n\n")}\n\nContinue the step from where you left off.`;
      await createStep(task, latest.name, role, latest.attempt + 1, latest.session_id, resume);
      if (latest.tab_id) await herdr.closeTab(latest.tab_id, latest.machine);
      return;
    }
    case "failed": {
      if (task.status === "cancelled") return;
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
    store.updateStep(step.id, { status: "running", started_at: now(), lease_until: addSeconds(cfg.defaults.lease_sec) });
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
  });
  // R2: siblings still running (parallel QA) must stop.
  for (const s of running) cancelRequested.add(s.id);
  await herdr.notify(`${task.id} failed`, reason, "request");
  log(`failed ${task.id}: ${reason}`);
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
  if (task.status === "cancelled") { status = "failed"; error = error ?? "cancelled"; }

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
      if (task.status !== "cancelled") store.updateTask(task.id, { status: "blocked" });
    }
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

function stepContext(step: StepRow) {
  const task = store.getTask(step.task_id)!;
  const proj = project(task);
  const ps = pipelineSteps(task);
  const def = agentDefs(ps).find(p => p.name === step.name);
  const promptName = def?.prompt ?? step.name;
  const promptFile = join(REPO_ROOT, "prompts", `${promptName}.md`);
  const step_prompt = existsSync(promptFile) ? readFileSync(promptFile, "utf8") : "";

  let qaFeedback = "";
  const qaGroup = ps.find(p => p.type === "parallel" && p.on_fail === step.name) as any;
  if (qaGroup && task.qa_cycles > 0) {
    const parts = qaGroup.children.map((c: any) => {
      const rows = store.stepsForTask(task.id).filter(s => s.name === c.name && s.result);
      const last = rows[rows.length - 1];
      const r = last?.result ? JSON.parse(last.result) : null;
      return r ? `### ${c.name} (${r.verdict})\n${r.summary}\n${r.notes_for_next ?? ""}` : "";
    }).filter(Boolean);
    if (parts.length) qaFeedback = `\n\nThis is QA cycle ${task.qa_cycles}. Address the following QA findings before anything else:\n\n${parts.join("\n\n")}`;
  }

  const prompt_vars: Record<string, string> = {
    TASK_ID: task.id, TASK_TITLE: task.title, STEP_NAME: step.name, ATTEMPT: String(step.attempt),
    PROJECT: task.project, CWD: task.worktree ?? proj.path, VERIFY: proj.verify,
    PROJECT_NOTES: proj.notes ? `- Project notes: ${proj.notes}` : "",
    SLUG: slugify(task.title), FEATURE: (task.feature_dir ?? "").replace(/^specs\//, ""), BASE_BRANCH: proj.base_branch,
    QA_CYCLE: String(task.qa_cycles + 1), QA_FEEDBACK: qaFeedback,
  };
  return { step, task, project: proj, defaults: cfg.defaults, deny: denyListFor(cfg, proj), prompt_vars, step_prompt };
}

// ---------------------------------------------------------------- HTTP API

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const bad = (msg: string, status = 400) => json({ error: msg }, status);

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (p === "/health") return json({ ok: true, herdr: herdrOk, running: store.runningCount() });
  if (req.headers.get("authorization") !== `Bearer ${cfg.server.token}`) return bad("unauthorized", 401);
  const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
  const m = (re: RegExp) => p.match(re);
  let mm: RegExpMatchArray | null;

  if (p === "/projects" && req.method === "GET") return json(Object.values(cfg.projects));

  if (p === "/tasks" && req.method === "GET") {
    const status = url.searchParams.get("status")?.split(",").filter(Boolean);
    const tasks = store.listTasks({ status, project: url.searchParams.get("project") ?? undefined, all: url.searchParams.get("all") === "1" });
    return json(tasks.map(t => ({ ...t, open_blocks: store.openBlocks(t.id).length, cost_usd: store.stepsForTask(t.id).reduce((a, s) => a + s.cost_usd, 0) })));
  }
  if (p === "/tasks" && req.method === "POST") {
    const { project: projName, kind, title, brief, priority, ticket } = body;
    if (!cfg.projects[projName]) return bad(`unknown project '${projName}'. Known: ${Object.keys(cfg.projects).join(", ") || "(none; add one to config.toml)"}`);
    if (!title || !brief) return bad("title and brief are required");
    const proj = cfg.projects[projName];
    let pipeline; try { pipeline = pipelineFor(kind, proj.speckit); } catch (e: any) { return bad(e.message); }
    const id = store.nextTaskId();
    let wt: git.WorktreeInfo | null = null;
    if (pipeline.needs_worktree) {
      try {
        const featureNumber = proj.speckit ? store.nextFeatureNumber(projName, await git.highestFeatureNumber(proj.path)) : null;
        wt = await git.setupWorktree(cfg, proj, id, title, featureNumber);
      } catch (e: any) { return bad(`could not prepare worktree: ${e.message}`); }
    }
    const task = tx(() => {
      const t = store.insertTask({ id, project: projName, kind: pipeline.kind, title, brief, status: "queued", pipeline: JSON.stringify(pipeline.steps), current_step: null, priority: Number(priority ?? 5), branch: wt?.branch ?? null, worktree: wt?.worktree ?? null, feature_dir: wt?.feature_dir ?? null, ticket: ticket ?? null, pr_url: null, qa_cycles: 0, result: null });
      store.event("task.created", { kind: pipeline.kind, title, branch: wt?.branch ?? null, worktree: wt?.worktree ?? null }, t.id);
      return t;
    });
    log(`created ${task.id} [${kind}] ${title}`);
    setTimeout(tick, 50);
    return json(task, 201);
  }
  if ((mm = m(/^\/tasks\/([^/]+)$/)) && req.method === "GET") {
    const task = store.getTask(mm[1]); if (!task) return bad("no such task", 404);
    return json({ task, steps: store.stepsForTask(task.id), blocks: store.openBlocks(task.id), artifacts: store.artifactsForTask(task.id), events: store.eventsForTask(task.id, 50).reverse() });
  }
  if ((mm = m(/^\/tasks\/([^/]+)\/(cancel|approve|retry|note|artifacts|blocks)$/)) && req.method === "POST") {
    const task = store.getTask(mm[1]); if (!task) return bad("no such task", 404);
    const action = mm[2];
    if (action === "cancel") {
      const running = store.stepsForTask(task.id).filter(s => s.status === "running");
      tx(() => {
        for (const b of store.openBlocks(task.id)) store.answerBlock(b.id, "(task cancelled)");
        store.updateTask(task.id, { status: "cancelled" }); store.event("task.cancelled", {}, task.id);
      });
      for (const s of running) cancelRequested.add(s.id);
      return json({ ok: true });
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
    if (action === "retry") {
      if (task.status !== "failed") return bad(`task is ${task.status}, not failed`);
      const steps = pipelineSteps(task);
      const cur = task.current_step ?? steps[0]?.name ?? null;
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
      if (["cancelled", "failed", "done"].includes(task.status)) store.answerBlock(b.id, `(task ${task.status})`);
      return json(b, 201);
    }
  }
  if (p === "/blocks" && req.method === "GET") {
    return json(store.openBlocks().map(b => ({ ...b, task: store.getTask(b.task_id) })));
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
    return json(stepContext(s));
  }
  if ((mm = m(/^\/steps\/(\d+)\/heartbeat$/)) && req.method === "POST") {
    const step = store.getStep(Number(mm[1])); if (!step) return bad("no such step", 404);
    const task = store.getTask(step.task_id)!;
    // R2: anything that is not the current running attempt of an active task must stop.
    const stale = step.status !== "running" || store.latestStep(task.id, step.name)?.id !== step.id || !["running", "queued", "blocked"].includes(task.status);
    if (!stale) store.updateStep(step.id, { lease_until: addSeconds(cfg.defaults.lease_sec) });
    return json({ ok: true, cancel: stale || cancelRequested.has(step.id) });
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

export async function main(): Promise<void> {
  herdrOk = await herdr.herdrAvailable();
  // R3: a long outage must not expire every live lease on the first tick.
  const live = store.runningSteps();
  if (live.length) {
    for (const s of live) store.updateStep(s.id, { lease_until: addSeconds(cfg.defaults.lease_sec) });
    log(`startup: extended ${live.length} running lease(s) by ${cfg.defaults.lease_sec}s`);
  }
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
