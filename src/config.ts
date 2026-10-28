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
  merge: "pr" | "direct";  // pr: push branch, open PR, gate, squash merge; direct: merge onto base and push without a PR
  merge_gate: boolean;     // direct mode only: wait for `task approve` before merging (pr mode always gates)
  squash: boolean;         // direct mode: squash into one commit (default) or merge --no-ff keeping the branch's commits
  machine?: string;        // herdr saved machine label (slice 5)
  tickets?: string;        // ticket provider: linear (more later)
  ticket_team?: string;    // provider team key for creating tickets, e.g. TAC
  ticket_states: { start?: string; review?: string; done?: string }; // state names to transition to on task start / PR opened / merged
  notes?: string;          // free text injected into every worker prompt
  resources: string[];     // shared devices workers take turns on (task lease), e.g. ios-sim, android-emu
  lease_max_minutes: number; // a resource lease held longer than this is logged as overdue (not released)
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
  lease_max_minutes: number;
}

export interface ForemanConfig {
  server: { port: number; bind: string; token: string };
  defaults: Defaults;
  tickets: { linear?: { api_key?: string } };
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
  lease_max_minutes: 45,
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
lease_max_minutes = 45   # resource lease (task lease) held longer than this is flagged overdue
# Extra tool patterns denied for every project, on top of the built-in list
# (push, merge, deploy, destructive git, sudo).
deny = []

# Ticket providers. Credentials live only here; workers go through "task ticket".
# [tickets.linear]
# api_key = "lin_api_..."   # or set LINEAR_API_KEY in taskd's environment

# One table per project. Only listed projects can receive tasks.
# [projects.dicer]
# path = "~/git/dicer"
# base_branch = "main"
# verify = "browser"     # tests | browser | inspect
# speckit = true
# merge = "pr"           # pr (default): PR + merge gate; direct: merge onto base and push, no PR
# merge_gate = true      # direct mode: still wait for your approval before merging (default false)
# squash = true          # direct mode: one squash commit (default) or false for merge --no-ff
# concurrency = 2
# deny = ["Bash(supabase *)"]
# tickets = "linear"
# ticket_team = "DIC"    # team key used when workers create tickets
# ticket_states = { start = "In Progress", review = "In Review", done = "Done" }  # optional transitions
# resources = ["ios-sim", "android-emu"]   # devices workers take turns on (task lease)
# lease_max_minutes = 45
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
      merge: p.merge === "direct" ? "direct" : "pr",
      merge_gate: p.merge === "direct" ? Boolean(p.merge_gate ?? false) : true,
      squash: Boolean(p.squash ?? true),
      machine: p.machine ? String(p.machine) : undefined,
      tickets: p.tickets ? String(p.tickets) : undefined,
      ticket_team: p.ticket_team ? String(p.ticket_team) : undefined,
      ticket_states: typeof p.ticket_states === "object" && p.ticket_states ? p.ticket_states : {},
      notes: p.notes ? String(p.notes) : undefined,
      resources: Array.isArray(p.resources) ? p.resources.map(String) : [],
      lease_max_minutes: Number(p.lease_max_minutes ?? defaults.lease_max_minutes),
    };
  }
  const tickets = { linear: raw.tickets?.linear ? { api_key: raw.tickets.linear.api_key ? String(raw.tickets.linear.api_key) : undefined } : undefined };
  return { server, defaults, tickets, projects };
}

export function denyListFor(cfg: ForemanConfig, project: ProjectConfig): string[] {
  return Array.from(new Set([...GLOBAL_DENY, ...cfg.defaults.deny, ...project.deny]));
}

// Devices a project's workers take turns on: declared resources, plus the
// implicit browser of a verify = "browser" project.
export function deviceResources(p: ProjectConfig): string[] {
  return Array.from(new Set([...p.resources, ...(p.verify === "browser" ? ["browser"] : [])]));
}
