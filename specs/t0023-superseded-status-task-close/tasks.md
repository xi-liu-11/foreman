# Tasks: superseded status

See `plan.md` for the code and verification commands, and `spec.md` for the numbered
scenarios. Tick each task `- [x]` as you finish it.

- [x] T1 `bun install --frozen-lockfile`; confirm `bun test` is 34 pass and `bunx tsc --noEmit` is clean.
- [x] T2 `src/db.ts`: add the `superseded` status, `CLOSED_STATUSES`, `TaskRow.superseded_by`, the additive migration, the `insertTask` Omit, and the `listTasks` filter. (depends on T1)
- [x] T3 `src/leases.ts`: use `CLOSED_STATUSES` in the `reconcileLeases` sweep. (depends on T2)
- [x] T4 `src/taskd.ts`: `export const cfg`; add `isStopped`, `stopTask`, `cannotSupersede`, `markSuperseded`, `noteContinued`; move the cancel route onto `stopTask` and refuse superseded tasks. (depends on T2)
- [x] T5 `src/taskd.ts`: add the `close` action with its refusals, including the cycle walk. (depends on T4)
- [x] T6 `src/taskd.ts`: add `continues` to `POST /tasks`, validated before `nextTaskId`, closed in the insert transaction, re-checked inside it. (depends on T4)
- [x] T7 `src/taskd.ts`: stop resurrection: re-read in the `tick` loop, plus the `settle`, `handleResult` and `blocks` action edits. (depends on T4)
- [x] T8 `bunx tsc --noEmit` and `bun test` green. Commit "Superseded status: store, close route, create --continues". (depends on T3, T5, T6, T7)
- [x] T9 [P] `src/cli.ts`: `close` command, `--continues`, help text, `statusText`, computed width in `ls` and `watch`, the `task show` line. (depends on T8)
- [x] T10 [P] `src/dashboard.html`: badge style, pointer in Recent, separate failed and superseded counts in the header. (depends on T8)
- [x] T11 [P] `README.md`: Use block, `### Superseded tasks` section, Tickets sentence, leases bullet, strike through roadmap item 12. (depends on T8)
- [x] T12 [P] `skills/foreman/SKILL.md`: commands block and the Failures guidance. (depends on T8)
- [x] T13 `bunx tsc --noEmit`; check the help output; check the dashboard against an isolated taskd, never the live one. Commit "Superseded status: CLI, dashboard, docs". (depends on T9, T10, T11, T12)
- [x] T14 Create `test/superseded.test.ts` with the setup in `plan.md` file 8 and route tests for scenarios 1 to 8 and 10, plus the migration test. (depends on T13)
- [x] T15 In `test/superseded.test.ts`, add `--continues` route tests for scenarios 11 to 14, using a temp git repo, temp `cfg.defaults.worktrees` and temp `CLAUDE_CONFIG_DIR`. (depends on T14)
- [x] T16 In `test/superseded.test.ts`, add ticket tests for scenarios 19 and 20 with `globalThis.fetch` stubbed and restored. (depends on T14)
- [x] T17 In `test/superseded.test.ts`, add CLI tests for scenarios 9, 15, 16, 17, 18 and 21, overriding `FOREMAN_URL`, `FOREMAN_TOKEN`, `FOREMAN_CLI_NAME` and `FOREMAN_HOME`. (depends on T14)
- [x] T18 `bun test` and `bunx tsc --noEmit` green; run the Verification table in `plan.md` and record the results with `task note`. Commit "Superseded status: tests". (depends on T15, T16, T17)
- [x] T19 Write `specs/t0023-superseded-status-task-close/handoff.md` per `plan.md` file 9, with the post-merge instruction to run `foreman service restart` and then `task close T0015 --superseded-by T0019`. Repeat the instruction in the step summary. Do not run either command. Commit "Superseded status: handoff". (depends on T18)
