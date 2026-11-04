// Device lane policies (T0048): who gets a device next, and whether a queued
// step may launch. Pure functions only: no store, no config, no taskd, so the
// policies are deterministic and tested on their own (test/lane.test.ts).
// leases.ts and taskd.ts feed them rows and act on the answer.

export interface Waiter {
  id: number;            // lease row id (request order)
  task_id: string;
  step_id: number;
  step: string;          // step name
  qa_cycles: number;
  requested_at: string;
  expect_min: number | null;
}

// Grant and dispatch class order: a test gates a merge and runs the full
// matrix, an implement's touched-flow check can wait. Others rank after.
export const STEP_CLASS_ORDER = ["test", "implement"];

export function stepClassRank(step: string): number {
  const i = STEP_CLASS_ORDER.indexOf(step);
  return i < 0 ? STEP_CLASS_ORDER.length : i;
}

const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

// Grant order. Tasks are ranked by their head (oldest) waiter: step class,
// then higher qa_cycles, then older request, then row id. Within a task,
// waiters keep request (id) order. Ranking tasks rather than rows keeps the
// order total. Returns a new array; the input is not mutated.
export function orderWaiters(ws: Waiter[]): Waiter[] {
  const byTask = new Map<string, Waiter[]>();
  for (const w of [...ws].sort((a, b) => a.id - b.id)) {
    const list = byTask.get(w.task_id);
    if (list) list.push(w); else byTask.set(w.task_id, [w]);
  }
  const heads = [...byTask.values()].sort((x, y) => {
    const a = x[0]!, b = y[0]!;
    return stepClassRank(a.step) - stepClassRank(b.step)
      || b.qa_cycles - a.qa_cycles
      || cmp(a.requested_at, b.requested_at)
      || a.id - b.id;
  });
  return heads.flat();
}

// Minutes until each ordered waiter is expected to start. holdersRemaining:
// expected minutes left per holding step, max(0, (expect ?? fallback) - held).
// `capacity` slots start at the holders' remaining times (padded with 0); each
// waiter takes the earliest slot, which then advances by its own expected hold.
export function laneEta(capacity: number, holdersRemaining: number[], ordered: { expect_min: number | null }[], fallbackMin: number): number[] {
  const slots = holdersRemaining.map(h => Math.max(0, h));
  while (slots.length < capacity) slots.push(0);
  if (!slots.length) slots.push(0);
  return ordered.map(w => {
    let i = 0;
    for (let j = 1; j < slots.length; j++) if (slots[j]! < slots[i]!) i = j;
    const eta = slots[i]!;
    slots[i] = eta + (w.expect_min ?? fallbackMin);
    return Math.round(eta);
  });
}

export interface DispatchCandidate { step_id: number; task_id: string; name: string; priority: number; qa_cycles: number; created_at: string }

export interface DispatchView {
  freeSlots: number;                // min(global free, project free); > 0 when called
  deviceSteps: string[];
  deviceRunning: number;            // running steps of the project whose name is in deviceSteps
  deviceLimit: number;              // device_steps_running
  laneBusy: boolean;                // some group at capacity with >= 1 waiter
  queued: DispatchCandidate[];      // live queued steps of the project, including the candidate
}

export type HoldReason = "device_limit" | "lane_busy" | "ranked_behind";
export type Verdict = { launch: true } | { launch: false; reason: HoldReason };

// Device-step rank at dispatch: task priority first, then the grant ranking.
export function dispatchCompare(a: DispatchCandidate, b: DispatchCandidate): number {
  return a.priority - b.priority
    || stepClassRank(a.name) - stepClassRank(b.name)
    || b.qa_cycles - a.qa_cycles
    || cmp(a.created_at, b.created_at)
    || a.step_id - b.step_id;
}

// May this queued step launch now? Rules in order (plan §2):
// 1. not a device step: launch (device-free work is never held by the lane);
// 2. device_steps_running reached: hold;
// 3. lane full with waiters and the free slots are needed by queued
//    device-free steps: hold;
// 4. better-ranked queued device steps would take the remaining device room: hold;
// 5. launch.
export function dispatchVerdict(c: DispatchCandidate, v: DispatchView): Verdict {
  const isDevice = (name: string) => v.deviceSteps.includes(name);
  if (!isDevice(c.name)) return { launch: true };
  if (v.deviceRunning >= v.deviceLimit) return { launch: false, reason: "device_limit" };
  const others = v.queued.filter(q => q.step_id !== c.step_id);
  if (v.laneBusy && v.freeSlots <= others.filter(q => !isDevice(q.name)).length) return { launch: false, reason: "lane_busy" };
  const room = v.deviceLimit - v.deviceRunning;
  const better = others.filter(q => isDevice(q.name) && dispatchCompare(q, c) < 0);
  if (better.length >= room) return { launch: false, reason: "ranked_behind" };
  return { launch: true };
}
