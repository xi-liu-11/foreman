// `foreman run-step <id>`: runs one pipeline step as a headless Claude Code
// session, pretty-prints the stream to the terminal (the herdr pane), keeps the
// raw transcript on disk, heartbeats the scheduler, and reports the result.
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, appendFileSync, existsSync } from "node:fs";
import { TaskdClient } from "./client";
import { REPO_ROOT, RUNS_DIR } from "./config";
import { WORKER_RESULT_SCHEMA } from "./schema";
import { prettyEvent } from "./pretty";

interface StepContext {
  step: any; task: any; project: any; defaults: any; deny: string[];
  prompt_vars: Record<string, string>; step_prompt: string;
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
}

export async function runStep(stepId: number): Promise<void> {
  const client = TaskdClient.fromEnvOrConfig();
  const ctx: StepContext = await client.get(`/steps/${stepId}/context`);
  const { step, task, project, defaults } = ctx;
  const runDir = join(RUNS_DIR, task.id, `${step.name}-${step.attempt}`);
  mkdirSync(runDir, { recursive: true });
  const cwd = task.worktree ?? project.path;

  // System prompt = worker preamble + role + step instructions.
  const preamble = readFileSync(join(REPO_ROOT, "prompts", "worker-preamble.md"), "utf8");
  const roleFile = join(REPO_ROOT, "roles", `${step.role}.md`);
  const role = existsSync(roleFile) ? readFileSync(roleFile, "utf8") : "";
  const vars = {
    ...ctx.prompt_vars,
    STEP_PROMPT: fill(ctx.step_prompt, ctx.prompt_vars),
    RESUME_NOTE: step.resume_prompt ? "This session is being resumed. Read the new user message and continue from where you left off." : "",
  };
  const systemPrompt = fill(preamble, vars) + "\n\n" + role;
  writeFileSync(join(runDir, "system.md"), systemPrompt);

  const agents = {
    worker: {
      description: "Focused subagent for a narrow, self-contained subtask (search, implement one file, run one check). Default choice for delegation.",
      prompt: "You are a focused worker. Do exactly the subtask in your brief inside the current checkout, verify it, and report concisely with file paths. Do not widen scope. Never push, merge, or deploy.",
      model: defaults.subagent_model,
    },
    explorer: {
      description: "Read-only codebase or documentation search. Returns findings with file paths and line numbers.",
      prompt: "You search and read; you never modify files. Report findings with exact paths and line numbers, and say what you did not find.",
      model: defaults.subagent_model,
      tools: ["Read", "Grep", "Glob", "Bash", "WebFetch", "WebSearch"],
    },
    consultant: {
      description: "Senior consultant for high-level design judgement, trade-off analysis, and hard problems. Expensive: use sparingly and only with a precise question.",
      prompt: "You are a senior consultant. Give a decisive, well-reasoned recommendation with trade-offs. Do not modify files.",
      model: defaults.consultant_model,
      tools: ["Read", "Grep", "Glob"],
    },
  };
  const agentsFile = join(runDir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify(agents, null, 2));

  const userPrompt = step.resume_prompt ?? `# Task brief\n\n${task.brief}`;
  writeFileSync(join(runDir, "prompt.md"), userPrompt);

  // Workers run autonomously inside their own checkout; the deny list (push,
  // merge, deploy, destructive git, production data) is the guard rail.
  const permissionMode = defaults.permission_mode ?? "bypassPermissions";
  const args = [
    process.env.FOREMAN_CLAUDE_BIN ?? "claude", "-p",
    "--model", defaults.orchestrator_model,
    "--output-format", "stream-json", "--verbose",
    "--permission-mode", permissionMode,
    "--max-turns", String(defaults.max_turns),
    "--json-schema", JSON.stringify(WORKER_RESULT_SCHEMA),
    "--agents", agentsFile,
    "--append-system-prompt-file", join(runDir, "system.md"),
    "--name", `${task.id}:${step.name}`,
  ];
  // --disallowedTools is variadic, so it must be one comma-joined argument and
  // the prompt goes over stdin, never as a trailing positional.
  if (ctx.deny.length) args.push("--disallowedTools", ctx.deny.join(","));
  if (step.resume_prompt && step.session_id) args.push("--resume", step.session_id);
  writeFileSync(join(runDir, "command.txt"), args.map(a => /\s/.test(a) ? JSON.stringify(a) : a).join(" ") + "  < prompt.md");

  console.log(`\x1b[1mForeman\x1b[0m ${task.id} ${step.name} (attempt ${step.attempt}) in ${cwd}`);
  console.log(`\x1b[2mrun dir: ${runDir}\x1b[0m\n`);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    FOREMAN_URL: client.base, FOREMAN_TOKEN: client.token,
    FOREMAN_TASK: task.id, FOREMAN_STEP: String(step.id),
    FOREMAN_RUN_DIR: runDir,
  };
  const proc = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe", stdin: new Blob([userPrompt]) });

  const transcript = join(runDir, "transcript.jsonl");
  const stderrLog = join(runDir, "stderr.log");
  let resultEvent: any = null;
  let sessionId: string | null = step.session_id ?? null;
  let killedReason: string | null = null;

  const heartbeat = setInterval(async () => {
    try {
      const r = await client.post(`/steps/${step.id}/heartbeat`, {});
      if (r?.cancel) { killedReason = "cancelled"; proc.kill(); }
    } catch (e: any) { console.error(`\x1b[33mheartbeat failed: ${e.message}\x1b[0m`); }
  }, (defaults.heartbeat_sec ?? 30) * 1000);
  const timeout = setTimeout(() => { killedReason = `timeout after ${defaults.step_timeout_min} min`; proc.kill(); }, defaults.step_timeout_min * 60 * 1000);

  const stderrPump = (async () => {
    for await (const chunk of proc.stderr) appendFileSync(stderrLog, Buffer.from(chunk));
  })();

  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of proc.stdout) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      appendFileSync(transcript, line + "\n");
      let ev: any; try { ev = JSON.parse(line); } catch { console.log(line); continue; }
      if (ev.session_id) sessionId = ev.session_id;
      if (ev.type === "result") resultEvent = ev;
      const pretty = prettyEvent(ev);
      if (pretty) console.log(pretty);
    }
  }
  const exitCode = await proc.exited;
  await stderrPump;
  clearInterval(heartbeat); clearTimeout(timeout);

  const report = {
    exit_code: exitCode,
    killed: killedReason,
    session_id: sessionId,
    result: resultEvent,
    stderr_tail: existsSync(stderrLog) ? readFileSync(stderrLog, "utf8").slice(-2000) : "",
    run_dir: runDir,
  };
  writeFileSync(join(runDir, "report.json"), JSON.stringify(report, null, 2));

  // R4: taskd may be restarting. Retry delivery for up to two leases; taskd also
  // picks up report.json on its own if the lease expires before we get through.
  const deadline = Date.now() + 2 * (defaults.lease_sec ?? 150) * 1000;
  let delay = 2000;
  for (;;) {
    try {
      const ack = await client.post(`/steps/${step.id}/result`, report);
      console.log(`\n\x1b[1mReported:\x1b[0m ${ack.step_status} (task ${ack.task_status})`);
      return;
    } catch (e: any) {
      if (/stale attempt/.test(e.message)) { console.log(`\n\x1b[33mResult ignored by taskd: ${e.message}\x1b[0m`); return; }
      if (Date.now() > deadline) { console.error(`\x1b[31mCould not deliver result: ${e.message}. Left in ${runDir}/report.json\x1b[0m`); process.exit(2); }
      console.error(`\x1b[33mresult delivery failed (${e.message}); retrying in ${delay / 1000}s\x1b[0m`);
      await Bun.sleep(delay);
      delay = Math.min(delay * 2, 30000);
    }
  }
}
