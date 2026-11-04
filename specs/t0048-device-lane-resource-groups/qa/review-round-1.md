# T0048 review, round 1

Scope: `git diff main...HEAD` against `spec.md`, `plan.md` and the T0045/T0047 conventions.

**Verdict: fail.** Two small required changes (R1, R2). The rest of the work is sound and does not need to be redone.

## What was checked

- `bunx tsc --noEmit`: clean.
- `bun test`: 136 pass, 0 fail. There are `advance S59/S60/S64 failed` log lines in the output, but the tests still pass. I did not trace them; they do not mention lane or lease code.
- `sh test/smoke.sh`: inconclusive. I ran it three times and got three different failures. Run 1 failed with `Failed to start server. Is port 7778 in use?` at the outage restart. Runs 2 and 3 hit `ECONNREFUSED` and then `T0003 expected done, got blocked`. Meanwhile `lsof` showed another short-lived `bun` process listening on 7778, so another session was running a smoke test on the same port at the same time. The new `device lane` check ("task leases shows the lane") passed in all three runs, and so did every scenario that finished before the collision. Rerun smoke on a quiet machine before merging.
- Pure policies (`src/lane.ts`):
  - `orderWaiters` ranks by head waiter, is total and does not mutate its input.
  - `laneEta`, and `dispatchVerdict` rules 1 to 5, match plan §2.
  - The tests cover AS-5, AS-6, AS-8, AS-9 and AS-10, the hold reasons and `parseLane` AS-15.
- Group grants (`src/leases.ts`):
  - `plannedGrants` grants greedily, enforces key exclusivity, and gives a step that already holds a slot no extra slot (AS-1 to AS-4 are tested).
  - Ungrouped resources keep today's behaviour: the existing `test/leases.test.ts` cases are unchanged (the diff only adds lines).
  - `expect_min` is stored and updated on re-request, and overdue uses `expect_min ?? lease_max_minutes` (AS-11).
- Migration: additive `ALTER TABLE` after a `PRAGMA table_info` check, and old rows load with `expect_min = null` (AS-13 is tested).
- CLI compatibility (AS-12):
  - `--wait`, `--reason` and exit codes 0, 3 and 1 are unchanged.
  - A bad, missing or ≤ 0 `--expect` calls `die()` before any request.
  - `task leases --json` still returns the `/leases` array.
- The `tryLaunch` checks run after the existing concurrency checks. `lease_sec` and heartbeat are untouched, and no pipeline step names changed.
- Docs: the README "Device lane" subsection, the README config example and SKILL.md item 8 cover groups, `device_steps`, `device_steps_running` and `--expect`.
- Live config: `~/.foreman/config.toml.bak-t0048` exists. `[projects.tackle-tally]` has `concurrency = 3`, the `devices` group with capacity 1, and `device_steps = ["implement","test"]`. taskd was not restarted.

## Required changes

### R1. A cancelled or failed task shows `queued: device lane` in `task ls`

- **File:** `src/taskd.ts:617` (`laneOf`), with `src/taskd.ts:383`/`396` (`deferred` upkeep) and `src/cli.ts:38` (`statusText`).
- **Failure scenario:**
  1. tackle-tally's lane is busy, so `tryLaunch` holds a queued `implement` step of T1 and records `deferred.set(step.id, "device_limit")`.
  2. The user runs `task cancel T1`. `stopTask` touches only running steps, so the queued step row stays `status = 'queued'` and the `deferred` entry stays in the map.
  3. `GET /tasks` calls `laneOf(T1)`. It finds a queued step that is in `deferred` and returns `{ state: "deferred" }`.
  4. `statusText` checks `t.lane` before `t.status`, so `task ls --all` prints `queued: device lane` for a cancelled task. The same thing happens when `failTask` ends a task (it also touches only running steps).
  5. The wrong status lasts until taskd restarts.

  The foreman skill reads this column to tell the user what is happening, so it would report a dead task as waiting for the device.
- **A second form of the same bug:**
  1. A step is deferred (`lane_busy`).
  2. Later the lane frees up, but project `concurrency` is full, so `tryLaunch` returns at line 383, before the verdict.
  3. The old reason is never cleared, so `task ls` says `queued: device lane` when the real blocker is concurrency.
- **Required change:**
  - In `laneOf`, return `null` unless `t.status` is one of `queued`, `running`, `blocked`. Optionally, also make `statusText` show the lane text only for live statuses, the way the `rejection` branch already does.
  - Delete the step's `deferred` entry when `tryLaunch` returns early on a concurrency check, so a stale reason is never shown.
  - Optionally, prune `deferred` entries whose step is no longer `queued`, for example in `tick`, so the map does not grow without bound.
  - Add a test: a stopped task with a stale deferred entry renders its real status.

### R2. `task leases` without `--project` shows only the first row's project's lanes

- **File:** `src/cli.ts:289`
- **Failure scenario:**
  1. Two projects both have resource groups. Say a second Mac project gets `resource_groups` too, which SKILL.md item 8 now invites.
  2. Both have lease rows, and `task leases` runs with no `--project` and no `FOREMAN_TASK`.
  3. `lp = rows[0]?.project` scopes `/lanes` to whichever project's row sorts first, so the other project's lane block is silently left out. The per-row table below it still lists both projects.
  4. When there are no rows at all, every lane is shown. So the output depends on which rows happen to exist.

  Spec §6 says `task leases` "prints each group".
- **Required change:**
  - Scope `/lanes` only when the user gives `--project`.
  - With `FOREMAN_TASK` set and no `--project`, scope `/lanes` to the task's project, as `/leases?task=` already does. Either pass `task=` through to `/lanes`, or resolve the task's project in the route.
  - Otherwise fetch every lane.
  - Extend `test/lane-cli.test.ts` with a two-project stub.

## Non-blocking notes (no change needed for this round)

- **N1. ETA for a waiter that already holds a slot** (`src/leases.ts:81`). `laneEta` treats every waiter as waiting for a slot. With capacity ≥ 2, take a step that holds ios-sim and waits for android-emu, which another step holds. Its ETA is computed from the slot queue, not from the key holder's remaining time. The same happens for a waiter blocked only by key exclusivity while a slot is free (AS-3, C waiting on ios-sim after B releases): it shows `eta ~0m`. This is cosmetic, and with capacity 1 (tackle-tally) it cannot happen.
- **N2. Non-device locks show as `waiting for devices`.** `laneOf` reports a waiting row of any resource, including an ungrouped `browser` lease. That is acceptable wording, but it would read better as `waiting for <resource>` when `group` is null.
- **N3. Live-config window.** `~/.foreman/config.toml` already sets tackle-tally to `concurrency = 3`, but the running taskd is pre-T0048 code. Any restart before this merges would give three workers on plain FIFO leases: the swap scenario. The config comment and the plan's risk section cover this. The handoff must repeat it: restart taskd only after the merge, and only with no tackle-tally step running. Otherwise restore `config.toml.bak-t0048` first.
- **N4. Integration coverage.** `tryLaunch` itself is untested: its wiring and the `step.deferred` event are covered only through the pure `dispatchVerdict` and the store-backed `dispatchView`. This is acceptable for this round, and the R1 test is a natural place to add an integration case.
