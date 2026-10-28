// Resource leases: exclusive, first-come-first-served holds on shared devices
// (the iOS simulator, the Android emulator, a browser profile) so workers of a
// project take turns on them. Not the heartbeat lease (steps.lease_until).
//
// Key = (project, machine, resource). One row per (key, step) in
// resource_leases: the holder has granted_at set, waiters are served in id
// order. Invariant restored by reconcileLeases on every tick: rows exist only
// while their step is running and their task is not finished; each key has at
// most one holder; a free key with waiters is granted to the oldest waiter.
//
// No import of taskd.ts or loadConfig(), so bun test drives it with a Store.
import type { LeaseRow, Store, StepRow, TaskRow } from "./db";

export const machineOf = (step: Pick<StepRow, "machine">) => step.machine ?? "local";

export interface LeaseHolder { task_id: string; step: string; attempt: number; since: string; reason: string | null }

export interface LeaseState {
  resource: string;
  machine: string;
  granted: boolean;
  position: number;      // 0 when held, 1-based among waiters otherwise
  queue: number;         // number of waiters
  holder: LeaseHolder | null;
  warning?: string;
}

const secondsSince = (iso: string) => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));

function holderOf(store: Store, rows: LeaseRow[]): LeaseHolder | null {
  const h = rows.find(r => r.granted_at);
  if (!h) return null;
  const s = store.getStep(h.step_id);
  return { task_id: h.task_id, step: s?.name ?? "?", attempt: s?.attempt ?? 0, since: h.granted_at!, reason: h.reason };
}

function stateFor(store: Store, project: string, machine: string, resource: string, step_id: number): LeaseState {
  const rows = store.leasesForKey(project, machine, resource);
  const waiters = rows.filter(r => !r.granted_at);
  const mine = rows.find(r => r.step_id === step_id);
  const granted = Boolean(mine?.granted_at);
  return {
    resource, machine, granted,
    position: granted || !mine ? 0 : waiters.findIndex(r => r.id === mine.id) + 1,
    queue: waiters.length,
    holder: holderOf(store, rows),
  };
}

// Grant the oldest waiter when the key has no holder.
function grantNext(store: Store, project: string, machine: string, resource: string): void {
  const rows = store.leasesForKey(project, machine, resource);
  if (rows.some(r => r.granted_at)) return;
  const next = rows[0];
  if (!next) return;
  store.grantLease(next.id);
  store.event("lease.granted", { resource, machine, waited_sec: secondsSince(next.requested_at) }, next.task_id, next.step_id);
}

function dropRow(store: Store, row: LeaseRow, why: string): number | null {
  const held_sec = row.granted_at ? secondsSince(row.granted_at) : null;
  store.deleteLease(row.id);
  store.event("lease.released", { resource: row.resource, machine: row.machine, held_sec, why }, row.task_id, row.step_id);
  return held_sec;
}

export function requestLease(store: Store, task: TaskRow, step: StepRow, resource: string, reason: string | null, declared: string[]): LeaseState {
  const machine = machineOf(step);
  const undeclared = declared.length > 0 && !declared.includes(resource);
  const warning = undeclared ? `'${resource}' is not in project ${task.project}'s resources (${declared.join(", ")}); typo?` : undefined;
  const state = store.db.transaction(() => {
    if (!store.getLease(step.id, task.project, machine, resource)) {
      store.insertLease({ project: task.project, machine, resource, task_id: task.id, step_id: step.id, reason });
      const rows = store.leasesForKey(task.project, machine, resource);
      const position = rows.some(r => r.granted_at) ? rows.filter(r => !r.granted_at).length : 0;
      store.event("lease.requested", { resource, machine, reason, position, ...(undeclared ? { undeclared: true } : {}) }, task.id, step.id);
      grantNext(store, task.project, machine, resource);
    }
    return stateFor(store, task.project, machine, resource, step.id);
  })();
  return warning ? { ...state, warning } : state;
}

export function releaseLease(store: Store, step: StepRow, resource: string, why = "released"): { released: boolean; held_sec: number | null } {
  return store.db.transaction(() => {
    const task = store.getTask(step.task_id);
    const row = task ? store.getLease(step.id, task.project, machineOf(step), resource) : null;
    if (!row) return { released: false, held_sec: null };
    const held_sec = dropRow(store, row, why);
    grantNext(store, row.project, row.machine, row.resource);
    return { released: true, held_sec };
  })();
}

// Release every lease (held or queued) of a step; returns how many rows went.
export function releaseStepLeases(store: Store, step_id: number, why: string): number {
  return store.db.transaction(() => {
    const rows = store.leasesForStep(step_id);
    for (const r of rows) dropRow(store, r, why);
    for (const r of rows) grantNext(store, r.project, r.machine, r.resource);
    return rows.length;
  })();
}

// Tick-time safety net: sweep rows of steps that stopped running (restarts,
// missed paths), grant free keys, flag holds older than maxMinutes(project).
// A task that is blocked may still have a running sibling (parallel QA), so
// only step status and finished task states count as dead.
export function reconcileLeases(store: Store, maxMinutes: (project: string) => number): void {
  store.db.transaction(() => {
    for (const r of store.listLeases()) {
      const step = store.getStep(r.step_id);
      const task = store.getTask(r.task_id);
      if (!step || step.status !== "running" || !task || ["done", "failed", "cancelled"].includes(task.status)) dropRow(store, r, "swept");
    }
    const rows = store.listLeases();
    const keys = new Map(rows.map(r => [`${r.project}\0${r.machine}\0${r.resource}`, r]));
    for (const r of keys.values()) grantNext(store, r.project, r.machine, r.resource);
    for (const r of store.listLeases()) {
      if (!r.granted_at || r.overdue_at) continue;
      const max = maxMinutes(r.project) ?? 45;
      const held_min = Math.floor(secondsSince(r.granted_at) / 60);
      if (held_min < max) continue;
      store.markLeaseOverdue(r.id);
      store.event("lease.overdue", { resource: r.resource, machine: r.machine, held_min, max_min: max }, r.task_id, r.step_id);
    }
  })();
}

// A row as the API, CLI and dashboard show it.
export function leaseView(store: Store, row: LeaseRow) {
  const step = store.getStep(row.step_id);
  const rows = store.leasesForKey(row.project, row.machine, row.resource);
  const waiters = rows.filter(r => !r.granted_at);
  const held = Boolean(row.granted_at);
  return {
    ...row,
    step: step?.name ?? "?",
    attempt: step?.attempt ?? 0,
    state: held ? "held" as const : "waiting" as const,
    position: held ? 0 : waiters.findIndex(r => r.id === row.id) + 1,
    held_sec: held ? secondsSince(row.granted_at!) : null,
    waited_sec: held ? null : secondsSince(row.requested_at),
    overdue: Boolean(row.overdue_at),
    holder: held ? null : holderOf(store, rows),
  };
}

// The worker-prompt paragraph for steps that may touch a device.
export function devicePrompt(resources: string[], role: string): string {
  if (!resources.length || !["developer", "test-analyst"].includes(role)) return "";
  const list = resources.map(r => "`" + r + "`").join(", ");
  const first = resources[0];
  return `## Shared devices
This project's devices are shared with other Foreman workers: ${list}. Before you boot, build for, install on, or run flows against one of them, take its lease: \`task lease ${first} --wait 540 --reason "<what for>"\`, run with a Bash timeout of 600000 ms. Waiting is normal, not a failure: the command prints who holds the device and your place in the queue every 30 s. If it exits with code 3 you are still queued; run it again to keep your place. Keep running jest, tsc, lint and other device-free checks without a lease. Run \`task release ${first}\` as soon as the device phase is over (leases are also released when your step ends). If you need several devices, take them in alphabetical order. Never kill, shut down, erase or reinstall over another process's simulator, emulator, browser or Maestro run; if a device looks stuck, record it with \`task note\` and wait.`;
}
