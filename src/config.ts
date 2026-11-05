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

// A set of resources that share a capacity: each step holding at least one
// member lease takes one slot (T0048 device lane).
export interface ResourceGroup { name: string; members: string[]; capacity: number }

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
  step_timeouts?: Record<string, number>; // per-step runner budget in minutes, over defaults.step_timeouts
  resource_groups: ResourceGroup[]; // device lanes; [] when none
  device_steps: string[];  // step names that may need devices; default ["implement","test"] with groups, else []
  device_steps_running: number; // max running device_steps; default max(capacity) + 1, or concurrency with no groups
}

export interface Defaults {
  orchestrator_model: string;
  subagent_model: string;
  consultant_model: string;
  max_turns: number;
  step_timeout_min: number;
  step_timeouts: Record<string, number>; // per-step budget in minutes, over step_timeout_min
  max_attempts: number;
  max_qa_cycles: number;
  max_plan_cycles: number;
  concurrency: number;
  heartbeat_sec: number;
  lease_sec: number;
  launch_grace_sec: number;    // a launch that has not returned by then is failed as never started
  launch_attempts_max: number; // consecutive never-started attempts before the task fails
  herdr_timeout_sec: number;   // per herdr CLI call
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
  step_timeouts: {},
  max_attempts: 3,
  max_qa_cycles: 3,
  max_plan_cycles: 2,
  concurrency: 3,
  heartbeat_sec: 30,
  lease_sec: 150,
  launch_grace_sec: 600,
  launch_attempts_max: 3,
  herdr_timeout_sec: 120,
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
# step_timeouts = { test = 150 }   # per-step budgets in minutes; a project's step_timeouts wins
max_attempts = 3
max_qa_cycles = 3
max_plan_cycles = 2   # plan QA reviews per round before the plan goes to the gate anyway
concurrency = 3
heartbeat_sec = 30
lease_sec = 150
launch_grace_sec = 600     # launch deadline; a step whose runner never started does not count against max_attempts
launch_attempts_max = 3    # ...but this many never-started attempts in a row fail the task
herdr_timeout_sec = 120    # per herdr CLI call
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
# step_timeouts = { implement = 120, test = 180 }   # minutes; over [defaults] step_timeouts and step_timeout_min
# resource_groups = { devices = { members = ["ios-sim", "android-emu"], capacity = 1 } }   # one device lane across both
# device_steps = ["implement", "test"]   # steps that may need devices (default with a group)
# device_steps_running = 2               # max running device steps (default: capacity + 1)
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
  defaults.step_timeouts = parseStepTimeouts(raw.defaults?.step_timeouts, "defaults");
  const projects: Record<string, ProjectConfig> = {};
  for (const [name, p] of Object.entries<any>(raw.projects ?? {})) {
    const concurrency = Number(p.concurrency ?? defaults.concurrency);
    const lane = parseLane(p, `projects.${name}`, Array.isArray(p.resources) ? p.resources.map(String) : [], concurrency);
    projects[name] = {
      name,
      path: expandHome(String(p.path)),
      base_branch: String(p.base_branch ?? "main"),
      verify: (p.verify ?? "tests") as VerifyMode,
      speckit: Boolean(p.speckit ?? false),
      deny: Array.isArray(p.deny) ? p.deny.map(String) : [],
      concurrency,
      merge: p.merge === "direct" ? "direct" : "pr",
      merge_gate: p.merge === "direct" ? Boolean(p.merge_gate ?? false) : true,
      squash: Boolean(p.squash ?? true),
      machine: p.machine ? String(p.machine) : undefined,
      tickets: p.tickets ? String(p.tickets) : undefined,
      ticket_team: p.ticket_team ? String(p.ticket_team) : undefined,
      ticket_states: typeof p.ticket_states === "object" && p.ticket_states ? p.ticket_states : {},
      notes: p.notes ? String(p.notes) : undefined,
      resources: lane.resources,
      lease_max_minutes: Number(p.lease_max_minutes ?? defaults.lease_max_minutes),
      step_timeouts: parseStepTimeouts(p.step_timeouts, `projects.${name}`),
      resource_groups: lane.resource_groups,
      device_steps: lane.device_steps,
      device_steps_running: lane.device_steps_running,
    };
  }
  const tickets = { linear: raw.tickets?.linear ? { api_key: raw.tickets.linear.api_key ? String(raw.tickets.linear.api_key) : undefined } : undefined };
  return { server, defaults, tickets, projects };
}

// A step_timeouts table (inline or sub-table): step name -> minutes. Keeps
// positive finite numbers; anything else is dropped with a warning.
export function parseStepTimeouts(raw: unknown, where: string): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw === undefined || raw === null) return out;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    console.warn(`config: ${where}.step_timeouts is not a table, ignored`);
    return out;
  }
  for (const [step, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[step] = v;
    else console.warn(`config: ${where}.step_timeouts.${step} = ${JSON.stringify(v)} is not a positive number, ignored`);
  }
  return out;
}

const posInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

// The device lane of one project table: resource_groups (inline or sub-table),
// device_steps and device_steps_running. Bad values are warned and replaced;
// group members missing from resources are appended to the returned resources.
export function parseLane(raw: any, where: string, resources: string[], concurrency: number):
  { resource_groups: ResourceGroup[]; device_steps: string[]; device_steps_running: number; resources: string[] } {
  const groups: ResourceGroup[] = [];
  const outResources = [...resources];
  const seen = new Set<string>();
  const rg = raw?.resource_groups;
  if (rg !== undefined && rg !== null && (typeof rg !== "object" || Array.isArray(rg))) console.warn(`config: ${where}.resource_groups is not a table, ignored`);
  else for (const [gname, g] of Object.entries<any>(rg ?? {})) {
    const members = g?.members;
    if (!Array.isArray(members) || !members.length || !members.every((m: unknown) => typeof m === "string")) {
      console.warn(`config: ${where}.resource_groups.${gname}.members must be a non-empty array of strings, group ignored`);
      continue;
    }
    let capacity = g.capacity;
    if (!posInt(capacity)) {
      console.warn(`config: ${where}.resource_groups.${gname}.capacity = ${JSON.stringify(capacity)} is not a positive integer, using 1`);
      capacity = 1;
    }
    const kept: string[] = [];
    for (const m of members as string[]) {
      if (seen.has(m)) { console.warn(`config: ${where}.resource_groups.${gname}: '${m}' is already in an earlier group, dropped here`); continue; }
      if (kept.includes(m)) continue;
      seen.add(m); kept.push(m);
      if (!outResources.includes(m)) {
        console.warn(`config: ${where}.resource_groups.${gname}: '${m}' is not in resources, added`);
        outResources.push(m);
      }
    }
    if (kept.length) groups.push({ name: gname, members: kept, capacity });
  }
  const defaultSteps = groups.length ? ["implement", "test"] : [];
  let device_steps = defaultSteps;
  if (raw?.device_steps !== undefined) {
    if (Array.isArray(raw.device_steps)) device_steps = raw.device_steps.map(String);
    else console.warn(`config: ${where}.device_steps is not an array, using ${JSON.stringify(defaultSteps)}`);
  }
  const defaultRunning = groups.length ? Math.max(...groups.map(g => g.capacity)) + 1 : concurrency;
  let device_steps_running = defaultRunning;
  if (raw?.device_steps_running !== undefined) {
    if (posInt(raw.device_steps_running)) device_steps_running = raw.device_steps_running;
    else console.warn(`config: ${where}.device_steps_running = ${JSON.stringify(raw.device_steps_running)} is not a positive integer, using ${defaultRunning}`);
  }
  return { resource_groups: groups, device_steps, device_steps_running, resources: outResources };
}

// Runner budget for one step: project map, then defaults map, then the global.
export function stepTimeoutMin(defaults: Defaults, project: ProjectConfig | undefined, step: string): number {
  return project?.step_timeouts?.[step] ?? defaults.step_timeouts?.[step] ?? defaults.step_timeout_min;
}

export function denyListFor(cfg: ForemanConfig, project: ProjectConfig): string[] {
  return Array.from(new Set([...GLOBAL_DENY, ...cfg.defaults.deny, ...project.deny]));
}

// Devices a project's workers take turns on: declared resources, plus the
// implicit browser of a verify = "browser" project.
export function deviceResources(p: ProjectConfig): string[] {
  return Array.from(new Set([...p.resources, ...(p.verify === "browser" ? ["browser"] : [])]));
}
