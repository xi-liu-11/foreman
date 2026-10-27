#!/usr/bin/env bun
// Entry point for both `foreman` (daemon, runner, setup) and `task` (user and
// worker commands). bin/foreman and bin/task are shims that call this file.
import { basename } from "node:path";
import { TaskdClient } from "./client";
import { CONFIG_PATH, ensureHome, loadConfig } from "./config";
import { PIPELINES } from "./pipelines";

const argv = process.argv.slice(2);
const invokedAs = process.env.FOREMAN_CLI_NAME ?? basename(process.argv[1] ?? "task");
const jsonOut = argv.includes("--json");
const args = argv.filter(a => a !== "--json");

function opt(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return undefined;
}
function positional(): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) { i++; continue; }
    out.push(args[i]);
  }
  return out;
}
const flag = (name: string) => args.includes(`--${name}`);
const die = (msg: string): never => { console.error(`error: ${msg}`); process.exit(1); };
const pad = (s: unknown, n: number) => String(s ?? "").padEnd(n).slice(0, n);
const ago = (iso: string | null) => {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  return s < 60 ? `${Math.round(s)}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
};
const out = (data: unknown, text: () => string) => console.log(jsonOut ? JSON.stringify(data, null, 2) : text());

const TASK_HELP = `task — Foreman task CLI

User commands
  task create --project <name> --kind <kind> --title "<t>" [--brief "<text>" | --brief-file <path>] [--priority N] [--ticket <ref>]
  task ls [--all] [--project <name>] [--status queued,running,...]
  task show <id>
  task inbox                      open questions and gates waiting on you
  task answer <block-id> "<answer>"
  task approve <id>               approve the gate the task is waiting at
  task retry <id> [--fresh]       retry a failed task (fresh = new session)
  task cancel <id>
  task kinds                      list task kinds (pipelines)
  task projects                   list registered projects

Worker commands (task and step come from FOREMAN_TASK / FOREMAN_STEP)
  task note "<text>"
  task block "<question>"
  task artifact add <path> [--kind <kind>] [--note "<text>"]
  task show                       current task

Add --json to any command for machine-readable output.`;

const FOREMAN_HELP = `foreman — scheduler and worker runner

  foreman taskd            start the scheduler daemon (foreground)
  foreman run-step <id>    run one pipeline step (used by taskd)
  foreman init             create ~/.foreman/config.toml if missing and print its path
  foreman config           print the loaded configuration
  foreman health           check taskd`;

async function taskMain(): Promise<void> {
  const [cmd, ...rest] = positional();
  const client = TaskdClient.fromEnvOrConfig();
  const envTask = process.env.FOREMAN_TASK;
  const envStep = process.env.FOREMAN_STEP ? Number(process.env.FOREMAN_STEP) : null;

  switch (cmd) {
    case undefined: case "help": case "--help": console.log(TASK_HELP); return;

    case "create": {
      const project = opt("project") ?? die("--project required");
      const kind = opt("kind") ?? die("--kind required");
      const title = opt("title") ?? die("--title required");
      const briefFile = opt("brief-file");
      const brief = briefFile ? await Bun.file(briefFile).text() : opt("brief") ?? rest.join(" ") ?? "";
      if (!brief.trim()) die("--brief or --brief-file required");
      const t = await client.post("/tasks", { project, kind, title, brief, priority: opt("priority"), ticket: opt("ticket") });
      out(t, () => `created ${t.id} [${t.kind}] ${t.title}`);
      return;
    }
    case "ls": {
      const q = new URLSearchParams();
      if (flag("all")) q.set("all", "1");
      if (opt("project")) q.set("project", opt("project")!);
      if (opt("status")) q.set("status", opt("status")!);
      const tasks: any[] = await client.get(`/tasks?${q}`);
      out(tasks, () => {
        if (!tasks.length) return "no tasks";
        const head = `${pad("ID", 6)} ${pad("STATUS", 9)} ${pad("PROJECT", 14)} ${pad("KIND", 10)} ${pad("STEP", 14)} ${pad("AGE", 5)} ${pad("COST", 7)} ${pad("Q", 2)} TITLE`;
        return [head, ...tasks.map(t => `${pad(t.id, 6)} ${pad(t.status, 9)} ${pad(t.project, 14)} ${pad(t.kind, 10)} ${pad(t.current_step ?? "", 14)} ${pad(ago(t.created_at), 5)} ${pad("$" + t.cost_usd.toFixed(2), 7)} ${pad(t.open_blocks || "", 2)} ${t.title}`)].join("\n");
      });
      return;
    }
    case "show": {
      const id = rest[0] ?? envTask ?? die("task id required");
      const d = await client.get(`/tasks/${id}`);
      out(d, () => {
        const t = d.task;
        const lines = [
          `${t.id} [${t.kind}] ${t.title}`,
          `status: ${t.status}   project: ${t.project}   step: ${t.current_step ?? "-"}   qa cycles: ${t.qa_cycles}`,
          t.worktree ? `worktree: ${t.worktree} (${t.branch})` : "",
          t.ticket ? `ticket: ${t.ticket}` : "",
          "", "brief:", t.brief.split("\n").map((l: string) => "  " + l).join("\n"), "",
          "steps:",
          ...d.steps.map((s: any) => {
            const r = s.result ? JSON.parse(s.result) : null;
            return `  ${pad(s.name, 14)} #${s.attempt} ${pad(s.status, 8)} ${pad(s.role, 13)} ${pad(ago(s.started_at), 5)} $${s.cost_usd.toFixed(2)} ${s.turns}t${r?.verdict && r.verdict !== "n/a" ? " verdict=" + r.verdict : ""}${s.error ? " error: " + s.error : ""}${s.tab_id ? " tab=" + s.tab_id : ""}` +
              (r?.summary ? `\n      ${r.summary.replace(/\n/g, "\n      ")}` : "");
          }),
          d.blocks.length ? ["", "open questions:", ...d.blocks.map((b: any) => `  [${b.id}] ${b.question}`)].join("\n") : "",
          d.artifacts.length ? ["", "artifacts:", ...d.artifacts.map((a: any) => `  ${pad(a.kind, 10)} ${a.path}${a.note ? "  — " + a.note : ""}`)].join("\n") : "",
          t.result ? `\nresult: ${JSON.parse(t.result).summary ?? JSON.parse(t.result).error ?? ""}` : "",
          "", "recent events:",
          ...d.events.slice(-12).map((e: any) => `  ${e.ts.slice(11, 19)} ${pad(e.type, 20)} ${JSON.stringify(JSON.parse(e.data)).slice(0, 110)}`),
        ];
        return lines.filter(l => l !== "").join("\n");
      });
      return;
    }
    case "inbox": {
      const blocks: any[] = await client.get("/blocks");
      const gates: any[] = await client.get("/tasks?status=gate");
      out({ blocks, gates }, () => {
        const lines: string[] = [];
        if (blocks.length) { lines.push("questions:"); for (const b of blocks) lines.push(`  [${b.id}] ${b.task_id} (${b.task?.title}) ${ago(b.created_at)} ago\n      ${b.question.replace(/\n/g, "\n      ")}`); }
        if (gates.length) { lines.push("gates:"); for (const g of gates) lines.push(`  ${g.id} ${g.title} — waiting at ${g.current_step}: task approve ${g.id}`); }
        return lines.length ? lines.join("\n") : "inbox empty";
      });
      return;
    }
    case "answer": {
      const id = rest[0] ?? die("block id required"); const answer = rest.slice(1).join(" ") || die("answer text required");
      const r = await client.post(`/blocks/${id}/answer`, { answer });
      out(r, () => r.resumed ? "answered; worker resuming" : r.remaining ? `answered; ${r.remaining} more question(s) open on this step` : "answered");
      return;
    }
    case "approve": { const id = rest[0] ?? die("task id required"); const r = await client.post(`/tasks/${id}/approve`, {}); out(r, () => `approved ${r.gate}`); return; }
    case "retry": { const id = rest[0] ?? die("task id required"); const r = await client.post(`/tasks/${id}/retry`, { fresh: flag("fresh") }); out(r, () => `retrying at ${r.step}`); return; }
    case "cancel": { const id = rest[0] ?? die("task id required"); await client.post(`/tasks/${id}/cancel`, {}); console.log("cancelled"); return; }
    case "kinds": out(PIPELINES, () => Object.values(PIPELINES).map(p => `${pad(p.kind, 11)} ${p.description}${p.needs_worktree ? " (worktree)" : ""}`).join("\n")); return;
    case "projects": { const ps: any[] = await client.get("/projects"); out(ps, () => ps.map(p => `${pad(p.name, 16)} ${pad(p.verify, 8)} ${p.speckit ? "speckit" : "       "} ${p.path}`).join("\n") || `no projects; edit ${CONFIG_PATH}`); return; }

    // worker commands
    case "note": { const id = envTask ?? die("FOREMAN_TASK not set"); await client.post(`/tasks/${id}/note`, { text: rest.join(" "), step_id: envStep }); console.log("noted"); return; }
    case "block": {
      const id = envTask ?? die("FOREMAN_TASK not set"); if (!envStep) die("FOREMAN_STEP not set");
      const question = rest.join(" ") || die("question required");
      const b = await client.post(`/tasks/${id}/blocks`, { question, step_id: envStep });
      console.log(`block #${b.id} registered. Now finish with status "blocked"; the scheduler will resume this session with the answer.`);
      return;
    }
    case "artifact": {
      const id = envTask ?? opt("task") ?? die("FOREMAN_TASK not set");
      if (rest[0] !== "add") die("usage: task artifact add <path> [--kind k] [--note n]");
      const a = await client.post(`/tasks/${id}/artifacts`, { path: rest[1] ?? die("path required"), kind: opt("kind") ?? "file", note: opt("note"), step_id: envStep });
      console.log(`artifact #${a.id} registered`);
      return;
    }
    case "ticket": die("ticket integration arrives in slice 4; record what you would have done with `task note` instead");
    default: die(`unknown command '${cmd}'\n\n${TASK_HELP}`);
  }
}

async function foremanMain(): Promise<void> {
  const [cmd, ...rest] = positional();
  switch (cmd) {
    case undefined: case "help": case "--help": console.log(FOREMAN_HELP); return;
    case "taskd": { const { main } = await import("./taskd"); await main(); return; }
    case "run-step": { const { runStep } = await import("./runner"); await runStep(Number(rest[0] ?? die("step id required"))); return; }
    case "init": ensureHome(); console.log(CONFIG_PATH); return;
    case "config": console.log(JSON.stringify(loadConfig(), null, 2)); return;
    case "health": { const c = TaskdClient.fromEnvOrConfig(); console.log(JSON.stringify(await c.get("/health"))); return; }
    default: die(`unknown command '${cmd}'\n\n${FOREMAN_HELP}`);
  }
}

try {
  if (invokedAs === "foreman") await foremanMain(); else await taskMain();
} catch (e: any) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
