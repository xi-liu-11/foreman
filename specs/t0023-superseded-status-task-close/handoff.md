# Handoff: superseded status

## Summary
A task whose work was finished by another task can now be closed honestly as `superseded`, with a pointer to the task that carried it on, instead of being cancelled. Recovering a failed task on the same branch can do this in one step with `task create ... --continues <id>`.

**After the merge, the assistant runs `foreman service restart`, then `task close T0015 --superseded-by T0019`.** The order matters: taskd must be restarted first to pick up the new command and add the database column. This task ran neither command.

## To verify
Needs the restart above first.

1. Run `task close T0015 --superseded-by T0019`. It prints `closed T0015 as superseded by T0019`.
2. Run `task ls --all`. T0015 shows `superseded→T0019`. Run `task ls` and `task inbox`. T0015 is in neither.
3. Run `task show T0015`. It prints `superseded by: T0019` directly under the status line, and the events include "superseded by T0019". `task show T0019` has the event "continues T0015".
4. Run `foreman dashboard`. The header counts failed and superseded separately, and T0015 is under Recent with the pointer, not under Needs you.
5. Run `task close T0015 --superseded-by T0019` again. It is refused, because T0015 is already superseded.

## Changes
- `src/db.ts`: `superseded` status, `CLOSED_STATUSES`, and an additive `tasks.superseded_by` column.
- `src/leases.ts`: the lease sweep treats every closed status as finished.
- `src/taskd.ts`: new `POST /tasks/:id/close`; `continues` on `POST /tasks`, closed in the same transaction as the insert; cancel and supersede share `stopTask`; cancel refuses superseded tasks; the tick, `settle`, `handleResult` and the `blocks` route no longer revive a closed task; `Continued as <id>` ticket comment when the tickets differ.
- `src/cli.ts`: `task close`, `--continues`, help text, and the `superseded→<id>` label in `ls` and `watch`. `task show` prints the pointer. The status column widens only when a superseded row is shown.
- `src/dashboard.html`: separate failed and superseded counts, and the pointer in Recent.
- `README.md`, `skills/foreman/SKILL.md`: usage and recovery guidance; roadmap item 12 struck through.
- `test/superseded.test.ts`: 43 tests covering the spec's scenarios, plus the migration. `bun test` is 77 pass and `bunx tsc --noEmit` is clean.

## Risk
Low to medium. The migration only adds a column, and nothing in the pipelines changed. The main risk is a closed task being revived, which the tests cover. There is no undo: a typo in `--superseded-by` that names a real task is accepted, and only a manual database edit reverses it. If the continued task changes status while create is setting up the worktree, create fails and leaves the worktree behind; the error names it.

## Follow-ups
None.
