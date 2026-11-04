# Plan: device lane — resource groups, step classes, scheduler-ordered grants

See `spec.md` for the goal, the evidence, and the acceptance scenarios (AS-n).

## Approach

The policies are pure functions in a new module, `src/lane.ts`, which has no
store and no config import. `src/leases.ts` keeps all store access and calls
those functions. `src/taskd.ts` gets one extra check in `tryLaunch` and a few
wiring changes. Config parsing goes in `src/config.ts`, next to
`parseStepTimeouts`, following the T0045 conventions.

### 1. Config (`src/config.ts`)

```ts
export interface ResourceGroup { name: string; members: string[]; capacity: number }
// ProjectConfig additions (all always set by loadConfig):
resource_groups: ResourceGroup[];   // [] when none
device_steps: string[];             // default ["implement","test"] if groups, else []
device_steps_running: number;       // default max(capacity) + 1; the project's concurrency when no groups (JSON-safe, never Infinity)
```

`export function parseLane(raw: any, where: string, resources: string[], concurrency: number)`
returns `{ resource_groups, device_steps, device_steps_running, resources }`.

`raw.resource_groups` is a TOML table of tables. Both forms are accepted:
inline `{ devices = { members = [...], capacity = 1 } }` and the sub-table
`[projects.x.resource_groups.devices]`. The rules:

- Group order is TOML key order.
- If `capacity` is not a positive integer, warn and use 1.
- If `members` is empty or not an array of strings, warn and drop the group.
- A member that is already in an earlier group: warn, and drop it from this
  group.
- A member missing from `resources`: warn, and append it to the returned
  `resources`. That way `deviceResources()`, the lease warning, and the
  prompts all see it.
- `device_steps`: an array of strings. A non-array is warned and the default
  is used.
- `device_steps_running`: a positive integer. If it is invalid, warn and use
  the default.

Add commented example lines to `defaultConfigToml()` under `[projects.dicer]`.

**Why not one global number?** The brief's alternative, "concurrency 1",
wastes the device-free lanes. The opposite, "concurrency N, devices FIFO",
gives N device workers and the host swaps. A group capacity bounds the
scarce thing, which is memory used by booted devices. `device_steps_running`
bounds the waiting: a step that waits for the lane still holds a concurrency
slot and burns its timeout. The default of capacity + 1 keeps exactly one
step coding while it waits, ready to take the lane.

### 2. Pure policies (`src/lane.ts`, new)

```ts
export interface Waiter { id: number; task_id: string; step_id: number; step: string; qa_cycles: number; requested_at: string; expect_min: number | null }
export const STEP_CLASS_ORDER = ["test", "implement"];        // others rank after
export function stepClassRank(step: string): number;
// Rank tasks by their head (oldest) waiter: class, then -qa_cycles, then requested_at, then id.
// Within a task: id order (FIFO). Returns a new array; input is not mutated.
export function orderWaiters(ws: Waiter[]): Waiter[];

// ETA in minutes until each ordered waiter is expected to start.
// holders: remaining expected minutes per holding step = max(0, (expect ?? fallback) - held).
// Simulate `capacity` slots (holders' remaining, padded with 0); each waiter
// takes the earliest slot, which then advances by (its expect ?? fallback).
export function laneEta(capacity: number, holdersRemaining: number[], ordered: { expect_min: number | null }[], fallbackMin: number): number[];

export interface DispatchCandidate { step_id: number; task_id: string; name: string; priority: number; qa_cycles: number; created_at: string }
export interface DispatchView {
  freeSlots: number;                // min(global free, project free); already > 0 when called
  deviceSteps: string[];
  deviceRunning: number;            // running steps of the project whose name is in deviceSteps
  deviceLimit: number;              // device_steps_running
  laneBusy: boolean;                // some group at capacity with >= 1 waiter
  queued: DispatchCandidate[];      // live queued steps of the project, including the candidate
}
export type Verdict = { launch: true } | { launch: false; reason: "device_limit" | "lane_busy" | "ranked_behind" };
export function dispatchVerdict(c: DispatchCandidate, v: DispatchView): Verdict;
```

`dispatchVerdict` applies its rules in this order:

1. The candidate is not a device step (`!deviceSteps.includes(c.name)`):
   launch. Device-free work is never held back by the lane.
2. `deviceRunning >= deviceLimit`: hold, with reason `device_limit`.
3. `laneBusy`, and `freeSlots <=` the number of other queued device-free
   steps: hold, with reason `lane_busy`. This leaves the free slots to work
   that can run now.
4. Let `room = deviceLimit - deviceRunning`. Let `better` be the queued device
   steps other than `c` that rank before `c`. The device ranking is `priority`
   ascending, then `stepClassRank`, then `-qa_cycles`, then `created_at`, then
   `step_id`. If `better.length >= room`: hold, with reason `ranked_behind`.
5. Otherwise launch.

**Why rank device steps at dispatch?** The brief says to keep today's order
otherwise. We still rank, for this reason. With capacity 1 and
`device_steps_running = 2`, at most one device step waits for the lane at any
time. So the grant policy rarely has more than one waiter to order. The real
choice of "who goes next on the device" happens when a queued device step
takes the second device slot. Using the same test-first ranking there keeps
the policy in one place.

Task priority still comes first, so the user's explicit priority wins. Rule 4
only holds a step back when a better one is queued in the same project. That
better step is launched in the same tick, because `tick()` advances every live
task. A queued step that is never launched could hold others back, so
`queued` comes from live tasks only (see 3).

**Why rank tasks by head waiter, not row by row?** A per-row comparator that
mixes "FIFO within a task" with "test before implement" across tasks is not
transitive, and sorting with it is undefined. Ranking each task by its head
waiter and then flattening in FIFO order is total and deterministic.

**Starvation.** An implement could wait behind tests indefinitely only if
tests kept arriving. Tests come one per task per QA cycle, and
`device_steps_running` bounds how many device steps exist, so the wait is
bounded by the number of tasks in QA. This is accepted, and noted in the
README.

### 3. Leases with groups (`src/leases.ts`, `src/db.ts`)

**db.ts**

- `resource_leases` gets `expect_min INTEGER`, in `SCHEMA` and as an additive
  migration in `migrate()` via `PRAGMA table_info(resource_leases)`.
- `LeaseRow` gets `expect_min: number | null`.
- `insertLease` accepts `expect_min`.
- New `setLeaseExpect(id, min)`. It also clears `overdue_at`, so an extended
  hold can be flagged again.
- New `leaseWaitersInfo(project, machine, resources[])`: lease rows joined
  with `steps.name AS step` and `tasks.qa_cycles`, ordered by id.
- New `queuedLiveSteps(project)`: steps with `status = 'queued'` whose task
  status is in `('queued','running','blocked')`, joined with
  `t.priority, t.qa_cycles`.
- New `runningStepsOf(project)`.

**leases.ts**

- `export type GroupsOf = (project: string) => ResourceGroup[]` and
  `export const NO_GROUPS: GroupsOf = () => []`. The type is imported from
  config.ts as a type only (`import type`), so the module still never loads
  the config.
- `groupFor(groupsOf, project, resource)` returns the configured group, or the
  implicit `{ name: resource, members: [resource], capacity: 1 }`.
- `grantNext(store, project, machine, resource, groupsOf)` becomes a group
  grant:
  1. Load the member rows.
  2. `slots` = the set of `step_id`s with a granted row.
  3. `heldKeys` = the set of resources with a granted row.
  4. For each waiter in `orderWaiters(...)`: if its resource is not in
     `heldKeys`, and (`slots` has its step or `slots.size < capacity`), grant
     it, add it to both sets, and emit `lease.granted` as today, plus `group`.
- `stateFor` and `leaseView` compute `position` from the group's ordered
  waiters, and `queue` from the group's waiter count. The spec's "2nd" is the
  position in the lane, not in the key. They also add:
  - `expect_min`;
  - `eta_min` for waiters, from `laneEta`;
  - `expect_left_min` for holders;
  - `group` (the name, or null when implicit).
- Signatures change additively. `taskd` passes
  `groupsOf = p => cfg.projects[p]?.resource_groups ?? []`.
  - `requestLease(store, task, step, resource, reason, declared, opts: { expect_min?: number | null; groupsOf?: GroupsOf } = {})`.
    On a re-request where `opts.expect_min` is set, call `setLeaseExpect`.
  - `releaseLease(store, step, resource, why = "released", groupsOf = NO_GROUPS)`
  - `releaseStepLeases(store, step_id, why, groupsOf = NO_GROUPS)`
  - `reconcileLeases(store, maxMinutes, groupsOf = NO_GROUPS)`. The overdue
    limit is `r.expect_min ?? maxMinutes(project)`, and the event data gains
    `expected: boolean`.
  - `leaseView(store, row, groupsOf = NO_GROUPS, fallbackMin = 45)`
- New `laneViews(store, groupsOf, projects: string[], fallbackMin: (p) => number)`.
  For each configured group, per machine that has rows (and `local` when there
  are none), it returns:
  `{ project, machine, group, capacity, members, holders: [{task_id, step, attempt, resources[], since, held_min, expect_min, expect_left_min, overdue}], waiters: [{task_id, step, attempt, resource, position, waited_min, expect_min, eta_min}] }`.
- New `laneStatusForTask(store, task_id, groupsOf)` returns
  `{ position, of } | null` for the task's first waiting row.
- New `dispatchView(store, project, proj: Pick<ProjectConfig, ...>, freeSlots, groupsOf)`
  builds the `DispatchView` from the store. It has no `cfg` dependency, so it
  is testable.
- `devicePrompt(resources, role, groups: ResourceGroup[] = [])` gets the new
  wording (below).

### 4. taskd wiring (`src/taskd.ts`)

- `tryLaunch`:
  1. Keep the two concurrency checks.
  2. Compute `free = min(global - runningCount(), proj.concurrency - runningCount(project))`.
  3. Build the view with `dispatchView(...)`.
  4. Call `dispatchVerdict(candidateOf(task, step), view)`.
  5. On hold: if `deferred.get(step.id) !== reason`, set it and emit
     `step.deferred { step, reason }`. Then return.
  6. On launch: `deferred.delete(step.id)`.

  `deferred` is a module-level `Map<number, string>`. It is rebuilt naturally
  on the first tick after a restart.
- Pass `groupsOf` at every `releaseStepLeases`, `reconcileLeases`,
  `requestLease`, `releaseLease` and `leaseView` call site. Use
  `grep -n "Lease" src/taskd.ts` to find them.
- The lease endpoint reads `body.expect_min`. If it is present, it must be a
  finite number > 0 and ≤ 1440. Otherwise return 400 `expect_min must be minutes > 0`.
- The new endpoint `GET /lanes?project=` returns `laneViews(...)` and, for each
  project, `{ device_steps_running, device_running }`.
- `GET /tasks` adds `lane` to each task:
  - `{ state: "waiting", position, of }` from `laneStatusForTask`;
  - otherwise `{ state: "deferred", reason }` when a queued step of the task is
    in `deferred`;
  - otherwise `null`.
- `stepContext` passes `proj.resource_groups` to `devicePrompt`.
- Startup: log `config: device_steps '<x>' (projects.<p>) matches no pipeline step`
  for unknown names. Generalise `unknownTimeoutKeys`, or add
  `unknownDeviceSteps(cfg)` beside it.

### 5. CLI (`src/cli.ts`)

- `task lease <res> [--wait N] [--reason ..] [--expect M]`. A bad `--expect`
  calls `die()` (exit 1) before any request. The body gains `expect_min`.
  Output lines are unchanged except that waiting lines gain `, eta ~Nm` when
  `st.eta_min != null`. Exit codes are unchanged. Update the usage text.
- `task leases`:
  - Text mode first prints a block for each lane from `/lanes`, for example
    `tackle-tally local devices (capacity 1, device steps 2/2 running)`
    followed by holder and waiter lines with `expect ~25m (12m left)` and
    `eta ~13m`. The existing table follows, with an `EXPECT` column added.
  - `--json` still prints the `/leases` array (back compatible).
- `task show`: lease lines append ` expect ~25m` for holders and ` eta ~13m`
  for waiters.
- `task ls`: `statusText(t)` returns:
  - `waiting for devices (1st|2nd|3rd|Nth)` when `t.lane?.state === "waiting"`;
  - `queued: device lane` when `t.lane?.state === "deferred"`.
  The existing superseded and rejected texts keep precedence. Add an
  `ordinal(n)` helper.

### 6. Dashboard (`src/dashboard.html`)

- Fetch `/lanes` beside `/leases` and `/projects`.
- In `devices()`, put one lane row at the top of each project card, for each
  group: `devices · cap 1 · device steps 2/2`, then the holders (who ·
  resources · held/expect, `err` class when overdue), then the waiters in
  grant order with `eta ~Nm`.
- The per-resource rows stay.
- In `card()`, the lease meta line adds ETA for waiting rows.

### 7. Worker prompt (`devicePrompt`)

This replaces the current paragraph. Keep the code-3 and wait semantics
exactly. `G` is the group's members and `C` its capacity. The group sentence is
included only when the project has a group.

> ## Shared devices
> This project's devices are shared with other Foreman workers: `ios-sim`, `android-emu`. {group: `ios-sim` and `android-emu` form one device lane with capacity 1: while any worker holds one of them, other workers wait, so hold the lane as briefly as you can.} Do device work in one phase. First finish everything that needs no device: jest, tsc, lint, builds that do not install. Then take the lease once: `task lease ios-sim --wait 540 --expect <minutes> --reason "<what for>"`, run with a Bash timeout of 600000 ms. `--expect` is your honest estimate of the whole device phase (typical holds are 20–30 min). Waiters see it as an ETA, and the hold is flagged overdue after it. If you need more time, run the same command again with a new `--expect`. Waiting is normal, not a failure: the command prints who holds the device, your place in the queue and an ETA every 30 s. If it exits with code 3 you are still queued; run it again to keep your place. If you need several devices, take them in alphabetical order. Taking a second device of the same lane does not cost another slot. If you booted a simulator or emulator instance yourself, shut it down before you release. Run `task release <name>` for each device as soon as the device phase is over (leases are also released when your step ends). Never kill, shut down, erase or reinstall over another process's simulator, emulator, browser or Maestro run; if a device looks stuck, record it with `task note` and wait.

### 8. Docs and live config

- **README**:
  - Add to the `[projects.x]` example:
    `resource_groups = { devices = { members = ["ios-sim", "android-emu"], capacity = 1 } }`,
    `device_steps = ["implement", "test"]`, and `# device_steps_running = 2`.
  - Add a "Device lane" subsection under Resource leases covering: groups and
    slots, step classes and `device_steps_running`, the grant order, dispatch
    preference, `--expect`, ETA, overdue, `task leases` lanes, the `task ls`
    texts, starvation bound, and the `/lanes` endpoint.
  - Mention `lane.ts` in Testing.
- **skills/foreman/SKILL.md**:
  - Explain how to read `waiting for devices (2nd)` and `queued: device lane`.
  - `task leases` shows the lane.
  - To give a bigger machine more lane, raise the group `capacity` (and
    optionally `device_steps_running`) in config.toml, then restart taskd with
    no tackle-tally step running.
  - Workers use `--expect`.
- **Live config** (the implement step, outside the repo, authorised by the
  brief):
  1. `cp ~/.foreman/config.toml ~/.foreman/config.toml.bak-t0048`.
  2. In `[projects.tackle-tally]`, set `concurrency = 3`, with a comment that
     it needs the T0048 lane code. Add
     `resource_groups = { devices = { members = ["ios-sim", "android-emu"], capacity = 1 } }`
     and `device_steps = ["implement", "test"]`.
  3. Validate with
     `bun -e 'console.log(JSON.stringify(Bun.TOML.parse(require("fs").readFileSync(process.env.HOME+"/.foreman/config.toml","utf8")).projects["tackle-tally"]))'`.
  4. Do not restart taskd.

## Files to touch, in order

1. `src/config.ts`: types, `parseLane`, wiring in `loadConfig`, sample TOML.
2. `src/lane.ts` (new): `orderWaiters`, `stepClassRank`, `laneEta`,
   `dispatchVerdict`.
3. `test/lane.test.ts` (new): pure-policy tests.
4. `src/db.ts`: `expect_min` column and migration, new queries.
5. `src/leases.ts`: group grant, views, `expect`, `dispatchView`,
   `laneStatusForTask`, `laneViews`, `devicePrompt`.
6. `test/leases.test.ts`: group, expect, migration and dispatch-view tests.
7. `src/taskd.ts`: `tryLaunch`, `groupsOf` wiring, endpoints, startup warning.
8. `src/cli.ts`: `--expect`, `leases`, `show`, `ls`.
9. `src/dashboard.html`: the lane.
10. `test/smoke.sh`: a lane scenario, if it stays cheap (see T15).
11. `README.md`, `skills/foreman/SKILL.md`.
12. The live config (outside the repo).

## Verification per slice

| Slice | Check |
|---|---|
| Config | `bun test test/lane.test.ts` covers the `parseLane` cases (AS-15), defaults, and inline vs sub-table. `bunx tsc --noEmit`. |
| Pure policies | `bun test test/lane.test.ts`: AS-5 and AS-6 ordering, non-mutation, determinism (shuffled input gives the same output); `laneEta` with capacity 1 and 2, overdue holder gives 0, missing expect uses the fallback; `dispatchVerdict` AS-8, AS-9, AS-10 and each hold reason. |
| Leases | `bun test test/leases.test.ts`: AS-1 to AS-4 (capacity 1 and 2, member leases count once per step), AS-7 (all existing cases unchanged), AS-11 (expect stored, updated on re-request, overdue uses it, else the fallback), AS-13 (old-schema DB opens, `expect_min` null), positions follow the group order, `dispatchView` counts device-running and `laneBusy` from a real Store. |
| taskd/CLI | `bunx tsc --noEmit`. A CLI test in the `reject-cli.test.ts` style: `task ls` renders `waiting for devices (2nd)` and `queued: device lane` from a stubbed `/tasks`; `task lease --expect 0` exits 1 with no request. `sh test/smoke.sh` still passes. |
| Dashboard | Load `/` against a dev taskd on a temp `FOREMAN_HOME` with a project that has a group (smoke config) and check the lane row renders. A screenshot is optional (verify mode is inspect). |
| Docs/config | Read-through. The TOML one-liner parses tackle-tally with the new keys. |
| Whole | `bunx tsc --noEmit && bun test && sh test/smoke.sh` |

## Risks

- **Old code reading the new config.** taskd reads config only at startup. If
  taskd were restarted on pre-T0048 code after the config edit, tackle-tally
  would run at `concurrency = 3` with no lane, which is the swap scenario. The
  merge goes direct after QA, so the window is short. Mitigations: the config
  comment, and the implement and handoff summaries telling the user's
  assistant to restart only after the merge. In an emergency, roll back with
  `config.toml.bak-t0048`.
- **Global concurrency.** `[defaults] concurrency = 3` is shared by all
  projects, so tackle-tally's 3 competes with other projects. It is left
  unchanged and stated in the summary. The user may raise it.
- **A waiting step burns its timeout.** The second device step codes, then
  waits for the lane under its step budget. With `device_steps_running = 2` the
  wait is about one hold (20–30 min). The `implement = 120` / `test = 180`
  budgets absorb it. Evidence after rollout: watch `lease.granted.waited_sec`.
- **Phantom queued rows.** If a queued step of a live task is never launched,
  rule 4 or rule 3 could hold device steps back. `queuedLiveSteps` filters on
  task status, and `tick()` advances every live task in the same pass. A test
  covers a gate-status task with a stale queued row being ignored.
- **Signature churn in leases.ts.** New parameters are optional with
  `NO_GROUPS` defaults, so existing tests and callers compile, and behaviour is
  identical without groups.
- **Non-device steps taking leases.** research and triage did this in the
  evidence. They count against the group, which is correct for memory, but
  dispatch does not limit them. That is accepted. They rank last in
  `orderWaiters`.
- **Live restart.** It must not happen while a tackle-tally step runs. It is
  left to the user's assistant after the merge (T17).
