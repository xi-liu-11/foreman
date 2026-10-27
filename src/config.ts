// Foreman configuration: ~/.foreman/config.toml holds server settings, defaults,
// and the project registry. Per-repo knowledge stays in each repo's CLAUDE.md
// and .specify/memory/constitution.md.
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

export const FOREMAN_HOME = process.env.FOREMAN_HOME ?? join(homedir(), ".foreman");
export const CONFIG_PATH = join(FOREMAN_HOME, "config.toml");
export const DB_PATH = join(FOREMAN_HOME, "foreman.db");
export const RUNS_DIR = join(FOREMAN_HOME, "runs");
export const REPO_ROOT = join(import.meta.dir, "..");

export type VerifyMode = "tests" | "browser" | "inspect";

export interface ProjectConfig {
  name: string;
  path: string;            // expanded absolute path to the main checkout
  base_branch: string;
  verify: VerifyMode;
  speckit: boolean;
  deny: string[];          // extra disallowed tool patterns for this project
  concurrency: number;     // max concurrent running steps in this project
  machine?: string;        // herdr saved machine label (slice 5)
  tickets?: string;        // ticket provider: github | linear | jira (slice 4)
  notes?: string;          // free text injected into every worker prompt
}

export interface Defaults {
  orchestrator_model: string;
  subagent_model: string;
  consultant_model: string;
  max_turns: number;
  step_timeout_min: number;
  max_attempts: number;
  max_qa_cycles: number;
  concurrency: number;
  heartbeat_sec: number;
  lease_sec: number;
  deny: string[];
  worktrees: string;
  run_retention_days: number;
}

export interface ForemanConfig {
  server: { port: number; bind: string; token: string };
  defaults: Defaults;
  projects: Record<string, ProjectConfig>;
}

export const GLOBAL_DENY = [
  "Bash(git push*)",
  "Bash(git push)",
  "Bash(gh pr merge*)",
  "Bash(gh release*)",
  "Bash(git reset --hard*)",
  "Bash(git clean*)",
  "Bash(rm -rf /*)",
  "Bash(sudo *)",
  "Bash(vercel deploy*)",
  "Bash(vercel --prod*)",
  "Bash(wrangler deploy*)",
  "Bash(wrangler publish*)",
  "Bash(npx wrangler deploy*)",
  "Bash(supabase db push*)",
  "Bash(supabase db reset*)",
  "Bash(fly deploy*)",
  "Bash(kubectl apply*)",
  "Bash(terraform apply*)",
];

const DEFAULTS: Defaults = {
  orchestrator_model: "claude-opus-5-5",
  subagent_model: "claude-sonnet-5-5",
  consultant_model: "claude-fable-5-1",
  max_turns: 200,
  step_timeout_min: 90,
  max_attempts: 3,
  max_qa_cycles: 3,
  concurrency: 3,
  heartbeat_sec: 30,
  lease_sec: 150,
  deny: [],
  worktrees: "~/git/.worktrees",
  run_retention_days: 30,
};

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

export function defaultConfigToml(): string {
  const token = crypto.randomUUID().replace(/-/g, "");
  return `# Foreman configuration
[server]
port = 7777
bind = "127.0.0.1"   # use "0.0.0.0" to let LAN workers reach taskd
token = "${token}"

[defaults]
orchestrator_model = "claude-opus-5-5"
subagent_model = "claude-sonnet-5-5"
consultant_model = "claude-fable-5-1"
max_turns = 200
step_timeout_min = 90
max_attempts = 3
max_qa_cycles = 3
concurrency = 3
heartbeat_sec = 30
lease_sec = 150
worktrees = "~/git/.worktrees"
run_retention_days = 30
# Extra tool patterns denied for every project, on top of the built-in list
# (push, merge, deploy, destructive git, sudo).
deny = []

# One table per project. Only listed projects can receive tasks.
# [projects.dicer]
# path = "~/git/dicer"
# base_branch = "main"
# verify = "browser"     # tests | browser | inspect
# speckit = true
# concurrency = 2
# deny = ["Bash(supabase *)"]
# tickets = "github"
# notes = "Three.js app; run with bun dev on port 5173."
`;
}

export function ensureHome(): void {
  for (const d of [FOREMAN_HOME, RUNS_DIR]) if (!existsSync(d)) mkdirSync(d, { recursive: true });
  if (!existsSync(CONFIG_PATH)) writeFileSync(CONFIG_PATH, defaultConfigToml());
}

export function loadConfig(): ForemanConfig {
  ensureHome();
  const raw = Bun.TOML.parse(readFileSync(CONFIG_PATH, "utf8")) as any;
  const server = {
    port: Number(raw.server?.port ?? 7777),
    bind: String(raw.server?.bind ?? "127.0.0.1"),
    token: String(raw.server?.token ?? ""),
  };
  const defaults: Defaults = { ...DEFAULTS, ...(raw.defaults ?? {}) };
  const projects: Record<string, ProjectConfig> = {};
  for (const [name, p] of Object.entries<any>(raw.projects ?? {})) {
    projects[name] = {
      name,
      path: expandHome(String(p.path)),
      base_branch: String(p.base_branch ?? "main"),
      verify: (p.verify ?? "tests") as VerifyMode,
      speckit: Boolean(p.speckit ?? false),
      deny: Array.isArray(p.deny) ? p.deny.map(String) : [],
      concurrency: Number(p.concurrency ?? defaults.concurrency),
      machine: p.machine ? String(p.machine) : undefined,
      tickets: p.tickets ? String(p.tickets) : undefined,
      notes: p.notes ? String(p.notes) : undefined,
    };
  }
  return { server, defaults, projects };
}

export function denyListFor(cfg: ForemanConfig, project: ProjectConfig): string[] {
  return Array.from(new Set([...GLOBAL_DENY, ...cfg.defaults.deny, ...project.deny]));
}
