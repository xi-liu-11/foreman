// Resource leases: exclusive holds on shared devices (the iOS simulator, the
// Android emulator, a browser profile) so workers of a project take turns on
// them. Not the heartbeat lease (steps.lease_until).
//
// Key = (project, machine, resource). One row per (key, step) in
// resource_leases: the holder has granted_at set, the others wait. Keys are
// grouped (T0048 device lane): a configured resource group has a capacity, and
// each step holding at least one member takes one slot; a resource in no group
// is an implicit group of one with capacity 1. Waiters are granted in the order
// of lane.ts orderWaiters (test before implement, higher QA cycle, older
// request; FIFO within a task). Invariant restored by reconcileLeases on every
// tick: rows exist only while their step is running and their task is not
// finished; each key has at most one holder; each group has at most `capacity`
// holding steps; free room is granted greedily in that order.
//
// No import of taskd.ts or loadConfig(), so bun test drives it with a Store.
import { CLOSED_STATUSES, type LeaseRow, type LeaseWaiterRow, type Store, type StepRow, type TaskRow } from "./db";
import type { ProjectConfig, ResourceGroup } from "./config";
import { orderWaiters, laneEta, type DispatchView, type Waiter } from "./lane";

export const machineOf = (step: Pick<StepRow, "machine">) => step.machine ?? "local";

export type GroupsOf = (project: string) => ResourceGroup[];
export const NO_GROUPS: GroupsOf = () => [];
const DEFAULT_FALLBACK_MIN = 45;

// The configured group of a resource, or its implicit group of one.
export function groupFor(groupsOf: GroupsOf, project: string, resource: string): ResourceGroup & { implicit: boolean } {
  const g = groupsOf(project).find(g => g.members.includes(resource));
  return g ? { ...g, implicit: false } : { name: resource, members: [resource], capacity: 1, implicit: true };
}

export interface LeaseHolder { task_id: string; step: string; attempt: number; since: string; reason: string | null }

export interface LeaseState {
  resource: string;
  machine: string;
  granted: boolean;
  position: number;      // 0 when held, 1-based among the group's waiters in grant order otherwise
  queue: number;         // number of waiters in the group
  holder: LeaseHolder | null; // the key's holder, else (waiting on a full lane) the lane's first holder
  group: string | null;  // configured group name, null for an ungrouped resource
  expect_min: number | null;
  eta_min: number | null;        // waiters: expected minutes until granted
  expect_left_min: number | null; // holders: expected minutes left
  warning?: string;
}

const secondsSince = (iso: string) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
const minutesSince = (iso: string) => secondsSince(iso) / 60;

function holderOf(store: Store, rows: LeaseRow[]): LeaseHolder | null {
  const h = rows.find(r => r.granted_at);
  if (!h) return null;
  const s = store.getStep(h.step_id);
  return { task_id: h.task_id, step: s?.name ?? "?", attempt: s?.attempt ?? 0, since: h.granted_at!, reason: h.reason };
}

const toWaiter = (r: LeaseWaiterRow): Waiter =>
  ({ id: r.id, task_id: r.task_id, step_id: r.step_id, step: r.step, qa_cycles: r.qa_cycles, requested_at: r.requested_at, expect_min: r.expect_min });

// Everything about one group on one machine that grants and views need.
function groupState(store: Store, project: string, machine: string, g: ResourceGroup, fallbackMin = DEFAULT_FALLBACK_MIN) {
  const rows = store.leaseWaitersInfo(project, machine, g.members);
  const granted = rows.filter(r => r.granted_at);
  const order = orderWaiters(rows.filter(r => !r.granted_at).map(toWaiter));
  const byId = new Map(rows.map(r => [r.id, r]));
  const waiters = order.map(w => byId.get(w.id)!);
  // One entry per holding step: earliest grant, longest expect.
  const holders = new Map<number, { rows: LeaseWaiterRow[]; since: string; expect_min: number | null }>();
  for (const r of granted) {
    const h = holders.get(r.step_id);
    if (!h) holders.set(r.step_id, { rows: [r], since: r.granted_at!, expect_min: r.expect_min });
    else {
      h.rows.push(r);
      if (r.granted_at! < h.since) h.since = r.granted_at!;
      if (r.expect_min != null && (h.expect_min == null || r.expect_min > h.expect_min)) h.expect_min = r.expect_min;
    }
  }
  const remaining = (h: { since: string; expect_min: number | null }) => (h.expect_min ?? fallbackMin) - minutesSince(h.since);
  const etas = laneEta(g.capacity, [...holders.values()].map(remaining), waiters, fallbackMin);
  return { rows, granted, waiters, holders, etas, remaining };
}

// Waiters to grant now: walk the grant order, grant each whose key is free and
// whose step already holds a slot of the group or finds a free one.
function plannedGrants(store: Store, project: string, machine: string, g: ResourceGroup): LeaseWaiterRow[] {
  const { granted, waiters } = groupState(store, project, machine, g);
  const slots = new Set(granted.map(r => r.step_id));
  const heldKeys = new Set(granted.map(r => r.resource));
  const out: LeaseWaiterRow[] = [];
  for (const w of waiters) {
    if (heldKeys.has(w.resource)) continue;
    if (!slots.has(w.step_id) && slots.size >= g.capacity) continue;
    slots.add(w.step_id); heldKeys.add(w.resource); out.push(w);
  }
  return out;
}

function grantNext(store: Store, project: string, machine: string, resource: string, groupsOf: GroupsOf): void {
  const g = groupFor(groupsOf, project, resource);
  for (const r of plannedGrants(store, project, machine, g)) {
    store.grantLease(r.id);
    store.event("lease.granted", { resource: r.resource, machine, waited_sec: secondsSince(r.requested_at), ...(g.implicit ? {} : { group: g.name }) }, r.task_id, r.step_id);
  }
}

function stateFor(store: Store, project: string, machine: string, resource: string, step_id: number, groupsOf: GroupsOf, fallbackMin: number): LeaseState {
  const g = groupFor(groupsOf, project, resource);
  const gs = groupState(store, project, machine, g, fallbackMin);
  const keyRows = gs.rows.filter(r => r.resource === resource);
  const mine = keyRows.find(r => r.step_id === step_id);
  const granted = Boolean(mine?.granted_at);
  const idx = mine && !granted ? gs.waiters.findIndex(r => r.id === mine.id) : -1;
  const h = gs.holders.get(step_id);
  return {
    resource, machine, granted,
    position: idx + 1,
    queue: gs.waiters.length,
    holder: holderOf(store, keyRows) ?? holderOf(store, gs.granted),
    group: g.implicit ? null : g.name,
    expect_min: mine?.expect_min ?? null,
    eta_min: idx >= 0 ? gs.etas[idx]! : null,
    expect_left_min: granted && h ? Math.max(0, Math.round(gs.remaining(h))) : null,
  };
}

function dropRow(store: Store, row: LeaseRow, why: string): number | null {
  const held_sec = row.granted_at ? secondsSince(row.granted_at) : null;
  store.deleteLease(row.id);
  store.event("lease.released", { resource: row.resource, machine: row.machine, held_sec, why }, row.task_id, row.step_id);
  return held_sec;
}

export interface LeaseOpts { expect_min?: number | null; groupsOf?: GroupsOf; fallbackMin?: number }

export function requestLease(store: Store, task: TaskRow, step: StepRow, resource: string, reason: string | null, declared: string[], opts: LeaseOpts = {}): LeaseState {
  const machine = machineOf(step);
  const groupsOf = opts.groupsOf ?? NO_GROUPS;
  const expect_min = opts.expect_min ?? null;
  const undeclared = declared.length > 0 && !declared.includes(resource);
  const warning = undeclared ? `'${resource}' is not in project ${task.project}'s resources (${declared.join(", ")}); typo?` : undefined;
  const state = store.db.transaction(() => {
    const existing = store.getLease(step.id, task.project, machine, resource);
    if (!existing) {
      const row = store.insertLease({ project: task.project, machine, resource, task_id: task.id, step_id: step.id, reason, expect_min });
      const g = groupFor(groupsOf, task.project, resource);
      const grantedNow = plannedGrants(store, task.project, machine, g).some(r => r.id === row.id);
      const position = grantedNow ? 0 : groupState(store, task.project, machine, g).waiters.findIndex(r => r.id === row.id) + 1;
      store.event("lease.requested", { resource, machine, reason, position, ...(expect_min != null ? { expect_min } : {}), ...(g.implicit ? {} : { group: g.name }), ...(undeclared ? { undeclared: true } : {}) }, task.id, step.id);
      grantNext(store, task.project, machine, resource, groupsOf);
    } else if (expect_min != null && existing.expect_min !== expect_min) {
      store.setLeaseExpect(existing.id, expect_min);
    }
    return stateFor(store, task.project, machine, resource, step.id, groupsOf, opts.fallbackMin ?? DEFAULT_FALLBACK_MIN);
  })();
  return warning ? { ...state, warning } : state;
}

export function releaseLease(store: Store, step: StepRow, resource: string, why = "released", groupsOf: GroupsOf = NO_GROUPS): { released: boolean; held_sec: number | null } {
  return store.db.transaction(() => {
    const task = store.getTask(step.task_id);
    const row = task ? store.getLease(step.id, task.project, machineOf(step), resource) : null;
    if (!row) return { released: false, held_sec: null };
    const held_sec = dropRow(store, row, why);
    grantNext(store, row.project, row.machine, row.resource, groupsOf);
    return { released: true, held_sec };
  })();
}

// Release every lease (held or queued) of a step; returns how many rows went.
export function releaseStepLeases(store: Store, step_id: number, why: string, groupsOf: GroupsOf = NO_GROUPS): number {
  return store.db.transaction(() => {
    const rows = store.leasesForStep(step_id);
    for (const r of rows) dropRow(store, r, why);
    for (const r of rows) grantNext(store, r.project, r.machine, r.resource, groupsOf);
    return rows.length;
  })();
}

// Tick-time safety net: sweep rows of steps that stopped running (restarts,
// missed paths), grant free room, flag holds older than their expected hold
// (task lease --expect), else maxMinutes(project).
// A task that is blocked may still have a running sibling (parallel QA), so
// only step status and finished task states count as dead.
export function reconcileLeases(store: Store, maxMinutes: (project: string) => number, groupsOf: GroupsOf = NO_GROUPS): void {
  store.db.transaction(() => {
    for (const r of store.listLeases()) {
      const step = store.getStep(r.step_id);
      const task = store.getTask(r.task_id);
      if (!step || step.status !== "running" || !task || CLOSED_STATUSES.includes(task.status)) dropRow(store, r, "swept");
    }
    const rows = store.listLeases();
    const keys = new Map(rows.map(r => [`${r.project}\0${r.machine}\0${r.resource}`, r]));
    for (const r of keys.values()) grantNext(store, r.project, r.machine, r.resource, groupsOf);
    for (const r of store.listLeases()) {
      if (!r.granted_at || r.overdue_at) continue;
      const max = r.expect_min ?? maxMinutes(r.project) ?? DEFAULT_FALLBACK_MIN;
      const held_min = Math.floor(secondsSince(r.granted_at) / 60);
      if (held_min < max) continue;
      store.markLeaseOverdue(r.id);
      store.event("lease.overdue", { resource: r.resource, machine: r.machine, held_min, max_min: max, expected: r.expect_min != null }, r.task_id, r.step_id);
    }
  })();
}

// A row as the API, CLI and dashboard show it.
export function leaseView(store: Store, row: LeaseRow, groupsOf: GroupsOf = NO_GROUPS, fallbackMin = DEFAULT_FALLBACK_MIN) {
  const step = store.getStep(row.step_id);
  const g = groupFor(groupsOf, row.project, row.resource);
  const gs = groupState(store, row.project, row.machine, g, fallbackMin);
  const keyRows = gs.rows.filter(r => r.resource === row.resource);
  const held = Boolean(row.granted_at);
  const idx = held ? -1 : gs.waiters.findIndex(r => r.id === row.id);
  const h = gs.holders.get(row.step_id);
  return {
    ...row,
    step: step?.name ?? "?",
    attempt: step?.attempt ?? 0,
    state: held ? "held" as const : "waiting" as const,
    position: idx + 1,
    held_sec: held ? secondsSince(row.granted_at!) : null,
    waited_sec: held ? null : secondsSince(row.requested_at),
    overdue: Boolean(row.overdue_at),
    holder: held ? null : holderOf(store, keyRows) ?? holderOf(store, gs.granted),
    group: g.implicit ? null : g.name,
    eta_min: idx >= 0 ? gs.etas[idx]! : null,
    expect_left_min: held && h ? Math.max(0, Math.round(gs.remaining(h))) : null,
  };
}

// Each configured group per machine (local when it has no rows): capacity,
// holding steps and waiters in grant order with ETAs. For task leases, /lanes
// and the dashboard.
export function laneViews(store: Store, groupsOf: GroupsOf, projects: string[], fallbackMin: (project: string) => number = () => DEFAULT_FALLBACK_MIN) {
  return projects.flatMap(project => groupsOf(project).flatMap(g => {
    const machines = [...new Set(store.listLeases({ project }).filter(r => g.members.includes(r.resource)).map(r => r.machine))];
    return (machines.length ? machines.sort() : ["local"]).map(machine => {
      const fb = fallbackMin(project) ?? DEFAULT_FALLBACK_MIN;
      const gs = groupState(store, project, machine, g, fb);
      const holders = [...gs.holders.entries()].map(([step_id, h]) => {
        const s = store.getStep(step_id);
        return {
          task_id: h.rows[0]!.task_id, step: s?.name ?? "?", attempt: s?.attempt ?? 0,
          resources: h.rows.map(r => r.resource), since: h.since, held_min: Math.floor(minutesSince(h.since)),
          expect_min: h.expect_min, expect_left_min: Math.max(0, Math.round(gs.remaining(h))),
          overdue: h.rows.some(r => r.overdue_at),
        };
      });
      const waiters = gs.waiters.map((r, i) => ({
        task_id: r.task_id, step: r.step, attempt: store.getStep(r.step_id)?.attempt ?? 0, resource: r.resource,
        position: i + 1, waited_min: Math.floor(minutesSince(r.requested_at)), expect_min: r.expect_min, eta_min: gs.etas[i]!,
      }));
      return { project, machine, group: g.name, capacity: g.capacity, members: g.members, holders, waiters };
    });
  }));
}

// Where a task's first waiting lease row stands in its lane, for task ls.
export function laneStatusForTask(store: Store, task_id: string, groupsOf: GroupsOf = NO_GROUPS): { position: number; of: number } | null {
  const row = store.leasesForTask(task_id).find(r => !r.granted_at);
  if (!row) return null;
  const gs = groupState(store, row.project, row.machine, groupFor(groupsOf, row.project, row.resource));
  const idx = gs.waiters.findIndex(r => r.id === row.id);
  return idx < 0 ? null : { position: idx + 1, of: gs.waiters.length };
}

// The store facts dispatchVerdict needs for one project.
export function dispatchView(store: Store, project: string, proj: Pick<ProjectConfig, "device_steps" | "device_steps_running" | "resource_groups">, freeSlots: number): DispatchView {
  const deviceRunning = store.runningStepsOf(project).filter(s => proj.device_steps.includes(s.name)).length;
  const rows = store.listLeases({ project });
  const laneBusy = proj.resource_groups.some(g => {
    const mine = rows.filter(r => g.members.includes(r.resource));
    return [...new Set(mine.map(r => r.machine))].some(m => {
      const onM = mine.filter(r => r.machine === m);
      return new Set(onM.filter(r => r.granted_at).map(r => r.step_id)).size >= g.capacity && onM.some(r => !r.granted_at);
    });
  });
  const queued = store.queuedLiveSteps(project).map(s => ({ step_id: s.id, task_id: s.task_id, name: s.name, priority: s.priority, qa_cycles: s.qa_cycles, created_at: s.created_at }));
  return { freeSlots, deviceSteps: proj.device_steps, deviceRunning, deviceLimit: proj.device_steps_running, laneBusy, queued };
}

const andList = (xs: string[]) => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;

// The worker-prompt paragraph for steps that may touch a device.
export function devicePrompt(resources: string[], role: string, groups: ResourceGroup[] = []): string {
  if (!resources.length || !["developer", "test-analyst"].includes(role)) return "";
  const tick = (r: string) => "`" + r + "`";
  const list = resources.map(tick).join(", ");
  const first = resources[0];
  const lanes = groups.map(g => ` ${andList(g.members.map(tick))} form one device lane with capacity ${g.capacity}: while ${g.capacity === 1 ? "any worker holds one of them" : `${g.capacity} workers hold them`}, other workers wait, so hold the lane as briefly as you can.`).join("");
  return `## Shared devices
This project's devices are shared with other Foreman workers: ${list}.${lanes} Do device work in one phase. First finish everything that needs no device: jest, tsc, lint, builds that do not install. Then take the lease once: \`task lease ${first} --wait 540 --expect <minutes> --reason "<what for>"\`, run with a Bash timeout of 600000 ms. \`--expect\` is your honest estimate of the whole device phase (typical holds are 20–30 min). Waiters see it as an ETA, and the hold is flagged overdue after it. If you need more time, run the same command again with a new \`--expect\`. Waiting is normal, not a failure: the command prints who holds the device, your place in the queue and an ETA every 30 s. If it exits with code 3 you are still queued; run it again to keep your place. If you need several devices, take them in alphabetical order. Taking a second device of the same lane does not cost another slot. If you booted a simulator or emulator instance yourself, shut it down before you release. Run \`task release <name>\` for each device as soon as the device phase is over (leases are also released when your step ends). Never kill, shut down, erase or reinstall over another process's simulator, emulator, browser or Maestro run; if a device looks stuck, record it with \`task note\` and wait.`;
}
