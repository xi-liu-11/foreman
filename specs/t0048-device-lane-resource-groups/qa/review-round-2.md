# T0048 review, round 2

Scope: `git diff main...HEAD` against `spec.md`, `plan.md`, the round-1 findings (`review-round-1.md`) and the T0045/T0047 conventions. This round looked mainly at fix commit `ab00eed`, then reread the whole lane, dispatch and lease diff.

**Verdict: pass.** R1 and R2 are fixed and tested. No new defects were found.

## Checks run

- `bunx tsc --noEmit`: clean (exit 0).
- `bun test`: 142 pass, 0 fail, 779 expect() calls. Round 1 had 136; the new tests are the R1 taskd test and the R2 CLI test. The `advance … no longer in config.toml` log lines come from existing fixtures and are not failures.
- `test/smoke.sh` was not rerun this round. It needs port 7778 to itself, and round 1 saw another session using it. Test round 1 later ran smoke on a clean environment (`qa/test-round-1/smoke-run5..7-cleanenv.txt`).

## Round-1 findings

### R1: stale `queued: device lane` for stopped tasks, and stale reasons under a concurrency hold. Fixed.
- `src/taskd.ts:618` (`laneOf`) now returns `null` unless the task is `queued`, `running` or `blocked`. A cancelled, failed, superseded or done task therefore shows its real status in `task ls`, even if its queued step row and a `deferred` entry are still there.
- `src/taskd.ts:384`: when the global or project concurrency check stops `tryLaunch`, it now deletes the step's `deferred` entry. A step held only by concurrency no longer says "device lane". Merging the two checks into one `if` keeps the original behaviour, because both checks just returned.
- `src/taskd.ts:135`: `tick` removes `deferred` entries whose step is no longer `queued`, so the map stays bounded.
- Test: `test/lane-taskd.test.ts` "R1: …" covers three cases:
  - A cancelled task with a stale entry has `lane` = null, and `task ls --all` prints `cancelled`.
  - A deferred step whose blocker becomes concurrency (project concurrency is dropped to 2) loses its lane state.
  - That step stays `queued`.

### R2: `task leases` lane scoping. Fixed.
- `src/cli.ts:289` now passes the table's own query to `/lanes`: `--project`, else `task=<FOREMAN_TASK>`, else no filter.
- `src/taskd.ts:913`: `/lanes` resolves `task=` to the task's project, the same way `/leases` does on line 909. An unknown task id falls back to every project, as `/leases` does.
- Test: `test/lane-cli.test.ts` "task leases scopes lanes like the table" checks the three query strings and that the unscoped run prints both projects' lane blocks.

## Re-read of the rest of the diff (no change required)

- `src/lane.ts`:
  - `orderWaiters` is still total and does not mutate its input.
  - `dispatchVerdict` rules 1 to 5 match plan §2. Device-free steps always launch (rule 1).
  - The `device_steps_running` cap comes before any lane logic.
- `src/leases.ts` `dispatchView`:
  - A lane counts as busy only when distinct granted steps on one machine reach capacity and at least one row is waiting.
  - Queued candidates come from `queuedLiveSteps`, so stopped tasks cannot hold a device step back through rule 4.
- `/steps/:id/lease`: `expect_min` is checked (finite, > 0, ≤ 1440, not a boolean) and rounded up. A request without it is handled as before. The `lease_sec` and heartbeat paths are untouched.
- The `releaseStepLeases` and `releaseLease` call sites all pass `groupsOf`, so a release grants the next waiter by group policy.
- Round-1 notes N1 (ETA for a waiter that already holds a slot) and N2 (wording for ungrouped resources) are still open. They are cosmetic, and with capacity 1 they cannot happen on tackle-tally. They are not blocking.

## Handoff reminder (from round-1 N3, still relevant)

`~/.foreman/config.toml` already has tackle-tally at `concurrency = 3`, but the running taskd is pre-T0048 code. Restart taskd only after this branch merges, and only when `task ls --all` shows no tackle-tally step running. If taskd has to restart before the merge, restore `~/.foreman/config.toml.bak-t0048` first. Otherwise three workers would share the devices through plain FIFO leases, which is the swap scenario this task exists to prevent.
