# Tasks: T0048 device lane

Read `plan.md` first. It holds the interfaces, the rule order of
`dispatchVerdict`, the prompt wording, and the verification for each slice.

`[P]` marks a task whose files no other open task touches. Once its
dependencies are done, it can run in parallel with other `[P]` tasks.

This project has no device suite. The end-to-end check is `test/smoke.sh`,
plus the `bun test` files named in each task.

## Slice A: config and pure policies

- [x] T01 `src/config.ts`:
  - Add `ResourceGroup`, plus `resource_groups`, `device_steps` and
    `device_steps_running` on `ProjectConfig`.
  - Export `parseLane(raw, where, resources, concurrency)` with the rules in
    plan §1: warnings, member auto-declare, duplicates, the defaults
    `["implement","test"]` and `max(capacity) + 1`, and with no groups `[]` and
    `concurrency`.
  - In `loadConfig`, call it per project and use its returned `resources`.
  - Add commented `resource_groups` / `device_steps` / `device_steps_running`
    lines to `defaultConfigToml()` under `[projects.dicer]`.
- [x] T02 [P] `src/lane.ts` (new): `STEP_CLASS_ORDER`, `stepClassRank`,
  `orderWaiters`, `laneEta`, `dispatchVerdict`, and their types, exactly as in
  plan §2. Pure: no imports from db, config or taskd.
- [x] T03 `test/lane.test.ts` (new, after T01 and T02):
  - `parseLane`: AS-15 cases; inline table and sub-table give the same result;
    defaults with and without groups.
  - `orderWaiters`: AS-5, AS-6; a shuffled input gives the same output; the
    input is not mutated; others rank after implement.
  - `laneEta`: capacity 1 and 2; an overdue holder gives 0; a missing expect
    uses the fallback.
  - `dispatchVerdict`:
    - AS-8 (`device_limit`);
    - AS-9 (test before an older implement at equal priority; higher priority
      wins first);
    - AS-10 (empty `deviceSteps` gives launch);
    - `lane_busy` holds only when free slots ≤ the queued device-free count;
    - device-free candidates always launch.

  Run `bun test test/lane.test.ts && bunx tsc --noEmit`.

## Slice B: store and leases (after T02)

- [x] T04 [P] `src/db.ts`:
  - Add `expect_min INTEGER` to the `resource_leases` DDL, to `LeaseRow`, and
    to `migrate()` (`PRAGMA table_info(resource_leases)`, then `ALTER TABLE`).
  - `insertLease` takes `expect_min`.
  - Add `setLeaseExpect(id, min)`, which also clears `overdue_at`.
  - Add `leaseWaitersInfo(project, machine, resources)`, which joins step name
    and task `qa_cycles`.
  - Add `queuedLiveSteps(project)`: queued steps of tasks in
    queued/running/blocked, with `priority` and `qa_cycles`.
  - Add `runningStepsOf(project)`.
- [x] T05 `src/leases.ts` (after T04):
  - Add `GroupsOf`, `NO_GROUPS` and `groupFor`.
  - Rewrite `grantNext` as the greedy group grant from plan §3.
  - Positions and queue follow the group order.
  - `requestLease` gets `opts { expect_min, groupsOf }`, and a re-request with
    `expect_min` updates the row.
  - `releaseLease`, `releaseStepLeases`, `reconcileLeases` and `leaseView` get
    an optional `groupsOf`. Overdue uses `expect_min ?? maxMinutes`, and the
    event carries `expected`.
  - `leaseView` adds `expect_min`, `eta_min`, `expect_left_min` and `group`.
  - Add `laneViews`, `laneStatusForTask` and `dispatchView`.
  - Update the header comment, which currently says first-come-first-served.
- [x] T06 `src/leases.ts` `devicePrompt(resources, role, groups = [])`: the new
  paragraph from plan §7, verbatim. The group sentence appears only when a
  group exists. Keep the role filter.
- [x] T07 `test/leases.test.ts` (after T05 and T06). All existing cases must
  pass unchanged (AS-7). Add:
  - AS-1, AS-2, AS-3 and AS-4 with a `devices` group at capacity 1 and 2: one
    slot per step, holding two members takes one slot, and per-key exclusivity
    holds.
  - AS-5 through the store: tasks with `qa_cycles` and step names `test` and
    `implement`; release one at a time and assert the grant order and the
    positions reported by `requestLease`/`leaseView`.
  - AS-11: `expect_min` is stored and updated on re-request; overdue fires at
    the expect, not the fallback, and at the fallback when the expect is null;
    a re-request with a new expect clears `overdue_at`; `eta_min` on a waiter.
  - AS-13: an old-schema `resource_leases` DB (DDL without `expect_min`) with a
    row opens and the row loads unchanged.
  - `dispatchView`: device-running count, `laneBusy`, and a stale queued row
    of a gate-status task excluded.
  - `devicePrompt`: contains `--expect`, `alphabetical`, `shut it down`/`shut
    down`, `never kill`; the group sentence only when there are groups;
    `--wait 540` and `code 3` are kept.

  Run `bun test test/leases.test.ts && bunx tsc --noEmit`.

## Slice C: scheduler and endpoints (after T01 and T05)

- [x] T08 `src/taskd.ts`:
  - Add the `groupsOf` helper and pass it at every lease call site.
  - In `tryLaunch`, after the concurrency checks, call `dispatchView` and
    `dispatchVerdict`. Keep the `deferred` map, and emit `step.deferred` once
    per step and reason.
  - The lease endpoint validates `expect_min` (400 when invalid) and passes it
    through.
  - Add `GET /lanes`.
  - `GET /tasks` adds `lane`.
  - `stepContext` passes `proj.resource_groups` to `devicePrompt`.
  - At startup, warn about unknown `device_steps`.

  Run `bunx tsc --noEmit && bun test`.

## Slice D: CLI, dashboard (after T08)

- [x] T09 [P] `src/cli.ts`:
  - `task lease`: `--expect <minutes>`. An invalid value calls `die`
    (exit 1) before the request. Waiting lines append `eta ~Nm`. Exit codes
    are unchanged. Update the usage text.
  - `task leases`: lane blocks from `/lanes` above the table, plus an `EXPECT`
    column. `--json` is unchanged.
  - `task show`: `expect`/`eta` on lease lines.
  - `task ls`: `statusText` gives `waiting for devices (Nth)` and
    `queued: device lane`. Add the `ordinal()` helper.
- [x] T10 [P] `src/dashboard.html`:
  - Fetch `/lanes`.
  - Add lane rows to the `devices()` card: capacity, device steps n/m,
    holders with resources and held/expect (`err` when overdue), and waiters
    in grant order with ETA.
  - Add ETA to the `card()` lease meta line.
- [x] T11 `test/lane-cli.test.ts` (new, after T09), in the
  `reject-cli.test.ts` style with a stub server:
  - `task ls` renders `waiting for devices (2nd)` and `queued: device lane`.
  - `task lease ios-sim --expect 0` and `--expect x` exit 1 with no POST.
  - `task lease ios-sim --expect 25` POSTs `expect_min: 25`.
  - `task leases` prints the lane header `devices (capacity 1`.

  Covers AS-12 and AS-14.

## Slice E: docs (independent; can start after T01 fixes the names)

- [x] T12 [P] `README.md`:
  - Add the config example lines.
  - Add a "Device lane" subsection under Resource leases with the plan §8
    contents.
  - Extend the `task lease` usage line with `[--expect <minutes>]`.
  - Mention `test/lane.test.ts` under Testing.
- [x] T13 [P] `skills/foreman/SKILL.md`: reading the lane statuses,
  `task leases` lanes, raising capacity on a bigger machine (edit
  config.toml, then restart only with no device-project step running), and
  `--expect` in worker guidance.

## Slice F: verify and go live

- [x] T14 Run `bunx tsc --noEmit`, `bun test` and `sh test/smoke.sh`. All must
  pass.
- [x] T15 (optional, only if under ~20 lines) `test/smoke.sh`:
  - Give the `smoke` project `resources = ["dev-a", "dev-b"]` and
    `resource_groups = { lane = { members = ["dev-a","dev-b"], capacity = 1 } }`.
  - Assert that `task leases` prints `lane (capacity 1`.
  - If the fake-claude stub cannot take leases cheaply, skip this task and say
    so in the summary.
- [x] T16 Live config (outside the repo, authorised by the brief), following
  plan §8:
  1. Back up to `~/.foreman/config.toml.bak-t0048`.
  2. Edit `[projects.tackle-tally]`: `concurrency = 3` (with the comment that
     it needs T0048 code), the `resource_groups` devices group with capacity
     1, and `device_steps = ["implement", "test"]`.
  3. Validate with the `Bun.TOML.parse` one-liner.
  4. Do not restart taskd.
- [ ] T17 (deferred to after the merge; goes in the implement summary and the
  handoff) Post-merge restart, run by the user's assistant:
  1. Run `task ls --all` and confirm that no tackle-tally step is running.
  2. Run `foreman service restart`, then `foreman service status`.
  3. Run `task ls --all`, `task show` on an old task, and `task leases`. All
     must load, and `task leases` shows `tackle-tally local devices
     (capacity 1, ...)`.
  4. Watch the next tackle-tally implement/test: at most one holds the lane,
     and device-free steps launch alongside it.
