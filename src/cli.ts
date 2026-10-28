#!/usr/bin/env bun
// Entry point for both `foreman` (daemon, runner, setup) and `task` (user and
// worker commands). bin/foreman and bin/task are shims that call this file.
import { basename, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { TaskdClient } from "./client";
import { CONFIG_PATH, RUNS_DIR, ensureHome, loadConfig } from "./config";
import { PIPELINES } from "./pipelines";
import { prettyEvent } from "./pretty";

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
                                  with --ticket, title and brief default to the ticket's
              [--branch <existing>] [--start-at <step>]
                                  attach to an existing branch (not checked out anywhere) and/or skip earlier pipeline steps
  task ls [--all] [--project <name>] [--status queued,running,...]
  task show <id>
  task log <id> [step] [--attempt N] [--tail N]
                                  transcript of a step run (--json for raw events)
  task inbox                      open questions and gates waiting on you
  task answer <block-id> "<answer>"
  task approve <id>               approve the gate the task is waiting at
  task retry <id> [--fresh]       retry a failed task (fresh = new session)
  task cancel <id>
  task kinds                      list task kinds (pipelines)
  task projects                   list registered projects
  task ticket ls --project <name> [--states "Todo,In Progress"]
  task ticket show <ref> --project <name>
  task ticket comment <ref> "<body>" --project <name>
  task ticket transition <ref> "<state>" --project <name>
  task ticket create --title "<t>" [--body "<text>"] [--parent <ref>] --project <name>

Worker commands (task and step come from FOREMAN_TASK / FOREMAN_STEP)
  task note "<text>"
  task block "<question>"
  task artifact add <path> [--kind <kind>] [--note "<text>"]
  task ticket show|comment|transition|create ...   (ref defaults to the task's ticket)
  task show                       current task

Add --json to any command for machine-readable output.`;

const FOREMAN_HELP = `foreman — scheduler and worker runner

  foreman taskd            start the scheduler daemon (foreground)
  foreman run-step <id>    run one pipeline step (used by taskd)
  foreman init             create ~/.foreman/config.toml if missing and print its path
  foreman config           print the loaded configuration
  foreman health           check taskd
  foreman service install|uninstall|restart|stop|status
                           run taskd under launchd so it survives terminals and reboots
  foreman assistant        open a Claude Code session that acts as your Foreman assistant
  foreman dashboard        open the live dashboard in your browser (served by taskd)
  foreman watch            live terminal view of the queue (refreshes every 2s)`;

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
      const ticket = opt("ticket");
      const title = opt("title") ?? (ticket ? undefined : die("--title required (or --ticket)"));
      const briefFile = opt("brief-file");
      const brief = briefFile ? await Bun.file(briefFile).text() : opt("brief") ?? rest.join(" ") ?? "";
      if (!brief.trim() && !ticket) die("--brief or --brief-file required (or --ticket)");
      const t = await client.post("/tasks", { project, kind, title, brief: brief.trim() || undefined, priority: opt("priority"), ticket, branch: opt("branch"), start_at: opt("start-at") });
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
        const head = `${pad("ID", 6)} ${pad("STATUS", 9)} ${pad("PROJECT", 14)} ${pad("KIND", 14)} ${pad("STEP", 14)} ${pad("AGE", 5)} ${pad("COST", 7)} ${pad("Q", 2)} TITLE`;
        return [head, ...tasks.map(t => `${pad(t.id, 6)} ${pad(t.status, 9)} ${pad(t.project, 14)} ${pad(t.kind, 14)} ${pad(t.current_step ?? "", 14)} ${pad(ago(t.created_at), 5)} ${pad("$" + t.cost_usd.toFixed(2), 7)} ${pad(t.open_blocks || "", 2)} ${t.title}`)].join("\n");
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
          t.pr_url ? `pr: ${t.pr_url}` : "",
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
    case "log": {
      const id = rest[0] ?? die("task id required");
      const posInt = (name: string) => {
        const v = opt(name); if (v === undefined) return undefined;
        return /^[1-9]\d*$/.test(v) ? Number(v) : die(`--${name} must be a positive integer`);
      };
      const tail = posInt("tail");
      const d = await client.get(`/tasks/${id}`);
      const taskId: string = d.task.id;
      const steps: any[] = d.steps;
      if (!steps.length) die(`${taskId} has no steps yet`);
      const name = rest[1] ?? steps[steps.length - 1].name;
      const named = steps.filter(s => s.name === name);
      if (!named.length) die(`no step '${name}' on ${taskId}`);
      const attempt = posInt("attempt") ?? Math.max(...named.map(s => s.attempt));
      if (!named.some(s => s.attempt === attempt)) die(`no attempt ${attempt} of step '${name}' on ${taskId}`);
      const path = join(RUNS_DIR, taskId, `${name}-${attempt}`, "transcript.jsonl");
      if (!existsSync(path)) die(`no transcript at ${path}`);
      const raw = readFileSync(path, "utf8").split("\n").filter(l => l.trim());
      const lines = jsonOut ? raw : raw.flatMap(l => {
        let ev: any; try { ev = JSON.parse(l); } catch { return [l]; }
        const p = prettyEvent(ev);
        return p ? p.split("\n") : [];
      });
      const shown = tail ? lines.slice(-tail) : lines;
      if (shown.length) console.log(shown.join("\n"));
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
    case "ticket": {
      const sub = rest[0];
      const scope: Record<string, string | undefined> = envTask ? { task: envTask } : { project: opt("project") };
      if (!scope.task && !scope.project) die("--project required (or run inside a Foreman task)");
      const q = `?${new URLSearchParams(scope as Record<string, string>)}`;
      const defaultRef = async () => envTask ? (await client.get(`/tasks/${envTask}`)).task.ticket ?? die("this task has no linked ticket; give the ref") : die("ticket ref required");
      // Ref is optional inside a task: `task ticket comment "text"` targets the linked ticket.
      const refAndText = async (needText: boolean) => {
        const a = rest.slice(1);
        if (a.length >= 2 || (a.length === 1 && !needText)) return [a[0], a.slice(1).join(" ")];
        return [await defaultRef(), a.join(" ")];
      };
      if (sub === "ls") {
        const q2 = new URLSearchParams(scope as Record<string, string>); if (opt("states")) q2.set("states", opt("states")!);
        const ts: any[] = await client.get(`/tickets?${q2}`);
        out(ts, () => ts.length ? ts.map(t => `${pad(t.ref, 8)} ${pad(t.state, 12)} P${t.priority} ${pad(t.project, 32)} ${t.title}${t.labels.length ? "  [" + t.labels.join(", ") + "]" : ""}`).join("\n") : "no tickets");
        return;
      }
      if (sub === "show") {
        const [ref] = await refAndText(false);
        const t = await client.get(`/tickets/${encodeURIComponent(ref)}${q}`);
        out(t, () => `${t.ref} [${t.state}] ${t.title}
${t.url}

${t.description}`);
        return;
      }
      if (sub === "comment") {
        const [ref, text] = await refAndText(true); if (!text) die("comment body required");
        await client.post(`/tickets/${encodeURIComponent(ref)}/comment`, { ...scope, body: text, step_id: envStep });
        console.log(`commented on ${ref}`); return;
      }
      if (sub === "transition") {
        const [ref, state] = await refAndText(true); if (!state) die("state name required");
        const r = await client.post(`/tickets/${encodeURIComponent(ref)}/transition`, { ...scope, state, step_id: envStep });
        console.log(`${ref} -> ${r.state}`); return;
      }
      if (sub === "create") {
        const t = await client.post("/tickets", { ...scope, title: opt("title") ?? die("--title required"), description: opt("body"), parent: opt("parent"), step_id: envStep });
        out(t, () => `created ${t.ref}: ${t.url}`); return;
      }
      die("usage: task ticket show|comment|transition|create ...");
    }
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
    case "dashboard": {
      const cfg = loadConfig();
      const url = `http://${cfg.server.bind === "0.0.0.0" ? "127.0.0.1" : cfg.server.bind}:${cfg.server.port}/dashboard?token=${cfg.server.token}`;
      console.log(url);
      if (!flag("print")) Bun.spawn(["open", url]).unref();
      return;
    }
    case "watch": {
      const c = TaskdClient.fromEnvOrConfig();
      for (;;) {
        let body: string;
        try {
          const all: any[] = await c.get("/tasks?all=1");
          const active = all.filter(t => ["queued", "running", "blocked", "gate"].includes(t.status));
          const lines: string[] = [`Foreman  ${new Date().toLocaleTimeString()}  ${active.length} active`, ""];
          for (const t of active) {
            const d = await c.get(`/tasks/${t.id}`);
            const running = d.steps.filter((s: any) => s.status === "running").map((s: any) => `${s.name} ${ago(s.started_at)}`).join(", ");
            lines.push(`${t.id} ${pad(t.status, 8)} ${pad(t.project, 14)} ${pad(t.current_step ?? "", 14)} $${t.cost_usd.toFixed(2)}  ${t.title}${running ? `  [${running}]` : ""}`);
            for (const b of d.blocks) lines.push(`      ? [${b.id}] ${b.question.split("\n")[0]}`);
            if (t.status === "gate") lines.push(`      ! waiting for approval at ${t.current_step}`);
            const notes = d.events.filter((e: any) => e.type === "note").slice(-2);
            for (const e of notes) lines.push(`      ${e.ts.slice(11, 16)} ${JSON.parse(e.data).text.split("\n")[0].slice(0, 110)}`);
          }
          const recent = all.filter(t => !active.includes(t)).slice(0, 6);
          if (recent.length) { lines.push("", "recent:"); for (const t of recent) lines.push(`${t.id} ${pad(t.status, 9)} ${pad(t.project, 14)} $${t.cost_usd.toFixed(2)}  ${t.title}`); }
          body = lines.join("\n");
        } catch (e: any) { body = `taskd unreachable: ${e.message}`; }
        process.stdout.write("\x1b[2J\x1b[H" + body + "\n");
        await Bun.sleep(2000);
      }
    }
    case "service": { const { serviceCommand } = await import("./service"); await serviceCommand(rest[0]); return; }
    case "assistant": {
      // The assistant is an ordinary interactive Claude Code session with the
      // foreman skill as its system prompt. Run it in any herdr pane.
      const { REPO_ROOT } = await import("./config");
      const skill = join(REPO_ROOT, "skills", "foreman", "SKILL.md");
      const body = readFileSync(skill, "utf8").replace(/^---[\s\S]*?---\n/, "");
      const proc = Bun.spawn(["claude", "--append-system-prompt", body, ...rest], { stdio: ["inherit", "inherit", "inherit"] });
      process.exit(await proc.exited);
    }
    default: die(`unknown command '${cmd}'\n\n${FOREMAN_HELP}`);
  }
}

try {
  if (invokedAs === "foreman") await foremanMain(); else await taskMain();
} catch (e: any) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
