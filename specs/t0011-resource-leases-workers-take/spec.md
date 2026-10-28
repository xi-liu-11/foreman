# Resource leases: workers take turns on the simulator and emulator

_Created by Foreman T0011._

## Goal

Workers on the same project share physical devices: the booted iOS simulator,
the one Android AVD, a browser profile. Today nothing stops two testers from
installing the same bundle id on the same simulator and flaking each other's
Maestro runs (tackle-tally runs with `concurrency = 1` only to avoid this).

Add named **resource leases** to taskd. A step takes a lease only around the
phase that needs the device (`task lease ios-sim` … `task release ios-sim`);
jest, tsc and lint keep running in parallel without one. taskd grants each
resource first come, first served, persists holders and the queue in SQLite,
and releases a step's leases automatically when the step stops running.

The per-project `concurrency` count is unchanged: it limits running steps,
leases limit devices.

## Terms

- **Resource lease** (this feature): a named, exclusive hold on a device. Stored
  in the new `resource_leases` table. Events are `lease.*`.
- **Heartbeat lease** (existing): `steps.lease_until`, refreshed by the runner's
  heartbeat; expiry fails the step (`step.lease_expired`). Code and docs must keep
  the two apart; new code names things `resource…`/`lease…` against the table,
  never `lease_until`.
- **Key**: `(project, machine, resource)`. `machine` is the step's `machine`
  column or `"local"` when null. Two projects never wait for each other; a
  later remote worker on another Mac never waits for this Mac's simulator.
- **Holder**: the one row for a key with `granted_at` set. **Waiters**: rows for
  the key with `granted_at` null, ordered by row id (request order).

## Scope

1. **Config** (`src/config.ts`): per project `resources = ["ios-sim", ...]`
   (default `[]`) and `lease_max_minutes` (default from `[defaults]
   lease_max_minutes`, which defaults to 45). Any resource name may be leased,
   declared or not. When a project declares resources and a step leases a name
   not in the list (and not the implicit `browser` of a `verify = "browser"`
   project), taskd logs a warning, records `undeclared: true` on the
   `lease.requested` event and returns the warning, which the CLI prints to
   stderr. The lease is still granted normally.
2. **Store** (`src/db.ts`): new table `resource_leases` (id, project, machine,
   resource, task_id, step_id, reason, requested_at, granted_at, overdue_at),
   unique on `(project, machine, resource, step_id)`. Holders and the queue
   survive a taskd restart.
3. **Policy** (`src/leases.ts`, new, no taskd import so it is unit-testable):
   request, release, release-all-for-step, reconcile (sweep dead rows, grant,
   flag overdue), list, and the prompt paragraph builder.
4. **taskd** (`src/taskd.ts`):
   - Grants on request, on release, and on every tick (reconcile runs right
     after `expireLeases()`), whichever is first.
   - Releases a step's leases (held and queued) in `handleResult` (done,
     failed, blocked), in `expireLeases` (heartbeat lease expired), on task
     cancel, and in `failTask`. The tick-time sweep also drops any row whose
     step is no longer `running` or whose task is `done`/`failed`/`cancelled`,
     so restarts and missed paths converge.
   - Overdue: a hold older than the project's `lease_max_minutes` gets
     `overdue_at` set once and a `lease.overdue` event. It is not released.
   - Routes (step-scoped, same auth as the rest):
     - `POST /steps/:id/lease` `{resource, reason?}` → lease state (below).
       Idempotent: re-requesting a held or queued resource returns the current
       state and writes no new event. Rejected with 409 when the step is not the
       current running attempt (same fencing rule as heartbeat/result).
     - `POST /steps/:id/release` `{resource}` → `{ok, released, held_sec}`.
       Releasing something not held or queued is `{ok: true, released: false}`.
     - `GET /leases[?project=|&task=]` → rows with `task_id`, step name,
       state (`held`/`waiting`), position, `held_sec`/`waited_sec`, overdue.
     - `GET /tasks/:id` gains `leases`: this task's rows (held and waiting),
       each with its current holder when waiting.
   - Lease state returned by `POST /steps/:id/lease`:
     `{resource, machine, granted, position, queue, holder, warning?}` where
     `position` is 0 when held and 1-based among waiters otherwise, and `holder`
     is `{task_id, step, attempt, since, reason}` or null.
   - Prompt variable `DEVICE_LEASES` (see 7).
5. **Events**: `lease.requested {resource, machine, reason, position, undeclared?}`,
   `lease.granted {resource, machine, waited_sec}`,
   `lease.released {resource, machine, held_sec | null, why}` (`why` is
   `released`, `step done`, `step failed`, `step blocked`, `heartbeat lease
   expired`, `task cancelled`, `task failed`, `swept`; `held_sec` is null when
   the row was still waiting), `lease.overdue {resource, machine, held_min,
   max_min}`. All carry the step's task_id and step_id.
6. **Worker CLI** (`src/cli.ts`, uses `FOREMAN_TASK`/`FOREMAN_STEP` like
   `task note`):
   - `task lease <resource> [--wait <seconds>] [--reason "<text>"]`: requests
     the lease, then polls the same endpoint every 5 s until granted. While
     waiting it prints one line immediately and then one line every 30 s:
     `waiting for ios-sim: held by T0007/test#1 for 12m (maestro flows); you are #2 of 2`.
     On grant prints `lease ios-sim granted` (or `already held`) and exits 0.
     With `--wait N`, if not granted within N seconds it prints
     `still queued for ios-sim at #k; run task lease ios-sim again to keep your place, or task release ios-sim to leave the queue`
     and exits 3; the queue entry is kept. Without `--wait` it waits
     indefinitely. An undeclared-name warning goes to stderr.
   - `task release <resource>`: prints `released ios-sim after 4m`, or
     `ios-sim was not held` (exit 0 either way).
   - `task leases [--project <p>]`: table of holders and waiters (project,
     machine, resource, held/waiting #n, task/step, age, reason, OVERDUE flag).
     Inside a task it defaults to the task's project.
   - `task show` gains a `leases:` section (held and waited-for, with holder for
     waiters). Help text lists the three commands under worker commands.
7. **Prompts**: `prompts/worker-preamble.md` gets a `{{DEVICE_LEASES}}` slot.
   taskd fills it only for steps whose role is `developer` or `test-analyst`
   and whose project has device resources (declared `resources`, plus
   `browser` when `verify = "browser"`); otherwise empty. The paragraph names
   the project's resources and says: take `task lease <name>` before booting,
   building for, installing on or running flows against that device; keep
   running jest / tsc / lint without a lease; `task release <name>` as soon as
   the device phase is over; take several devices in alphabetical order;
   never kill, shut down, erase or reinstall over another process's simulator,
   emulator, browser or Maestro run; waiting is normal and not a failure; how
   to handle `--wait` exit 3 and the Bash tool timeout.
8. **Dashboard** (`src/dashboard.html`): a "Devices" section with a block per
   project that declares resources or has lease rows: each resource with
   holder (task/step, held for, reason, overdue highlighted) or "free", and the
   queue in order. Task cards show the leases the task's steps hold or wait for.
9. **README**: a short "Resource leases" section under the architecture notes
   (after Guard rails / resilience), the config example gets `resources`, the
   Use section lists the worker commands, the roadmap gets the item struck
   through; a note that taskd must be restarted to pick the feature up.
10. **Tests**: `test/leases.test.ts` under `bun test` (new `test` script in
    package.json) against a real `Store` on a temp `FOREMAN_HOME`.

## Acceptance scenarios

Each is covered by `bun test` unless marked (manual).

1. **Grant order.** Steps A, B, C of project P (machine local) request `ios-sim`
   in that order. A is granted; B is #1, C is #2 waiting. A releases → B is
   granted, C is #1. B releases → C granted. `lease.requested` ×3,
   `lease.granted` ×3, `lease.released` ×2 with `held_sec` ≥ 0.
2. **Re-entrancy.** A holds `ios-sim` and requests it again → granted, no new
   row, no new event. B waiting re-requests → same position, no new event.
   A requests `android-emu` too → holds both.
3. **Auto-release on terminal step states.** For each of: step `done`, step
   `failed`, step `blocked`, heartbeat lease expired (step `failed` with the
   expired error, via the same call `expireLeases` makes), task `cancelled`
   while the step row is still `running`, task `failed` while still `running`:
   the step's held and queued rows are gone after the release/reconcile call,
   `lease.released` is logged with the right `why`, and the next waiter is
   granted.
4. **Restart.** Holders and waiters written by one `Store` are visible to a new
   `Store` on the same file; reconcile on the new store grants nothing new
   while the holder's step is still running.
5. **Per-machine and per-project scoping.** A (P, local) and B (P, machine
   `mini`) both get `ios-sim`; C (project Q, local) gets `ios-sim` too. D
   (P, local) waits behind A only.
6. **Overdue.** A hold whose `granted_at` is older than `lease_max_minutes`
   gets one `lease.overdue` event on reconcile and keeps the lease; a second
   reconcile writes no second event.
7. **Undeclared name.** Project declares `["ios-sim"]`; request for `ios-sm`
   returns a warning and is granted; project declaring nothing gets no warning.
8. **Fencing** (route-level, manual or smoke): `POST /steps/:id/lease` for a step
   that is not running returns 409 and creates no row.
9. **Prompt paragraph.** `devicePrompt` returns text naming `ios-sim` and
   `android-emu` for a developer step of a project declaring both; `browser`
   for a test-analyst step of a `verify = "browser"` project; empty for an
   architect step, and for a `tests` project with no resources.
10. **CLI** (manual against a running taskd): `task lease x` in one step while
    another holds `x` prints a waiting line, then a line every 30 s, then
    `granted` when the other releases; `--wait 5` exits 3 and keeps the place;
    `task leases` and `task show` list holder and queue.
11. `bunx tsc --noEmit` passes; `bun test` passes; `test/smoke.sh` still passes
    (manual, needs herdr).

## Out of scope

- Changing pipelines, the merge flow, ticket hooks, or `concurrency` semantics.
- Forcibly releasing overdue leases, notifying via herdr on overdue, or
  pausing `step_timeout_min` while a step waits.
- Detecting device use automatically, or launching simulators per worker.
- Cross-project or cross-machine shared resources.
- Editing `~/.foreman/config.toml` (the user adds `resources` to tackle-tally)
  and restarting taskd (the user restarts the service).
