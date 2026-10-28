# Plan: resource leases

Read `spec.md` first; it fixes the names, routes, events and CLI output.

## Approach

One new deep module, `src/leases.ts`, owns the policy (who holds what, who is
next, what counts as dead, overdue) behind six functions. All SQL stays in
`src/db.ts` with the other tables, as small `Store` methods. `taskd.ts` only
calls the module at the points where a step stops running, on every tick, and
from three new routes. Nothing in `leases.ts` imports `taskd.ts` or
`loadConfig()`, so `bun test` can drive it with a `Store` on a temp file.

The queue and the holder live in one table: a row is a holder when
`granted_at` is set, a waiter otherwise; waiters are served in row-id order.
Release deletes the row (the event log keeps the history, with held seconds).

Invariant enforced by `reconcileLeases` on every tick, so every terminal path
converges even after a restart or a missed hook: a row exists only while its
step is `running` and its task is not `done`/`failed`/`cancelled`; each key has
at most one holder; a free key with waiters is granted to the lowest id.
The explicit release calls in taskd make release immediate and give the event
a precise `why`; the sweep is the safety net (`why: "swept"`).

Note that during parallel QA a task can be `blocked` while a sibling step is
still running, so the sweep must not release on task `blocked`; the blocked
step's own row goes because its step status becomes `blocked`.

### Store (`src/db.ts`)

Add to `SCHEMA` (`CREATE TABLE IF NOT EXISTS`, so existing DBs pick it up with
no migration code):

```sql
CREATE TABLE IF NOT EXISTS resource_leases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL, machine TEXT NOT NULL, resource TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  step_id INTEGER NOT NULL REFERENCES steps(id),
  reason TEXT,
  requested_at TEXT NOT NULL, granted_at TEXT, overdue_at TEXT,
  UNIQUE (project, machine, resource, step_id)
);
CREATE INDEX IF NOT EXISTS resource_leases_key ON resource_leases(project, machine, resource, id);
```

`export interface LeaseRow` mirroring the columns. Store methods (plain SQL, no
policy): `insertLease(...) : LeaseRow`, `getLease(step_id, project, machine,
resource)`, `leasesForKey(project, machine, resource)` (ordered by id),
`leasesForStep(step_id)`, `leasesForTask(task_id)`, `listLeases({project?})`
(ordered by project, machine, resource, id), `grantLease(id)`,
`markLeaseOverdue(id)`, `deleteLease(id)`.

### Config (`src/config.ts`)

- `ProjectConfig.resources: string[]` (default `[]`, `map(String)` like `deny`).
- `ProjectConfig.lease_max_minutes: number` = `Number(p.lease_max_minutes ?? defaults.lease_max_minutes)`.
- `Defaults.lease_max_minutes: number`, `DEFAULTS.lease_max_minutes = 45`.
- `defaultConfigToml()`: `lease_max_minutes = 45` under `[defaults]`, and
  commented `# resources = ["ios-sim", "android-emu"]   # devices workers take turns on (task lease)`
  and `# lease_max_minutes = 45` in the example project.
- Export a helper `deviceResources(p: ProjectConfig): string[]` =
  declared resources plus `"browser"` when `verify === "browser"`, deduped.

### Policy (`src/leases.ts`, new)

```ts
export const machineOf = (step: StepRow) => step.machine ?? "local";
export interface LeaseState { resource; machine; granted: boolean; position: number; queue: number;
  holder: { task_id; step; attempt; since; reason } | null; warning?: string }

export function requestLease(store, task: TaskRow, step: StepRow, resource: string, reason: string | null, declared: string[]): LeaseState
export function releaseLease(store, step: StepRow, resource: string, why = "released"): { released: boolean; held_sec: number | null }
export function releaseStepLeases(store, step_id: number, why: string): number
export function reconcileLeases(store, maxMinutes: (project: string) => number): void
export function leaseView(store, row: LeaseRow): {...row, step, attempt, state, position, held_sec, waited_sec, overdue, holder}
export function devicePrompt(resources: string[], role: string): string
```

- `requestLease`: inside `store.db.transaction`. If a row exists for
  (key, step) return its state (no event). Else insert, write
  `lease.requested` (with `position` and `undeclared` when `declared.length &&
  !declared.includes(resource)`), then `grantNext(key)`, then return state.
  The warning text: `'<r>' is not in project <p>'s resources (<list>); typo?`.
- `grantNext(key)` (private): if no granted row for the key, grant the
  lowest-id waiter, event `lease.granted` with `waited_sec`.
- `releaseLease`: delete the step's row for the key, event `lease.released`
  (`held_sec` null when it was waiting), then `grantNext(key)`.
- `releaseStepLeases`: same for every row of the step; returns count.
- `reconcileLeases`: (1) for each row whose step is not `running` or whose
  task is `done`/`failed`/`cancelled`, release with `why: "swept"`;
  (2) `grantNext` for every key with rows; (3) for each holder with
  `overdue_at` null and `granted_at` older than `maxMinutes(project)` minutes,
  set `overdue_at` and write `lease.overdue {resource, machine, held_min, max_min}`.
  Unknown projects (removed from config) use 45.
- `devicePrompt`: `""` unless `resources.length` and role is `developer` or
  `test-analyst`. Otherwise the paragraph below, with the names joined.
  Seconds/minutes use `Date.parse`; times are ISO strings from `now()`.

Paragraph (heading included; `<list>` = backticked names, `<first>` = first name):

```
## Shared devices
This project's devices are shared with other Foreman workers: <list>. Before you boot, build for, install on, or run flows against one of them, take its lease: `task lease <first> --wait 540 --reason "<what for>"`, run with a Bash timeout of 600000 ms. Waiting is normal, not a failure: the command prints who holds the device and your place in the queue every 30 s. If it exits with code 3 you are still queued; run it again to keep your place. Keep running jest, tsc, lint and other device-free checks without a lease. Run `task release <first>` as soon as the device phase is over (leases are also released when your step ends). If you need several devices, take them in alphabetical order. Never kill, shut down, erase or reinstall over another process's simulator, emulator, browser or Maestro run; if a device looks stuck, record it with `task note` and wait.
```

### taskd (`src/taskd.ts`)

Order matters only within this file; each bullet is a small edit.

1. Import `{ requestLease, releaseLease, releaseStepLeases, reconcileLeases, leaseView, devicePrompt }` and `deviceResources`.
2. `expireLeases()` (line ~92): after `store.updateStep(... failed ...)`, call
   `releaseStepLeases(store, s.id, "heartbeat lease expired")`.
3. `tick()`: after `await expireLeases()`, `reconcileLeases(store, p => cfg.projects[p]?.lease_max_minutes ?? cfg.defaults.lease_max_minutes)`, wrapped in try/catch that logs like `advance` does.
4. `failTask()`: inside its `tx`, `for (const s of running) releaseStepLeases(store, s.id, "task failed")`.
5. `handleResult()`: inside the existing `tx`, `releaseStepLeases(store, step.id, \`step ${status}\`)`.
6. Cancel route: inside its `tx`, release for each `running` step with `"task cancelled"`.
7. `stepContext()`: `DEVICE_LEASES: devicePrompt(deviceResources(proj), step.role)` in `prompt_vars`.
8. `GET /tasks/:id`: add `leases: store.leasesForTask(task.id).map(r => leaseView(store, r))`.
9. New routes next to the other `/steps/:id/...` routes:
   - `POST /steps/:id/lease`: 404 unknown step; `bad("resource required")`; 409
     `{error: "step is not running"}` unless step is `running`, is the latest
     attempt, and the task is active (reuse the heartbeat's `stale` condition —
     factor it into a small `isLive(step)` helper and use it in both places).
     Then `requestLease(store, task, step, resource, body.reason ?? null, project(task).resources)`;
     if `warning`, `log(...)` it. Return the state.
   - `POST /steps/:id/release`: 404 unknown step; `releaseLease(store, step, resource)`;
     return `{ok: true, ...result}`. No liveness check (a dead step's release is harmless).
   - `GET /leases`: `?task=` resolves the project; `?project=` filters; returns
     `store.listLeases({project}).map(r => leaseView(store, r))`.

### Prompt (`prompts/worker-preamble.md`)

Add `{{DEVICE_LEASES}}` on its own line between the `## Rules` list and
`## Step instructions`. Empty for every other step, so other prompts are
byte-for-byte unchanged apart from a blank line.

### CLI (`src/cli.ts`)

- `case "lease"`: require `FOREMAN_STEP`; `resource = rest[0]`; `wait = opt("wait")`
  (non-negative integer or die); loop: `POST /steps/${envStep}/lease {resource, reason: opt("reason")}`;
  print warning once to stderr; granted → print and return; else print the
  waiting line on the first poll and whenever ≥30 s passed since the last
  print; if `wait` elapsed print the still-queued line and `process.exit(3)`;
  `await Bun.sleep(5000)`. Holder age via existing `ago()`.
- `case "release"`: `POST /steps/${envStep}/release {resource}`; print per spec.
- `case "leases"`: `GET /leases?task=` inside a task (unless `--project`), else
  `?project=` or all; `out()` table: `PROJECT MACHINE RESOURCE STATE TASK/STEP AGE REASON` with `OVERDUE` suffix.
- `case "show"`: when `d.leases?.length`, a `leases:` block after steps:
  held → `  ios-sim  held by test#1 for 4m (maestro)`, waiting → `  ios-sim  waiting #2 for test#1 (held by T0007/implement#2 for 12m)`.
- `TASK_HELP`: three lines under Worker commands.

### Dashboard (`src/dashboard.html`)

- `refresh()` also fetches `/leases` and `/projects`.
- New `<section><h2>Devices</h2><div id="devices">` before Active. One small
  card per project with declared resources or rows; one table row per resource:
  name, holder (`T0007 test#1 · 12m · reason`, `.err`/warn class when
  `overdue`) or `free`, queue (`T0008 implement#1, T0009 test#2`).
- `card(t, d)`: a line from `d.leases` (`holds ios-sim 4m`, `waiting #2 for android-emu`).
- Show `lease.overdue` events among the card notes (extend the `notes` filter and text).

### README

- Config example: `resources = ["ios-sim", "android-emu"]`.
- Use: worker commands sentence gains `task lease`, `task release`, `task leases`.
- New `### Resource leases` under Guard rails (after the resilience paragraph):
  what it is, key = project + machine + resource, FCFS, released on step end,
  overdue after `lease_max_minutes` (logged, not released), distinct from the
  heartbeat lease, prompts paragraph for developer/test-analyst when the project
  declares devices or verifies in a browser, restart taskd after upgrading.
- Roadmap: add `9. ~~Resource leases: workers take turns on shared devices (\`task lease\`)~~`.
- Testing: mention `bun test` for the lease policy.

### Tests (`test/leases.test.ts`, `package.json`)

- `package.json` scripts: `"test": "bun test test/"`.
- Top of the test file: `process.env.FOREMAN_HOME = mkdtempSync(join(tmpdir(), "fm-leases-"))`
  **before** `const { Store } = await import("../src/db")` and
  `await import("../src/leases")` (config paths are computed at import time).
- Helpers: `mkTask(project)`, `mkStep(task, {machine?, status = "running"})`
  using `store.insertTask` / `store.insertStep`; `events(type)` reading the
  events table.
- One `test()` per acceptance scenario 1–7 and 9 in `spec.md`. Overdue: set
  `granted_at` 50 minutes back with SQL, reconcile with `() => 45`.
- Heartbeat expiry: replicate what `expireLeases` does (update step to failed,
  `releaseStepLeases(store, id, "heartbeat lease expired")`) and also the
  sweep-only path (step failed, no explicit call, `reconcileLeases` releases
  with `why: "swept"`).
- Note: `tsconfig.json` includes only `src/**`; leave it. `bun test`
  type-strips the test file.

## Files to touch, in order

1. `src/config.ts` — fields, default, template, `deviceResources`.
2. `src/db.ts` — table, `LeaseRow`, Store methods.
3. `src/leases.ts` — new policy module.
4. `test/leases.test.ts`, `package.json` — tests (after 3; parallel with 5).
5. `src/taskd.ts` — wiring, routes, prompt var, `isLive` helper.
6. `prompts/worker-preamble.md` — `{{DEVICE_LEASES}}` slot.
7. `src/cli.ts` — lease/release/leases/show/help (after 5's route shapes; parallel with 8, 9).
8. `src/dashboard.html` — devices block and card lines.
9. `README.md` — docs and roadmap.

## Verification per slice

| Slice | Check |
|---|---|
| 1–3 store, config, policy | `bunx tsc --noEmit` clean. |
| 4 tests | `bun test` green; every scenario 1–7, 9 has a named test. |
| 5–6 taskd + prompt | `bunx tsc --noEmit`; start an isolated taskd (`FOREMAN_HOME=$(mktemp -d)`, port 7778, a project with `resources = ["ios-sim"]`) and `curl -XPOST -H "authorization: Bearer …" localhost:7778/steps/999/lease -d '{"resource":"ios-sim"}'` → 404; a non-running step → 409; `GET /leases` → `[]`. |
| 7 CLI | With that taskd and two fake running steps (or `test/smoke.sh`-style tasks in `slow` mode), `FOREMAN_TASK=… FOREMAN_STEP=… bin/task lease ios-sim --wait 5` from two shells: first prints granted, second prints waiting line then exits 3; `bin/task release ios-sim` in the first, rerun second → granted; `bin/task leases`, `bin/task show <id>` show both. Record outputs with `task note`. |
| 8 dashboard | `foreman dashboard --print` against the isolated taskd, open the URL, see the Devices block with holder and queue (screenshot as artifact if a browser is available; otherwise inspect `/leases` JSON and the rendered HTML via `curl`). |
| 9 README | Read it through; roadmap item present. |
| All | `bunx tsc --noEmit`, `bun test`; `sh test/smoke.sh` if herdr is available (nothing in existing paths should change). |

## Risks

- **Bash tool timeout.** A worker's `task lease` can be killed by Claude
  Code's Bash timeout (2 min default, 10 min max). Mitigation: the queue entry
  survives a killed client, `task lease` is idempotent, and the prompt says
  `--wait 540` with a 600000 ms Bash timeout and to rerun on exit 3.
- **Waiting counts against `step_timeout_min`** (90 min). A long queue can time
  a step out; it is then retried and resumes. Accepted; out of scope to pause
  the timer. Overdue events make long holds visible.
- **Deadlock** when two steps each hold one device and wait for the other.
  Mitigation: the prompt orders acquisition alphabetically; overdue events
  surface it; ending either step releases everything.
- **Naming collision** with the heartbeat lease (`lease_until`,
  `expireLeases`, `step.lease_expired`). Keep new identifiers `resource_leases`
  / `*Lease*` against the new table and say "heartbeat lease" in comments and docs.
- **Parallel QA blocked task**: a sweep keyed on task `blocked` would steal a
  running sibling's lease. The sweep uses step status plus task
  `done`/`failed`/`cancelled` only; covered by a test (blocked step released,
  running sibling of the same task keeps its lease).
- **A step that never releases** holds the device until it ends. Overdue is
  report-only by design; the user decides (cancel the task).
- **Running taskd** does not pick this up until the user restarts the service
  (`foreman service restart`). The new table is created on startup.
