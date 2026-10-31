# Review round 1: superseded status

Reviewed `git diff main...HEAD` (base `a553a25`, head `0972d99`) against `spec.md`, `plan.md` and the task brief. The repo has no constitution or CLAUDE.md, so conventions were judged from the surrounding code.

**Verdict: pass.** No blocking findings. The developer does not need to change anything.

Checks run on this branch:

- `bunx tsc --noEmit`: clean.
- `bun test`: 77 pass, 0 fail. `test/superseded.test.ts` alone: 43 pass.
- `FOREMAN_CLI_NAME=task bun src/cli.ts --help`: documents `close` and `--continues`.
- The dashboard was reviewed by reading the code only; it was not rendered in this review. It has no automated test.

## Blocking findings

None.

## Non-blocking findings

These do not need action for this task.

### 1. `--continues` followed by another flag makes a request

- **File:** `src/cli.ts:105`
- **Failure scenario:** `task create ... --continues --branch b` passes the check, because `opt("continues")` returns the next argument, `--branch`. The CLI posts `continues: "--branch"`, and taskd answers `no such task '--branch'`. The command exits 1 and nothing is created, so the only gap is the "makes no request" wording of scenario 15. `task close <id> --superseded-by --foo` behaves the same way.
- **Required change:** None. `opt` treats every flag this way, and the outcome is a safe refusal.

### 2. Test fixtures log scheduler errors

- **File:** `test/superseded.test.ts:47`
- **Failure scenario:** Fixtures seeded with `pipeline: "[]"` and an active status get picked up by the ticks the tests trigger. `bun test` then prints lines like `advance S45 failed: undefined is not an object (evaluating 'ps.type')`. No test fails and only the temp DB is touched, but the noise could hide a real scheduler error when someone reads the output.
- **Required change:** None for this task.

## Areas checked with no defect

| Area | Result |
| --- | --- |
| Status and migration | `superseded` is in `TaskStatus` and `CLOSED_STATUSES`. The column is added with `ALTER TABLE`, the same way as `pr_url`. |
| Revival paths | The tick re-reads each task before advancing it. `settle` and `handleResult` use `isStopped`. `failTask` and `runSystem` run only on tasks in `running` or `queued`, which close refuses. Parallel children cannot race a close, because `createStep` has already moved the task out of a closable status. |
| Running workers | `isLive` (`src/taskd.ts:44`) treats a superseded task as not live, so heartbeats return `cancel: true` even after a taskd restart empties `cancelRequested`. |
| Leases | `stopTask` releases them, and `reconcileLeases` sweeps closed statuses. |
| Refusals | Close has no `await` between its checks and its transaction. The cycle walk is bounded by `seen`. Cancel and retry both refuse superseded tasks. |
| `--continues` | The check runs before an id or worktree is allocated, and again inside the insert transaction. A failure leaves the old task unchanged. Plan and handoff both record the leftover worktree on a mid-create race as an accepted risk. |
| Tickets | The `note` stage never transitions a ticket. No failure comment is posted. A shared ticket gets no comment. Errors become `ticket.error`, including a project that has left the config. |
| Display | `ls` and `watch` widen the column only for a superseded row. `show` prints the pointer under the status line. The dashboard's `active` and `needs` lists both exclude superseded, and its header counts it separately. |
| Inbox | It reads open blocks and `status=gate`, and neither can include a superseded task. |
| Events | `task show` prints event data as JSON, so the "superseded by" and "continues" messages appear within its 110-character limit. |
| Docs and handoff | README, help and SKILL.md are updated. Roadmap item 12 is struck through. The handoff gives the restart-then-close order and neither command was run. `src/pipelines.ts` is untouched. |
